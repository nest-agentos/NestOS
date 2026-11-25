import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {KanbanArtifactRef} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DreamSource, SourceAuthority, SourcePort} from '@nestos/dream';
import type {DreamConfig} from './config-store';
import type {DreamAdoptionRequest} from './adopt-suggestion';
import type {DreamProjectFilePort} from './project-file-source';

type Execution = {dispatchId: string; sessionId: string; outputs: KanbanArtifactRef[]};
const log = createModuleLogger('dream-adoption-source');
const MAX_BYTES = 32768, MAX_OUTPUTS = 10;
export function adoptionScannerIds(owner: string, dream: string, sourceId: string) {
    const digest = sha256HexSync(JSON.stringify([owner, dream, sourceId]));
    return {planId: 'adoption-plan-' + digest, twinSourceId: 'adoption-source-' + digest};
}

/** Adapt an authorized adoption to the Twin scanner's version and target contract. */
export function adoptionTwinScanPort(sourceId: string, port: SourcePort<string>): DreamProjectFilePort {
    return {
        target: source => {if (source.id !== sourceId) throw new Error('DREAM_SOURCE_BINDING_CHANGED'); return sourceId;},
        authorize: source => port.authorize(source),
        read: async (source, limit) => {
            const result = await port.read(source, limit);
            if (result.items.length > 1) throw new Error('DREAM_SOURCE_LIMIT');
            return {...result, version: JSON.stringify([result.version, result.items.length ? sha256HexSync(result.items[0]) : ''])};
        },
    };
}

/** Resolve a selected source within the owning Dream and verify its recorded adoption. */
export function configuredAdoptionSource(config: DreamConfig, owner: string, dream: string, sourceId: string,
    request: DreamAdoptionRequest, authorize: () => Promise<SourceAuthority>,
    current: () => Promise<{itemId: string; execution?: Execution} | undefined>,
    journal: Pick<KanbanAutomationJournal, 'verify' | 'get'>): SourcePort<string> {
    const selected = config.enabled && config.adoptions?.find(item => item.id === sourceId);
    if (!selected || request.ownerProjectId !== owner || request.dreamId !== dream || request.boardId !== selected.boardId)
        throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
    const check = async () => {
        const status = await current();
        if (!status || status.itemId !== selected.itemId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        return status.execution;
    };
    return adoptionSourcePort({id: sourceId, projectId: request.targetProjectId, connectionId: 'kanban-adoption'},
        request.operationId, async () => {await check(); return authorize();}, check, journal);
}

/** Bind the selected adoption to the standard source scanning contract. */
export function adoptionSourcePort(selected: Omit<DreamSource, 'cursor'>, operationId: string,
    authorize: () => Promise<SourceAuthority>, current: () => Promise<Execution | undefined>,
    journal: Pick<KanbanAutomationJournal, 'verify' | 'get'>): SourcePort<string> {
    const validate = (source: DreamSource) => {
        if (source.id !== selected.id || source.projectId !== selected.projectId || source.connectionId !== selected.connectionId)
            throw new Error('DREAM_SOURCE_BINDING_CHANGED');
    };
    return {
        authorize: async source => {validate(source); return authorize();},
        read: async (source, limit) => {
            validate(source);
            if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('DREAM_SOURCE_LIMIT');
            const result = await readAdoptionSource(operationId, source.cursor, 1, current, journal);
            if (limit < result.scanned) throw new Error('DREAM_SOURCE_LIMIT');
            return result;
        },
    };
}

/** Reads only the journal-owned outputs of a currently authorized accepted dispatch. */
export async function readAdoptionSource(operationId: string, cursor: string | null, limit: number,
    current: () => Promise<Execution | undefined>, journal: Pick<KanbanAutomationJournal, 'verify' | 'get'>) {
    const started = Date.now(), safeId = /^[a-zA-Z0-9_-]{1,128}$/.test(operationId) ? operationId : 'invalid'; let stage = 'authorize';
    try {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTPUTS) throw new Error('DREAM_SOURCE_LIMIT');
        const execution = await current();
        if (!execution) throw new Error('DREAM_EXECUTION_UNVERIFIED');
        const outputs = execution.outputs;
        if (outputs.length > limit || outputs.length > MAX_OUTPUTS || outputs.some(item => item.bytes > MAX_BYTES)
            || outputs.reduce((sum, item) => sum + item.bytes, 0) > MAX_BYTES) throw new Error('DREAM_SOURCE_LIMIT');
        stage = 'verify';
        if (!await journal.verify(outputs, execution.dispatchId)) throw new Error('DREAM_ARTIFACT_INVALID');
        const version = sha256HexSync(JSON.stringify([execution.dispatchId, execution.sessionId, outputs]));
        const items: string[] = [];
        if (version !== cursor) for (const item of outputs) {
            const value = await journal.get<string>('artifact:' + item.sha256);
            if (typeof value !== 'string' || sha256HexSync(value) !== item.sha256 || new TextEncoder().encode(value).length !== item.bytes)
                throw new Error('DREAM_ARTIFACT_INVALID');
            items.push(value);
        }
        stage = 'revalidate';
        if (JSON.stringify(await current()) !== JSON.stringify(execution)) throw new Error('DREAM_EXECUTION_CHANGED');
        log.info('dream.adoption.source', {operationId: safeId, stage, result: 'success', count: outputs.length, durationMs: Date.now() - started});
        return {items, cursor: version, version, scanned: outputs.length};
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SOURCE_UNAVAILABLE';
        log.warn('dream.adoption.source', {operationId: safeId, stage, result: 'failure', code, durationMs: Date.now() - started});
        throw new Error(code);
    }
}
