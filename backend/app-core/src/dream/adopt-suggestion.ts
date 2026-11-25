import {createModuleLogger, sha256HexSync} from '@nestos/common';
import {journalCommand, type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanService} from '@nestos/kanban/contracts';
import {sameAuthority, type SourcePort} from '@nestos/dream';
import type {DreamConfigStore} from './config-store';
import type {DreamEvidenceStore} from './evidence-store';
import {readAuthorizedDreamRun} from './evidence-access';

export interface DreamAdoptionRequest {
    ownerProjectId: string; dreamId: string; runId: string; suggestionId: string; operationId: string;
    boardId: string; targetProjectId: string; parentItemId: string; title: string; responsibility: string; acceptance: string;
}
interface Dependencies {
    configs: DreamConfigStore; evidence: DreamEvidenceStore; journal: KanbanAutomationJournal;
    kanban: Pick<KanbanService, 'read' | 'execute' | 'item'>; source: Pick<SourcePort<unknown>, 'authorize'>;
    authorizeOwner(projectId: string): Promise<void>; authorizeTarget(boardId: string, projectId: string): Promise<void>;
}
const log = createModuleLogger('dream-adoption');
export function validateDreamAdoptionRequest(request: DreamAdoptionRequest): void {
    if (!request || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.operationId)
        || typeof request.parentItemId !== 'string' || !request.parentItemId.trim() || request.parentItemId.length > 256
        || [request.title, request.responsibility, request.acceptance].some(value => typeof value !== 'string' || !value.trim() || value.length > 16000))
        throw new Error('DREAM_ADOPTION_INVALID');
}

/** Explicit acceptance creates a manually controlled task; execution remains in Kanban. */
export async function adoptDreamSuggestion(request: DreamAdoptionRequest, deps: Dependencies): Promise<{itemId: string}> {
    request = structuredClone(request);
    const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.operationId) ? request.operationId : 'invalid';
    let stage = 'authorization';
    try {
        validateDreamAdoptionRequest(request);
        await deps.authorizeOwner(request.ownerProjectId); await deps.authorizeTarget(request.boardId, request.targetProjectId);
        const config = await deps.configs.read(request.ownerProjectId, request.dreamId);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const selected = config.config.files.map(file => ({id: file.id, projectId: file.projectId, connectionId: file.connectionId, cursor: null}));
        const view = await readAuthorizedDreamRun(deps.evidence, request.ownerProjectId, request.dreamId, request.runId, selected, deps.source);
        const suggestion = view?.findings.find(item => item.id === request.suggestionId && item.kind === 'suggestion' && item.state === 'active');
        if (!suggestion) throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
        const source = selected.find(item => item.id === suggestion.sourceId);
        const proof = view?.sources.find(item => item.status === 'available' && item.evidence.sourceId === suggestion.sourceId);
        if (!source || !proof || proof.status !== 'available') throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
        await deps.evidence.checkConfig(request.ownerProjectId, request.dreamId, config.revision);
        const board = await deps.kanban.read(request.boardId);
        const parent = await deps.kanban.item(request.boardId, request.parentItemId);
        const targetRef = parent.item.externalRefs?.find(ref => ref.system === 'nestos-remote-project' && ref.id === request.targetProjectId);
        if (board.scope.kind === 'project' ? board.scope.projectId !== request.targetProjectId : !targetRef) throw new Error('DREAM_TARGET_SCOPE_CHANGED');
        stage = 'admit';
        const itemId = 'dream-' + sha256HexSync(JSON.stringify([request.ownerProjectId, request.dreamId, request.operationId]));
        const reference = {system: 'nestos-dream', id: JSON.stringify([request.ownerProjectId, request.dreamId, request.runId, suggestion.id])};
        const fingerprint = sha256HexSync(JSON.stringify([request, config.revision, suggestion.revision]));
        await deps.journal.update<{fingerprint: string}>(`dream-adoption:${request.operationId}`, previous => {
            if (previous && previous.fingerprint !== fingerprint) throw new Error('DREAM_OPERATION_CONFLICT');
            return previous ?? {fingerprint};
        });
        await deps.authorizeOwner(request.ownerProjectId); await deps.authorizeTarget(request.boardId, request.targetProjectId);
        await deps.evidence.checkConfig(request.ownerProjectId, request.dreamId, config.revision);
        if (!sameAuthority(proof.evidence.authority, await deps.source.authorize(source))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        await journalCommand(deps.journal, deps.kanban, request.boardId, `dream-adoption-command:${request.operationId}`,
            {type: 'create-item', stage: 'backlog', launch: {mode: 'manual', paused: true},
                planning: {parentId: request.parentItemId, kind: board.defaultWorkType ?? 'task', priority: 2, dependencies: [], references: []},
                item: {id: itemId, taskType: 'execution',
                title: request.title, responsibility: request.responsibility, acceptance: request.acceptance,
                externalRefs: [reference, ...(targetRef ? [targetRef] : [])]}});
        stage = 'verify';
        const actual = await deps.kanban.item(request.boardId, itemId);
        if (!actual.item.externalRefs?.some(ref => ref.system === reference.system && ref.id === reference.id)) throw new Error('DREAM_ADOPTION_RECEIPT_MISMATCH');
        log.info('dream.adopt', {operationId, stage, result: 'success', durationMs: Date.now() - started}); return {itemId};
    } catch (error) {
        const causeCode = (error as {code?: unknown})?.code;
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message
            : typeof causeCode === 'string' && /^[A-Z][A-Z_0-9]{1,63}$/.test(causeCode) ? 'DREAM_KANBAN_' + causeCode : 'DREAM_ADOPTION_FAILED';
        log.warn('dream.adopt', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
    }
}
