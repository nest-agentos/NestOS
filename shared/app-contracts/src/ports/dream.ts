import type {TwinScannerExecutor} from '../digital-twin/scanner';
import type {RootCallTarget} from '@nestos/llm-session/contracts';

export interface DreamFileConfiguration {
    id: string; projectId: string; connectionId: string; capability: 'fileRead'; path: string;
    planId: string; planRevision: string; twinSourceId: string;
}
export interface DreamAdoptionSourceConfiguration {id: string; boardId: string; itemId: string}
export interface DreamDecisionSourceConfiguration {id: string; projectId: string; connectionId: string; boardId: string; recordId: string; scannerSourceId: string}
export interface DreamTaskSourceConfiguration {id: string; projectId: string; connectionId: string; boardId: string; itemId: string; scannerSourceId: string}
export interface DreamSessionSourceConfiguration {id: string; projectId: string; connectionId: string; sessionId: string; profileId?: string; maxRounds: number; scannerSourceId: string}
export interface DreamChangeSourceConfiguration {id: string; projectId: string; connectionId: string; directory: string; exclude: string[]; maxEntries: number; scannerSourceId: string; commits?: true; extensions?: string[]}
export interface DreamConfiguration {name: string; enabled: boolean; files: DreamFileConfiguration[]; adoptions?: DreamAdoptionSourceConfiguration[]; decisions?: DreamDecisionSourceConfiguration[]; tasks?: DreamTaskSourceConfiguration[]; sessions?: DreamSessionSourceConfiguration[]; changes?: DreamChangeSourceConfiguration[]; schedule?: import('@nestos/kanban/contracts').KanbanRecurrence; consolidation?: {target: import('@nestos/llm-flow/contracts').TargetRef; focus?: string; hotLoadTokens?: number; crossProject?: boolean}}
export interface DreamConfigurationRecord {revision: number; config: DreamConfiguration}
export interface DreamFileSelection {
    projectId: string; connectionId: string; path: string; executor: TwinScannerExecutor;
    maxOutputTokens: number; runTokenLimit: number;
}
export interface DreamSourceEvidence {
    sourceId: string; projectId: string; connectionId: string;
    authority: {principalId: string; revision: string; projectRevision: string; serverId: string; serverProjectId: string};
    startCursor: string | null; endCursor: string | null; version: string; scanned: number;
}
export interface DreamFindingView {
    id: string; sourceId: string; kind: 'fact' | 'inference' | 'suggestion'; content: string;
    quote?: string; subject?: string; project?: string; eventTime?: string; recordedAt?: number;
    revision: number; state: 'active' | 'disputed' | 'disabled'; origin: 'source' | 'user-correction'; updatedAt?: number;
}
export interface DreamProposalView {
    id: string; scope: string; targetId: string; revision: number; status: 'ready' | 'conflict' | 'committed' | 'rejected';
    requiredScopes: string[]; affectedMemoryIds: string[]; constraint?: {scope: string; key: string};
    changes: Array<{id: string; content: string | null; kind?: 'constraint' | 'topic'; priority?: number; title?: string | null}>; evidenceIds: string[];
    resolution?: {action: 'choose'; evidenceId: string} | {action: 'rewrite'} | {action: 'reject'};
}
export interface DreamMemoryTopic {id: string; content: string; kind?: 'constraint' | 'topic'; priority?: number; updatedAt?: number; title?: string}
export type DreamReview = {action: 'correct'; content: string; kind: 'fact' | 'inference'} | {action: 'dispute' | 'disable' | 'restore'};
export interface DreamAdoptionRequest {
    ownerProjectId: string; dreamId: string; runId: string; suggestionId: string; operationId: string;
    boardId: string; targetProjectId: string; parentItemId: string; title: string; responsibility: string; acceptance: string;
}
export type DreamDecisionAdoptionRequest = Omit<DreamAdoptionRequest, 'parentItemId' | 'responsibility' | 'acceptance'>;
export type DreamAdoptionRecord = {configRevision: number; state: 'prepared' | 'committed'} & (
    {kind?: 'task'; request: DreamAdoptionRequest; itemId?: string}
    | {kind: 'decision'; request: DreamDecisionAdoptionRequest; recordId?: string});
