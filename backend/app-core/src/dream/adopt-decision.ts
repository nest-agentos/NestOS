import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {DreamDecisionAdoptionRequest, DreamFindingView, DreamSourceEvidence} from '@nestos/app-contracts/services';
import type {KanbanRecordInput, KanbanService} from '@nestos/kanban/contracts';
import {journalCommand, type KanbanAutomationJournal} from '@nestos/kanban/integration';
import {sameAuthority} from '@nestos/dream';
import {PRIMARY_PROJECT_REFERENCE, REMOTE_PROJECT_REFERENCE} from '../kanban/resource-catalog';
import type {DreamEvidenceStore} from './evidence-store';

type Request = DreamDecisionAdoptionRequest;
export interface DreamDecisionEvidence {
    configRevision: number;
    suggestion: DreamFindingView;
    evidence: DreamSourceEvidence;
    origin?: {kind: 'task' | 'decision'; boardId: string; id: string};
}
interface Dependencies {
    kanban: Pick<KanbanService, 'read' | 'execute' | 'record'>;
    journal: KanbanAutomationJournal;
    store: DreamEvidenceStore;
    inspect(request: Request): Promise<DreamDecisionEvidence>;
    prepare?(request: Request, configRevision: number): Promise<void>;
}
const log = createModuleLogger('dream-adoption');
const operationPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const decisionAdoptionReference = 'nestos-dream-adoption';

export async function adoptDreamDecision(request: Request, deps: Dependencies): Promise<{recordId: string}> {
    request = structuredClone(request);
    const started = Date.now(), operationId = operationPattern.test(request?.operationId ?? '') ? request.operationId : 'invalid';
    let stage = 'authorization';
    try {
        validateRequest(request);
        const initial = await deps.inspect(request);
        const record = decisionDraft(request, initial);
        stage = 'reconcile';
        if (!await reconcileDecision(deps, request, record.id)) {
            stage = 'prepare';
            await (deps.prepare ? deps.prepare(request, initial.configRevision) : deps.store.prepareDecisionAdoption(request, initial.configRevision));
            verifyEvidence(initial, await deps.inspect(request));
            stage = 'append-record';
            await journalCommand(deps.journal, deps.kanban, request.boardId, 'dream-decision-command:' + record.id, {type: 'append-record', record});
            stage = 'verify-record';
            await verifyDecision(deps.kanban, request.boardId, record.id);
        }
        stage = 'write-receipt';
        await deps.store.completeDecisionAdoption(request.ownerProjectId, request.dreamId, operationId, record.id);
        log.info('dream.adopt-decision', {operationId, stage, result: 'success', durationMs: Date.now() - started});
        return {recordId: record.id};
    } catch (error) {
        const code = decisionAdoptionError(error, stage);
        log.warn('dream.adopt-decision', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started});
        throw new Error(code);
    }
}

async function reconcileDecision(deps: Dependencies, request: Request, recordId: string): Promise<boolean> {
    const previous = await deps.store.adoptionReceipt(request.ownerProjectId, request.dreamId, request.operationId);
    if (!previous) return false;
    if (previous.kind !== 'decision' || JSON.stringify(previous.request) !== JSON.stringify(request))
        throw new Error('DREAM_OPERATION_CONFLICT');
    try {await verifyDecision(deps.kanban, request.boardId, recordId);}
    catch (error) {
        if (previous.state === 'prepared' && (error as {code?: string} | null)?.code === 'RECORD_NOT_FOUND') return false;
        throw error;
    }
    return true;
}

async function verifyDecision(kanban: Dependencies['kanban'], boardId: string, recordId: string): Promise<void> {
    const actual = await kanban.record(boardId, recordId);
    if (actual.kind !== 'decision' || !actual.externalRefs?.some(ref => ref.system === decisionAdoptionReference && ref.id === recordId))
        throw new Error('DREAM_ADOPTION_RECEIPT_MISMATCH');
}

function validateRequest(request: Request): void {
    if (!request || ![request.ownerProjectId, request.dreamId, request.runId, request.suggestionId, request.operationId]
        .every(id => typeof id === 'string' && operationPattern.test(id))
        || ![request.boardId, request.targetProjectId].every(id => typeof id === 'string' && id.trim() && id.length <= 256)
        || typeof request.title !== 'string' || !request.title.trim() || request.title.length > 8000)
        throw new Error('DREAM_ADOPTION_INVALID');
}

function verifyEvidence(initial: DreamDecisionEvidence, current: DreamDecisionEvidence): void {
    if (initial.configRevision !== current.configRevision) throw new Error('DREAM_CONFIG_CONFLICT');
    if (initial.suggestion.revision !== current.suggestion.revision || initial.suggestion.content !== current.suggestion.content
        || initial.suggestion.sourceId !== current.suggestion.sourceId || initial.evidence.version !== current.evidence.version
        || !sameAuthority(initial.evidence.authority, current.evidence.authority))
        throw new Error('DREAM_AUTHORIZATION_CHANGED');
}

function decisionDraft(request: Request, {suggestion, origin}: DreamDecisionEvidence): KanbanRecordInput {
    const id = 'dream-' + sha256HexSync(JSON.stringify([request.ownerProjectId, request.dreamId, request.operationId]));
    const externalRefs = [
        {system: decisionAdoptionReference, id},
        {system: REMOTE_PROJECT_REFERENCE, id: request.targetProjectId},
        {system: PRIMARY_PROJECT_REFERENCE, id: request.targetProjectId},
    ];
    if (origin) {
        const referenceId = JSON.stringify([origin.boardId, origin.id]);
        if (referenceId.length <= 256) externalRefs.push({system: 'nestos-dream-source-' + origin.kind, id: referenceId});
    }
    return {id, kind: 'decision', title: request.title.trim(), content: suggestion.content,
        rationale: suggestion.quote?.trim() || suggestion.content, itemIds: [], sources: [], externalRefs};
}

function decisionAdoptionError(error: unknown, stage: string): string {
    if (error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message)) return error.message;
    if (stage === 'write-receipt') return 'DREAM_ADOPTION_RECEIPT_UNAVAILABLE';
    const code = (error as {code?: unknown} | null)?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return 'DREAM_KANBAN_' + code;
    return stage === 'append-record' || stage === 'verify-record' ? 'DREAM_ADOPTION_RECEIPT_UNAVAILABLE' : 'DREAM_ADOPTION_FAILED';
}
