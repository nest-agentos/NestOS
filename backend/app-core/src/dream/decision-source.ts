import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {DreamSource, SourceAuthority, SourcePort} from '@nestos/dream';
import type {KanbanService} from '@nestos/kanban/contracts';

export interface DreamDecisionSource {id: string; projectId: string; connectionId: string; boardId: string; recordId: string}
const log = createModuleLogger('dream-decision-source');
const valid = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

/** Point-read one explicitly project-bound decision; never enumerate board records. */
export function decisionSourcePort(selected: DreamDecisionSource, service: Pick<KanbanService, 'record'>,
    authorize: (source: DreamDecisionSource) => Promise<SourceAuthority>): SourcePort<string> {
    const frozen = structuredClone(selected);
    if (!Object.values(frozen).every(valid)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
    const check = (source: DreamSource) => {
        if (source.id !== frozen.id || source.projectId !== frozen.projectId || source.connectionId !== frozen.connectionId)
            throw new Error('DREAM_SOURCE_BINDING_CHANGED');
    };
    return {authorize: async source => {check(source); return authorize(frozen);}, read: async (source, limit) => {
        const started = Date.now();
        try {
            check(source); if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('DREAM_SOURCE_LIMIT');
            const record = await service.record(frozen.boardId, frozen.recordId);
            if (record.id !== frozen.recordId || record.kind !== 'decision' || record.deletedAt || record.status !== 'confirmed'
                || !record.externalRefs?.some(ref => ref.system === 'nestos-remote-project' && ref.id === frozen.projectId))
                throw new Error('DREAM_SOURCE_SCOPE_CHANGED');
            const text = JSON.stringify({title: record.title, status: record.status, revision: record.revision, updatedAt: record.updatedAt});
            if (new TextEncoder().encode(text).length > 32768) throw new Error('DREAM_SOURCE_LIMIT');
            const nativeIdentity = JSON.stringify([frozen.boardId, frozen.recordId, frozen.projectId]);
            const version = JSON.stringify([nativeIdentity, sha256HexSync(text)]);
            const cursor = sha256HexSync(JSON.stringify([record.revision, version]));
            log.info('dream.decision.read', {operationId: frozen.id, stage: 'point-read', result: 'success', count: 1,
                boardMetadata: true, requestedRecords: 1, durationMs: Date.now() - started});
            return {items: cursor === source.cursor ? [] : [text], cursor, version, scanned: 1};
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SOURCE_READ_FAILED';
            log.warn('dream.decision.read', {operationId: frozen.id, stage: 'point-read', result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }};
}