export interface DreamRunView {
    operationId: string;
    sources: Array<{status: 'available'; evidence: DreamSourceEvidence}
        | {status: 'unavailable'; sourceId: string; code: 'SOURCE_NOT_SELECTED' | 'AUTHORIZATION_FAILED' | 'AUTHORIZATION_CHANGED'}
        | {status: 'failed'; sourceId: string; code: 'AUTHORIZATION_FAILED' | 'READ_FAILED' | 'AUTHORIZATION_CHANGED' | 'INVALID_BATCH'}
        | {status: 'skipped'; sourceId: string; code: 'BUDGET_EXHAUSTED'}>;
    findings: DreamFindingView[];
    execution?: {scanRunId: string; sessionId: string; taskId: string; additionalTasks?: Array<{sessionId: string; taskId: string}>};
}
export interface DreamService {
    list(owner: string): Promise<{items: Array<{id: string; name: string; enabled: boolean; revision: number}>; scanned: number; truncated: boolean}>;
    create(owner: string, dream: string, operationId: string, name: string): Promise<DreamConfigurationRecord>;
    readConfig(owner: string, dream: string): Promise<DreamConfigurationRecord | null>;
    readRun(owner: string, dream: string, operationId: string): Promise<DreamRunView | null>;
    history(owner: string, dream: string, before?: number): Promise<{items: Array<{operationId: string; startedAt: number; state: 'prepared' | 'failed' | 'settled'; sourceId?: string; code?: string; settledAt?: number}>; scanned: number; nextCursor?: number}>;
    scannerTargets(owner: string, dream: string): Promise<RootCallTarget[]>;
    openView(owner: string, dream: string): Promise<{config: DreamConfigurationRecord;
        history: Awaited<ReturnType<DreamService['history']>>; targets: RootCallTarget[]; models: Array<{id: string; name: string}>;
        scheduleStatus: {state: 'paused' | 'stopping' | 'error' | 'scheduled' | 'pending'; nextAt: number; code?: string;
            last?: {scheduledAt: number; status: 'succeeded' | 'failed' | 'cancelled'; code?: string; failures?: Array<{sourceId: string; code: string}>}} | null} | null>;
    setModelConnection(owner: string, dream: string, connectionId: string): Promise<void>;
    configureAdoptionSources(owner: string, dream: string, operationId: string, expectedRevision: number, adoptions: DreamAdoptionSourceConfiguration[]): Promise<DreamConfigurationRecord>;
    configureDecisionSources(owner: string, dream: string, operationId: string, expectedRevision: number, decisions: DreamDecisionSourceConfiguration[]): Promise<DreamConfigurationRecord>;
    configureTaskSources(owner: string, dream: string, operationId: string, expectedRevision: number, tasks: DreamTaskSourceConfiguration[]): Promise<DreamConfigurationRecord>;
    configureSessionSources(owner: string, dream: string, operationId: string, expectedRevision: number, sessions: DreamSessionSourceConfiguration[]): Promise<DreamConfigurationRecord>;
    configureChangeSources(owner: string, dream: string, operationId: string, expectedRevision: number, changes: DreamChangeSourceConfiguration[]): Promise<DreamConfigurationRecord>;
    configureConsolidation(owner: string, dream: string, operationId: string, expectedRevision: number, consolidation: DreamConfiguration['consolidation'] | null): Promise<DreamConfigurationRecord>;
    pendingConsolidation(owner: string, dream: string, scope: string, after?: string): Promise<{items: DreamProposalView[]; scanned: number; nextCursor?: string}>;
    readProposalEvidence(owner: string, dream: string, proposalId: string, evidenceId: string): Promise<{id: string; sourceId: string; locator: string; fingerprint: string; granularity: string; snapshot: string}>;
    activeConsolidation(owner: string, dream: string): Promise<{version: string; parentVersion: string | null; requiredScopes: string[]; topics: DreamMemoryTopic[]} | null>;
    readDownstream(owner: string, dream: string, kind: 'daily' | 'kanban', commitId: string): Promise<{commitId: string; version: string; requiredScopes: string[]; committedAt?: number; referenceCommits?: string[];
        changes: Array<{id: string; action: 'add' | 'update' | 'retire'; content: string | null; evidenceIds: string[];
            kind?: 'constraint' | 'topic'; priority?: number; title?: string; evidenceRefs?: Array<{proposalId: string; evidenceId: string}>}>} | null>;
    listDownstream(owner: string, dream: string, kind: 'daily' | 'kanban', after?: string): Promise<{items: Array<NonNullable<Awaited<ReturnType<DreamService['readDownstream']>>>>; scanned: number; nextCursor?: string}>;
    readCommittedVersion(owner: string, dream: string, commitId: string): Promise<{event: {commitId: string; version: string; requiredScopes: string[]};
        candidate: {version: string; parentVersion: string | null; requiredScopes: string[]; topics: DreamMemoryTopic[]}} | null>;
    reviewConsolidation(owner: string, dream: string, scope: string, after?: string): Promise<{page: {items: DreamProposalView[]; scanned: number; nextCursor?: string};
        version: string | null; topics: Array<Omit<DreamMemoryTopic, 'content'>>}>;
    commitConsolidation(owner: string, dream: string, operationId: string, expectedVersion: string | null, selected: Array<{id: string; revision: number}>): Promise<{commitId: string; version: string; requiredScopes: string[]}>;
    rollbackConsolidation(owner: string, dream: string, operationId: string, targetCommitId: string, expectedVersion: string): Promise<{commitId: string; version: string; requiredScopes: string[]}>;
    resolveConsolidation(owner: string, dream: string, operationId: string, id: string, revision: number,
        resolution: {action: 'choose'; evidenceId: string} | {action: 'rewrite'; changes: DreamProposalView['changes']} | {action: 'reject'}): Promise<DreamProposalView>;
    addFile(owner: string, dream: string, operationId: string, expectedRevision: number, selection: DreamFileSelection): Promise<{sourceId: string; config: DreamConfigurationRecord}>;
    setEnabled(owner: string, dream: string, operationId: string, expectedRevision: number, enabled: boolean): Promise<DreamConfigurationRecord>;
    configureSchedule(owner: string, dream: string, operationId: string, expectedRevision: number,
        schedule: import('@nestos/kanban/contracts').KanbanRecurrence | null): Promise<{config: DreamConfigurationRecord; activation: 'ready' | 'pending'; code?: string}>;
    removeFile(owner: string, dream: string, operationId: string, expectedRevision: number, sourceId: string): Promise<DreamConfigurationRecord>;
    reviewFinding(owner: string, dream: string, id: string, operationId: string, expectedRevision: number, change: DreamReview): Promise<{revision: number}>;
    mergeFindings(owner: string, dream: string, ids: [string, string], revisions: [number, number], operationId: string): Promise<{mergeId: string}>;
    findingHistory(owner: string, dream: string, id: string, revision: number): Promise<{operationId: string; previous: DreamFindingView; result: DreamFindingView} | null>;
    adoptSuggestion(request: DreamAdoptionRequest): Promise<{itemId: string}>;
    adoptDecision(request: DreamDecisionAdoptionRequest): Promise<{recordId: string}>;
    adoptDownstreamDecision(request: DreamDecisionAdoptionRequest): Promise<{recordId: string}>;
    suggestionAdoptions(owner: string, dream: string, runId: string, suggestionId: string): Promise<DreamAdoptionRecord[]>;
    adoptionStatus(request: DreamAdoptionRequest): Promise<{state: 'pending'} | {state: 'committed'; itemId: string; execution?: {dispatchId: string; sessionId: string; outputs: Array<{name: string; ref: string; sha256: string; bytes: number}>};
        phase?: import('@nestos/kanban/contracts').KanbanTaskProjection['phase']; completion?: import('@nestos/kanban/contracts').KanbanTaskProjection['completion']}>;
    readAdoptionResults(request: DreamAdoptionRequest, cursor: string | null, limit: number): Promise<{items: string[]; cursor: string; version: string; scanned: number}>;
    adoptionBoards(owner: string): Promise<Array<{id: string; title: string; projectId?: string}>>;
    kanbanSourceCandidates(owner: string, project: string, connection: string, board: string, kind: 'task' | 'decision', cursor?: string): Promise<{items: Array<{id: string; title: string}>; returned: number; nextCursor?: string}>;
    adoptionTargets(owner: string, board: string, cursor?: string): Promise<{items: Array<{itemId: string; title: string; projectId: string}>; scanned: number; nextCursor?: string}>;
    memorySessions(owner: string, cursor?: string): Promise<{items: Array<{id: string; title: string}>; scanned: number; nextCursor?: string}>;
    remoteSessionProfiles(owner: string, project: string, connection: string): Promise<Array<{id: string; name: string}>>;
    remoteSessionCandidates(owner: string, project: string, connection: string, profile: string, cursor?: string): Promise<{items: Array<{id: string; title: string}>; returned: number; nextCursor?: string}>;
    sessionMemoryBinding(owner: string, session: string, dream?: string): Promise<{revision: number; available: boolean; sameDream: boolean; disabled: boolean} | null>;
    bindSessionMemory(owner: string, dream: string, session: string, runId: string, sourceIds: string[], operationId: string, expectedRevision: number | null, append?: boolean): Promise<{revision: number}>;
    unbindSessionMemory(owner: string, session: string, operationId: string, expectedRevision: number): Promise<{revision: number}>;
    run(input: {ownerProjectId: string; dreamId: string; sourceId: string; operationId: string}): Promise<void>;
    runAll(owner: string, dream: string, operationId: string, configRevision: number, sourceIds?: string[]): Promise<{configRevision: number;
        results: Array<{sourceId: string; operationId: string; status: 'settled' | 'failed'; code?: string}>}>;
}
