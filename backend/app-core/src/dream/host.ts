import type {IFileSystem} from '@nestos/vfs-core';
import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {Kernel} from '@nestos/durable-kernel';
import type {SessionRepository, IndependentCallService} from '@nestos/llm-session';
import {SessionCommand, type ICommandBus, type RootTargetCatalog} from '@nestos/llm-session/contracts';
import type {DreamDecisionAdoptionRequest, ProjectService} from '@nestos/app-contracts/services';
import type {TwinScannerExecutor} from '@nestos/app-contracts';
import {sameAuthority, scanSources} from '@nestos/dream';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import {createNativeDigitalTwin} from '../digital-twin/native-service';
import {PublishedScannerExecutor} from '../digital-twin/scanner-executor';
import {NestosTwinSourceReader} from '../digital-twin/source-reader';
import type {DigitalTwinService} from '../digital-twin/service';
import {DreamConfigStore, validateDreamConfig, type DreamConfig} from './config-store';
import {DreamEvidenceStore, type DreamReview} from './evidence-store';
import {PublishedConsolidationModel} from './consolidation-model';
import {DreamExecutionRegistry} from './execution-registry';
import {bindDreamExecutionFromRun, prepareDreamExecution} from './execution-bind';
import {resolveDreamExecution} from './execution-route';
import {authorizeDreamExecution} from './execution-authority';
import {DreamDownstream} from './downstream';
import {assembleDreamHotload, type DreamHotloadItem} from './hotload';
import {openDreamSystemWorkspace} from './workspace';
import {runConfiguredDreamFile, type ConfiguredDreamRequest} from './configured-scan';
import {dreamProjectFilePort} from './project-file-source';
import {validateDreamTwinFilePlan} from './twin-scan';
import {readAuthorizedDreamRun} from './evidence-access';
import {DreamSessionMemoryStore} from './session-memory-store';
import {adoptDreamSuggestion, validateDreamAdoptionRequest, type DreamAdoptionRequest} from './adopt-suggestion';
import {adoptDreamDecision, type DreamDecisionEvidence} from './adopt-decision';
import {adoptionExecution} from './adoption-execution';
import {adoptionScannerIds, adoptionTwinScanPort, configuredAdoptionSource, readAdoptionSource} from './adoption-source';
import {runDreamTwinFileScan} from './twin-scan';
import {decisionSourcePort} from './decision-source';
import {taskSourcePort} from './task-source';
import {sessionSourcePort} from './session-source';
import {changeSourcePort, type ChangeSnapshot, type DreamChangeSource} from './change-source';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanService} from '@nestos/kanban/contracts';
import {isKanbanRecurringRunBoard} from '@nestos/kanban/contracts';
import type {DreamScheduleManager} from './schedule-manager';

interface Options {
    fs: IFileSystem; repository: SessionRepository; kernel: Kernel; models: Parameters<typeof createNativeDigitalTwin>[3] & {
        getConnections(): Promise<Array<{id: string; name: string; enabled: boolean}>>};
    projects: ProjectService; remote: ProjectRemoteMountService; commands: ICommandBus; calls: IndependentCallService;
    authorizeOwner(owner: string): Promise<void>; hostKind: string; hotLoadTokenLimit?: number;
    readCommits?(source: DreamChangeSource): Promise<ChangeSnapshot>;
}
interface Entry {twin: DigitalTwinService; fs: IFileSystem; disposeView(): Promise<void>}
type DreamBatchResult = {sourceId: string; operationId: string; status: 'settled' | 'failed'; code?: string};
export interface DreamRecomputePlan {owner: string; dream: string; project: string; configRevision: number; activeVersion: string | null;
    sources: Array<{sourceId: string; operationId: string}>; id: string}
export interface DreamFileSelection {
    projectId: string; connectionId: string; path: string; executor: TwinScannerExecutor;
    maxOutputTokens: number; runTokenLimit: number;
}
const log = createModuleLogger('dream-host');

/** Host-owned resources open only for a requested Dream or a bound recovering session. */
export class DreamHost {
    readonly configs: DreamConfigStore;
    readonly evidence: DreamEvidenceStore;
    readonly registry: DreamExecutionRegistry;
    readonly sessionMemory: DreamSessionMemoryStore;
    private readonly opened = new Map<string, Promise<Entry>>();
    private closed = false;
    private kanban?: {service: KanbanService; journal: KanbanAutomationJournal};
    private schedules?: DreamScheduleManager;
    private readonly sourceAuthorization: Pick<ProjectRemoteMountService, 'authorizeDreamSource'> = {
        authorizeDreamSource: async (projectId, connectionId, capability) => {
            if (connectionId !== 'dream-local') return this.options.remote.authorizeDreamSource(projectId, connectionId, capability);
            if (capability !== 'fileRead' && capability !== 'sessionRead') throw new Error('DREAM_AUTHORIZATION_DENIED');
            const project = await this.options.projects.get(projectId);
            if (this.options.projects.fileSource(project).kind !== 'local' || this.options.remote.list(projectId).length)
                return this.options.remote.authorizeDreamSource(projectId, connectionId, capability);
            if (this.options.projects.workspaceAccess(project) !== 'rw') throw new Error('DREAM_OWNER_AUTHORIZATION_FAILED');
            const revision = sha256HexSync(JSON.stringify([project.project.id, project.project.directory, project.project.source, project.path]));
            return {principalId: 'local-profile', revision, projectRevision: revision, serverId: 'local-profile', serverProjectId: projectId};
        },
    };
    constructor(private readonly options: Options) {
        this.configs = new DreamConfigStore(options.fs); this.evidence = new DreamEvidenceStore(options.fs);
        this.registry = new DreamExecutionRegistry(options.fs);
        this.sessionMemory = new DreamSessionMemoryStore(options.fs);
    }
    bindKanban(service: KanbanService, journal: KanbanAutomationJournal): void {this.kanban = {service, journal};}
    bindSchedules(schedules: DreamScheduleManager): void {this.schedules = schedules;}
    async adoptionBoards(owner: string) {
        await this.options.authorizeOwner(owner);
        if (!this.kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        const boards = await this.kanban.service.catalog();
        await this.options.authorizeOwner(owner);
        return boards.filter(board => !board.lifecycle && !isKanbanRecurringRunBoard(board)).map(board => ({
            id: board.id, title: board.title, ...(board.scope.kind === 'project' ? {projectId: board.scope.projectId} : {}),
        }));
    }
    async kanbanSourceCandidates(owner: string, project: string, connection: string, board: string, kind: 'task' | 'decision', cursor?: string) {
        const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(board) ? board : 'invalid';
        try {
        if (kind !== 'task' && kind !== 'decision') throw new Error('DREAM_SOURCE_SCOPE_CHANGED');
        await this.options.authorizeOwner(owner);
        if (!this.kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        const authority = await this.sourceAuthorization.authorizeDreamSource(project, connection, 'fileRead');
        const reference = {system: 'nestos-remote-project', id: project};
        const page = kind === 'task' ? await this.kanban.service.query(board, {view: 'all', excludeArchived: true, reference, limit: 50, ...(cursor ? {cursor} : {})})
            : await this.kanban.service.records(board, {kind: 'decision', status: 'confirmed', resource: reference, limit: 50, ...(cursor ? {cursor} : {})});
        await this.options.authorizeOwner(owner);
        if (!sameAuthority(authority, await this.sourceAuthorization.authorizeDreamSource(project, connection, 'fileRead'))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const rows = kind === 'task' ? page.items.filter(item => 'taskType' in item && item.taskType === 'execution') : page.items;
        log.info('dream.kanban.candidates', {operationId, stage: 'page', result: 'success', kind,
            returned: page.items.length, selected: rows.length, durationMs: Date.now() - started});
        return {items: rows.map(item => ({id: item.id, title: item.title})), returned: page.items.length, ...(page.nextCursor ? {nextCursor: page.nextCursor} : {})};
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_CANDIDATE_READ_FAILED';
            log.warn('dream.kanban.candidates', {operationId, stage: 'page', result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    async adoptionTargets(owner: string, board: string, cursor?: string) {
        await this.options.authorizeOwner(owner);
        if (!this.kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        const page = await this.kanban.service.query(board, {view: 'all', excludeArchived: true, limit: 100, cursor});
        const items = page.items.filter(item => item.taskType === 'coordination' && !item.deletedAt && !item.archivedAt
            && !item.planning.parentId && item.control?.action !== 'cancel' && !['completed', 'cancelled', 'claimed', 'review'].includes(item.status))
            .flatMap(item => (item.externalRefs ?? []).filter(ref => ref.system === 'nestos-remote-project')
                .map(ref => ({itemId: item.id, title: item.title, projectId: ref.id})));
        await this.options.authorizeOwner(owner);
        return {items, scanned: page.items.length, ...(page.nextCursor ? {nextCursor: page.nextCursor} : {})};
    }
    async adoptSuggestion(request: DreamAdoptionRequest) {
        const kanban = this.kanban;
        if (!kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        validateDreamAdoptionRequest(request);
        await this.options.authorizeOwner(request.ownerProjectId); await this.authorizeTarget(request.targetProjectId);
        const config = await this.configs.read(request.ownerProjectId, request.dreamId);
        const view = await this.readRun(request.ownerProjectId, request.dreamId, request.runId);
        if (!config?.config.enabled || !view?.findings.some(item => item.id === request.suggestionId && item.kind === 'suggestion' && item.state === 'active'))
            throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
        await this.evidence.prepareAdoption(request, config.revision);
        const result = await adoptDreamSuggestion(request, {configs: this.configs, evidence: this.evidence, journal: kanban.journal, kanban: kanban.service,
            authorizeOwner: this.options.authorizeOwner, authorizeTarget: async (_board, project) => this.authorizeTarget(project),
            source: {authorize: async source => {
                const config = await this.configs.read(request.ownerProjectId, request.dreamId);
                const file = config?.config.files.find(item => item.id === source.id && item.projectId === source.projectId && item.connectionId === source.connectionId);
                if (!file) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
                return this.sourceAuthorization.authorizeDreamSource(file.projectId, file.connectionId, file.capability);
            }}});
        const receiptStarted = Date.now();
        try {await this.evidence.completeAdoption(request.ownerProjectId, request.dreamId, request.operationId, result.itemId);}
        catch {
            log.warn('dream.adoption.receipt', {operationId: request.operationId, stage: 'commit', result: 'failure',
                code: 'DREAM_ADOPTION_RECEIPT_UNAVAILABLE', durationMs: Date.now() - receiptStarted});
            throw new Error('DREAM_ADOPTION_RECEIPT_UNAVAILABLE');
        }
        return result;
    }
    async suggestionAdoptions(owner: string, dream: string, runId: string, suggestionId: string) {
        const view = await this.readRun(owner, dream, runId);
        if (!view?.findings.some(item => item.id === suggestionId && item.kind === 'suggestion')) throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
        const rows = await this.evidence.adoptions(owner, dream, suggestionId);
        const final = await this.readRun(owner, dream, runId);
        if (!final?.findings.some(item => item.id === suggestionId && item.kind === 'suggestion')) throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
        return rows.filter(row => row.request.runId === runId);
    }
    async adoptDecision(request: DreamDecisionAdoptionRequest) {
        const kanban = this.kanban;
        if (!kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        return adoptDreamDecision(request, {kanban: kanban.service, journal: kanban.journal, store: this.evidence,
            inspect: input => this.decisionEvidence(kanban.service, input)});
    }
    async adoptDownstreamDecision(request: DreamDecisionAdoptionRequest) {
        const kanban = this.kanban;
        if (!kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        return adoptDreamDecision(request, {kanban: kanban.service, journal: kanban.journal, store: this.evidence,
            inspect: input => this.downstreamDecisionEvidence(kanban.service, input),
            prepare: (input, revision) => this.evidence.prepareDownstreamDecisionAdoption(input, revision)});
    }
    private async downstreamDecisionEvidence(kanban: Pick<KanbanService, 'read'>, request: DreamDecisionAdoptionRequest): Promise<DreamDecisionEvidence> {
        const config = await this.configs.read(request.ownerProjectId, request.dreamId);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const board = await kanban.read(request.boardId);
        if (board.lifecycle || isKanbanRecurringRunBoard(board) || board.scope.kind === 'project' && board.scope.projectId !== request.targetProjectId
            || (await this.options.projects.get(request.targetProjectId)).project.source?.kind !== 'remote') throw new Error('DREAM_TARGET_SCOPE_CHANGED');
        await this.authorizeTarget(request.targetProjectId);
        const contribution = await this.readDownstream(request.ownerProjectId, request.dreamId, 'kanban', request.runId);
        const change = contribution?.changes.find(item => item.id === request.suggestionId);
        const sourceId = contribution?.requiredScopes[0];
        const watermark = sourceId ? await this.evidence.watermark(request.ownerProjectId, request.dreamId, sourceId) : null;
        if (!contribution || !change || !sourceId || !watermark) throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
        await this.evidence.checkConfig(request.ownerProjectId, request.dreamId, config.revision);
        const content = change.content ?? `Retire memory: ${change.id}`;
        return {configRevision: config.revision, suggestion: {id: change.id, sourceId, kind: 'suggestion', content,
            revision: 1, state: 'active', origin: 'source'}, evidence: {sourceId, projectId: watermark.projectId,
            connectionId: watermark.connectionId, authority: watermark.authority, startCursor: watermark.cursor, endCursor: watermark.cursor,
            version: contribution.version, scanned: 1}};
    }
    private async decisionEvidence(kanban: Pick<KanbanService, 'read'>, request: DreamDecisionAdoptionRequest): Promise<DreamDecisionEvidence> {
        const {ownerProjectId: owner, dreamId: dream, runId, suggestionId, targetProjectId} = request;
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const board = await kanban.read(request.boardId);
        if (board.lifecycle || isKanbanRecurringRunBoard(board) || board.scope.kind === 'project' && board.scope.projectId !== targetProjectId)
            throw new Error('DREAM_TARGET_SCOPE_CHANGED');
        if ((await this.options.projects.get(targetProjectId)).project.source?.kind !== 'remote')
            throw new Error('DREAM_TARGET_SCOPE_CHANGED');
        await this.authorizeTarget(targetProjectId);
        const view = await this.readRun(owner, dream, runId);
        const suggestion = view?.findings.find(finding => finding.id === suggestionId && finding.kind === 'suggestion' && finding.state === 'active');
        const source = view?.sources.find(source => source.status === 'available' && source.evidence.sourceId === suggestion?.sourceId);
        if (!suggestion || source?.status !== 'available') throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
        await this.evidence.checkConfig(owner, dream, config.revision);
        const priorTask = config.config.tasks?.find(item => item.id === suggestion.sourceId)
            ?? config.config.adoptions?.find(item => item.id === suggestion.sourceId);
        const priorDecision = config.config.decisions?.find(item => item.id === suggestion.sourceId);
        const origin = priorTask ? {kind: 'task' as const, boardId: priorTask.boardId, id: priorTask.itemId}
            : priorDecision ? {kind: 'decision' as const, boardId: priorDecision.boardId, id: priorDecision.recordId} : undefined;
        return {configRevision: config.revision, suggestion, evidence: source.evidence, origin};
    }
    async adoptionStatus(request: DreamAdoptionRequest) {
        const kanban = this.kanban; if (!kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        const rows = await this.suggestionAdoptions(request.ownerProjectId, request.dreamId, request.runId, request.suggestionId);
        const record = rows.find(row => row.request.operationId === request.operationId);
        if (!record || record.kind === 'decision' || JSON.stringify(record.request) !== JSON.stringify(request)) throw new Error('DREAM_ADOPTION_INVALID');
        if (record.state !== 'committed' || !record.itemId) return {state: 'pending' as const};
        await this.authorizeTarget(request.targetProjectId);
        const actual = await kanban.service.item(request.boardId, record.itemId);
        const reference = JSON.stringify([request.ownerProjectId, request.dreamId, request.runId, request.suggestionId]);
        if (!actual.item.externalRefs?.some(ref => ref.system === 'nestos-dream' && ref.id === reference)) throw new Error('DREAM_ADOPTION_RECEIPT_MISMATCH');
        const workflow = await kanban.service.workflow(request.boardId);
        const execution = adoptionExecution(actual.item, workflow.dispatches);
        await this.suggestionAdoptions(request.ownerProjectId, request.dreamId, request.runId, request.suggestionId);
        await this.authorizeTarget(request.targetProjectId);
        const current = await kanban.service.item(request.boardId, record.itemId);
        if (current.item.revision !== actual.item.revision) throw new Error('DREAM_ADOPTION_RECEIPT_CHANGED');
        return {state: 'committed' as const, itemId: record.itemId, phase: actual.task?.phase,
            completion: actual.task?.completion, ...(execution ? {execution} : {})};
    }
    async readAdoptionResults(request: DreamAdoptionRequest, cursor: string | null, limit: number) {
        const kanban = this.kanban; if (!kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        return readAdoptionSource(request.operationId, cursor, limit, async () => {
            const status = await this.adoptionStatus(request);
            return status.state === 'committed' ? status.execution : undefined;
        }, kanban.journal);
    }
    async configuredAdoptionPort(owner: string, dream: string, sourceId: string, request: DreamAdoptionRequest) {
        const kanban = this.kanban; if (!kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const current = async () => {
            const status = await this.adoptionStatus(request);
            await this.evidence.checkConfig(owner, dream, config.revision);
            return status.state === 'committed' ? status : undefined;
        };
        return configuredAdoptionSource(config.config, owner, dream, sourceId, request, async () => {
            const run = await this.readRun(owner, dream, request.runId);
            const finding = run?.findings.find(item => item.id === request.suggestionId && item.kind === 'suggestion');
            const file = config.config.files.find(item => item.id === finding?.sourceId);
            if (!file) throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
            await this.authorizeMemory(owner, dream, config.config, file.id);
            return this.sourceAuthorization.authorizeDreamSource(file.projectId, file.connectionId, file.capability);
        }, current, kanban.journal);
    }
    async configureAdoptionSources(owner: string, dream: string, operationId: string, expectedRevision: number,
        adoptions: import('./config-store').DreamAdoptionSourceConfig[]) {
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
        return this.configs.save(owner, dream, operationId, expectedRevision, {...base.config, adoptions}, {
            owner: () => this.options.authorizeOwner(owner), source: async () => {},
            adoption: async source => {await this.authorizeConfiguredAdoption(owner, dream, source);},
        });
    }
    async configureDecisionSources(owner: string, dream: string, operationId: string, expectedRevision: number,
        decisions: import('./config-store').DreamDecisionSourceConfig[]) {
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
        return this.configs.save(owner, dream, operationId, expectedRevision, {...base.config, decisions}, {
            owner: () => this.options.authorizeOwner(owner), source: async () => {}, decision: async source => {await this.authorizeDecision(source);},
        });
    }
    async configureTaskSources(owner: string, dream: string, operationId: string, expectedRevision: number,
        tasks: import('./config-store').DreamTaskSourceConfig[]) {
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
        return this.configs.save(owner, dream, operationId, expectedRevision, {...base.config, tasks}, {
            owner: () => this.options.authorizeOwner(owner), source: async () => {}, task: async source => {await this.authorizeTask(source);},
        });
    }
    async configureSessionSources(owner: string, dream: string, operationId: string, expectedRevision: number,
        sessions: import('./config-store').DreamSessionSourceConfig[]) {
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
        return this.configs.save(owner, dream, operationId, expectedRevision, {...base.config, sessions}, {
            owner: () => this.options.authorizeOwner(owner), source: async () => {}, session: async source => {await this.authorizeSessionSource(source);},
        });
    }
    async configureChangeSources(owner: string, dream: string, operationId: string, expectedRevision: number,
        changes: import('./config-store').DreamChangeSourceConfig[]) {
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
        return this.configs.save(owner, dream, operationId, expectedRevision, {...base.config, changes}, {
            owner: () => this.options.authorizeOwner(owner), source: async () => {}, change: source => this.validateChangeSource(source),
        });
    }

    async configureConsolidation(owner: string, dream: string, operationId: string, expectedRevision: number,
        consolidation: DreamConfig['consolidation'] | null) {
        const started = Date.now(); let stage = 'authorize';
        try {
            if (consolidation === undefined) throw new Error('DREAM_CONFIG_INVALID');
            await this.options.authorizeOwner(owner);
            const base = await this.configs.readRevision(owner, dream, expectedRevision);
            if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
            const {consolidation: _previous, ...config} = base.config;
            stage = 'save';
            const result = await this.configure(owner, dream, operationId, expectedRevision, {...config, ...(consolidation ? {consolidation} : {})});
            log.info('dream.consolidation.configure', {operationId, stage, result: 'success', durationMs: Date.now() - started});
            return result;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_CONSOLIDATION_CONFIG_FAILED';
            log.warn('dream.consolidation.configure', {operationId: /^[a-zA-Z0-9_-]{1,128}$/.test(operationId) ? operationId : 'invalid',
                stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    private async validateChangeSource(source: DreamChangeSource): Promise<void> {
        const input = {id: source.id, projectId: source.projectId, connectionId: source.connectionId, cursor: null};
        const port = this.changePort(source);
        if (source.commits) {
            const before = await port.authorize(input);
            await port.read(input, 1);
            if (!sameAuthority(before, await port.authorize(input))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
            return;
        }
        const [result] = await scanSources([input], 1, port);
        if (result.status !== 'ok') throw new Error('DREAM_CHANGE_SCOPE_UNAVAILABLE');
    }
    private async authorizeChange(source: import('./config-store').DreamChangeSourceConfig) {
        if (this.options.remote.list(source.projectId).some(mount => mount.at !== '/')) throw new Error('DREAM_CHANGE_MOUNT_UNSUPPORTED');
        return this.sourceAuthorization.authorizeDreamSource(source.projectId, source.connectionId, 'fileRead');
    }
    private changePort(source: import('./config-store').DreamChangeSourceConfig) {
        return changeSourcePort(source, this.options.projects, value => this.authorizeChange(value), this.options.readCommits);
    }
    private sessionPort(source: import('./config-store').DreamSessionSourceConfig) {
        const reader = new NestosTwinSourceReader(this.options.fs, this.options.repository, this.options.projects);
        return sessionSourcePort(source, reader, value => this.authorizeSessionSource({...source, ...value}));
    }
    private async authorizeSessionSource(source: import('./config-store').DreamSessionSourceConfig) {
        if (source.profileId) {
            if (source.connectionId === 'dream-local') throw new Error('DREAM_SESSION_SCOPE_CHANGED');
            const started = Date.now();
            const authority = await this.sourceAuthorization.authorizeDreamSource(source.projectId, source.connectionId, 'sessionRead');
            const client = await this.options.remote.projectHarness(source.projectId, {timeoutMs: 5000});
            try {
                if (!client.digest) throw new Error('DREAM_SESSION_DIGEST_UNAVAILABLE');
                const digest = await client.digest(source.profileId, source.sessionId, {timeoutMs: 5000, metadataOnly: true});
                if (typeof digest.session.createdAt !== 'number' || !digest.session.historyRevision) throw new Error('DREAM_SESSION_DIGEST_UNAVAILABLE');
                if (digest.session.id !== source.sessionId || digest.session.activeTurnId
                    || !['idle', 'notLoaded', null].includes(digest.session.status)) throw new Error('DREAM_SESSION_SCOPE_CHANGED');
                log.info('dream.session.authorize', {operationId: source.id, stage: 'native-metadata', result: 'success', durationMs: Date.now() - started});
            } finally {await client.close();}
            if (!sameAuthority(authority, await this.sourceAuthorization.authorizeDreamSource(source.projectId, source.connectionId, 'sessionRead')))
                throw new Error('DREAM_AUTHORIZATION_CHANGED');
            return authority;
        }
        if (source.connectionId !== 'dream-local' || /^(twin-(analysis|collection)-|dream-schedule-)/.test(source.sessionId)
            || await this.registry.find(source.sessionId)) throw new Error('DREAM_SESSION_SCOPE_CHANGED');
        await this.assertSessionOwner(source.projectId, source.sessionId);
        const authority = await this.sourceAuthorization.authorizeDreamSource(source.projectId, source.connectionId, 'sessionRead');
        await this.assertSessionOwner(source.projectId, source.sessionId);
        return authority;
    }
    private taskPort(source: import('./config-store').DreamTaskSourceConfig) {
        if (!this.kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        return taskSourcePort(source, this.kanban.service, value => this.sourceAuthorization.authorizeDreamSource(value.projectId, value.connectionId, 'fileRead'));
    }
    private async authorizeTask(source: import('./config-store').DreamTaskSourceConfig) {
        const [result] = await scanSources([{id: source.id, projectId: source.projectId, connectionId: source.connectionId, cursor: null}], 1, this.taskPort(source));
        if (result.status !== 'ok') throw new Error('DREAM_SOURCE_' + (result.status === 'failed' ? result.code : 'BUDGET_EXHAUSTED'));
        return result.evidence.authority;
    }
    private decisionPort(source: import('./config-store').DreamDecisionSourceConfig) {
        if (!this.kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        return decisionSourcePort(source, this.kanban.service, value => this.sourceAuthorization.authorizeDreamSource(value.projectId, value.connectionId, 'fileRead'));
    }
    private async authorizeDecision(source: import('./config-store').DreamDecisionSourceConfig) {
        const port = this.decisionPort(source), input = {id: source.id, projectId: source.projectId, connectionId: source.connectionId, cursor: null};
        const [result] = await scanSources([input], 1, port);
        if (result.status !== 'ok') throw new Error('DREAM_SOURCE_' + (result.status === 'failed' ? result.code : 'BUDGET_EXHAUSTED'));
        return result.evidence.authority;
    }
    private async authorizeConfiguredAdoption(owner: string, dream: string, source: import('./config-store').DreamAdoptionSourceConfig) {
        const kanban = this.kanban; if (!kanban) throw new Error('DREAM_KANBAN_UNAVAILABLE');
        const item = (await kanban.service.item(source.boardId, source.itemId)).item;
        const ref = item.externalRefs?.find(value => value.system === 'nestos-dream');
        let binding: unknown; try {binding = JSON.parse(ref?.id ?? '');} catch {throw new Error('DREAM_SOURCE_BINDING_CHANGED');}
        if (!Array.isArray(binding) || binding.length !== 4 || binding[0] !== owner || binding[1] !== dream
            || typeof binding[2] !== 'string' || typeof binding[3] !== 'string') throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        const rows = await this.suggestionAdoptions(owner, dream, binding[2], binding[3]);
        const record = rows.find(row => row.kind !== 'decision' && row.state === 'committed' && row.itemId === source.itemId && row.request.boardId === source.boardId);
        if (!record || record.kind === 'decision') throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        const status = await this.adoptionStatus(record.request);
        if (status.state !== 'committed' || status.itemId !== source.itemId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        return record.request;
    }
    private async readManagedAdoption(owner: string, dream: string, sourceId: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        const change = config?.config.enabled && config.config.changes?.find(item => item.id === sourceId);
        if (change) {
            const [result] = await scanSources([{id: change.id, projectId: change.projectId, connectionId: change.connectionId, cursor: null}], 1, this.changePort(change));
            if (result.status !== 'ok' || result.items.length !== 1) throw new Error('DREAM_SOURCE_UNAVAILABLE');
            await this.evidence.checkConfig(owner, dream, config!.revision);
            return {text: result.items[0], hash: sha256HexSync(result.items[0]), nativeIdentity: JSON.parse(result.evidence.version)[0] as string};
        }
        const session = config?.config.enabled && config.config.sessions?.find(item => item.id === sourceId);
        if (session) {
            const [result] = await scanSources([{id: session.id, projectId: session.projectId, connectionId: session.connectionId, cursor: null}], 1, this.sessionPort(session));
            if (result.status !== 'ok' || result.items.length !== 1) throw new Error('DREAM_SOURCE_UNAVAILABLE');
            await this.evidence.checkConfig(owner, dream, config!.revision);
            return {text: result.items[0], hash: sha256HexSync(result.items[0]), nativeIdentity: JSON.parse(result.evidence.version)[0] as string};
        }
        const task = config?.config.enabled && config.config.tasks?.find(item => item.id === sourceId);
        if (task) {
            const [result] = await scanSources([{id: task.id, projectId: task.projectId, connectionId: task.connectionId, cursor: null}], 1, this.taskPort(task));
            if (result.status !== 'ok' || result.items.length !== 1) throw new Error('DREAM_SOURCE_UNAVAILABLE');
            await this.evidence.checkConfig(owner, dream, config!.revision);
            return {text: result.items[0], hash: sha256HexSync(result.items[0]), nativeIdentity: JSON.parse(result.evidence.version)[0] as string};
        }
        const decision = config?.config.enabled && config.config.decisions?.find(item => item.id === sourceId);
        if (decision) {
            const [result] = await scanSources([{id: decision.id, projectId: decision.projectId, connectionId: decision.connectionId, cursor: null}], 1, this.decisionPort(decision));
            if (result.status !== 'ok' || result.items.length !== 1) throw new Error('DREAM_SOURCE_UNAVAILABLE');
            await this.evidence.checkConfig(owner, dream, config!.revision);
            return {text: result.items[0], hash: sha256HexSync(result.items[0]), nativeIdentity: JSON.parse(result.evidence.version)[0] as string};
        }
        const source = config?.config.enabled && config.config.adoptions?.find(item => item.id === sourceId);
        if (!source) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const request = await this.authorizeConfiguredAdoption(owner, dream, source);
        const port = await this.configuredAdoptionPort(owner, dream, sourceId, request);
        const [result] = await scanSources([{id: sourceId, projectId: request.targetProjectId, connectionId: 'kanban-adoption', cursor: null}], 1, port);
        if (result.status !== 'ok' || result.items.length !== 1) throw new Error('DREAM_SOURCE_UNAVAILABLE');
        await this.evidence.checkConfig(owner, dream, config!.revision);
        return {text: result.items[0], hash: sha256HexSync(result.items[0]), nativeIdentity: result.evidence.version};
    }
    private async adoptionBinding(binding: import('./execution-registry').DreamExecutionBinding) {
        const config = await this.configs.read(binding.ownerProjectId, binding.dreamId);
        const change = config?.config.changes?.find(item => item.id === binding.sourceId);
        if (change && config?.revision === binding.configRevision) return this.authorizeChange(change);
        const session = config?.config.sessions?.find(item => item.id === binding.sourceId);
        if (session && config?.revision === binding.configRevision) return this.authorizeSessionSource(session);
        const task = config?.config.tasks?.find(item => item.id === binding.sourceId);
        if (task && config?.revision === binding.configRevision) return this.authorizeTask(task);
        const decision = config?.config.decisions?.find(item => item.id === binding.sourceId);
        if (decision && config?.revision === binding.configRevision) return this.authorizeDecision(decision);
        const selected = config?.config.adoptions?.find(item => item.id === binding.sourceId);
        if (!selected || config?.revision !== binding.configRevision) throw new Error('DREAM_CONFIG_CONFLICT');
        const request = await this.authorizeConfiguredAdoption(binding.ownerProjectId, binding.dreamId, selected);
        const port = await this.configuredAdoptionPort(binding.ownerProjectId, binding.dreamId, binding.sourceId, request);
        return port.authorize({id: binding.sourceId, projectId: request.targetProjectId, connectionId: 'kanban-adoption', cursor: null});
    }
    private async authorizeTarget(id: string): Promise<void> {
        const project = await this.options.projects.get(id);
        if (this.options.projects.fileSource(project).kind === 'local') {
            if (this.options.projects.workspaceAccess(project) !== 'rw') throw new Error('DREAM_OWNER_AUTHORIZATION_FAILED');
            return;
        }
        const root = this.options.remote.list(id).find(item => item.at === '/');
        if (!root?.connectionId) throw new Error('DREAM_TARGET_SCOPE_CHANGED');
        await this.sourceAuthorization.authorizeDreamSource(id, root.connectionId, 'fileRead');
    }
    async create(owner: string, dream: string, operationId: string, name: string) {
        return this.configs.save(owner, dream, operationId, null, {name, enabled: true, files: []},
            {owner: () => this.options.authorizeOwner(owner), source: async () => {throw new Error('DREAM_SOURCE_NOT_CONFIGURED');}});
    }
    async scannerTargets(owner: string, dream: string) {
        await this.options.authorizeOwner(owner);
        if (!await this.configs.read(owner, dream)) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const targets = (await this.options.commands.execute<RootTargetCatalog>(SessionCommand.ListTargets)).entries;
        await this.options.authorizeOwner(owner); return targets;
    }
    async openView(owner: string, dream: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config) return null;
        const [history, catalog, connections, scheduleStatus] = await Promise.all([this.evidence.history(owner, dream),
            this.options.commands.execute<RootTargetCatalog>(SessionCommand.ListTargets), this.options.models.getConnections(),
            this.schedules?.status(owner, dream).catch(() => ({state: 'error' as const, nextAt: 0, code: 'DREAM_SCHEDULE_INVALID'})) ?? Promise.resolve(null)]);
        await this.evidence.checkConfig(owner, dream, config.revision); await this.options.authorizeOwner(owner);
        return {config, history, scheduleStatus, targets: catalog.entries, models: connections.filter(item => item.enabled).map(item => ({id: item.id, name: item.name}))};
    }
    async readConfig(owner: string, dream: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        await this.options.authorizeOwner(owner);
        return config;
    }
    async list(owner: string) {
        await this.options.authorizeOwner(owner);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(owner)) throw new Error('DREAM_INVALID_SCOPE');
        const path = `/var/lib/projects/${owner}/dream`, fs = this.options.fs;
        const entries = await fs.driver.exists(path) ? await fs.driver.getChildren(path, {fields: 'entry'}) : [];
        const names = entries.filter(item => item.type === 'directory' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(item.name))
            .map(item => item.name).sort();
        const results = await Promise.all(names.slice(0, 100).map(async id => ({id, record: await this.configs.read(owner, id)})));
        await this.options.authorizeOwner(owner);
        return {items: results.flatMap(({id, record}) => record ? [{id, name: record.config.name, enabled: record.config.enabled, revision: record.revision}] : []),
            scanned: entries.length, truncated: names.length > 100};
    }
    async readRun(owner: string, dream: string, operationId: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config) return null;
        const selected = config.config.files.map(file => ({id: file.id, projectId: file.projectId, connectionId: file.connectionId, cursor: null}));
        const raw = config.config.adoptions?.length || config.config.decisions?.length || config.config.tasks?.length || config.config.sessions?.length || config.config.changes?.length ? await this.evidence.run(owner, dream, operationId) : null;
        for (const outcome of raw?.outcomes ?? []) if (outcome.status === 'ok' && (config.config.adoptions?.some(item => item.id === outcome.evidence.sourceId) || config.config.decisions?.some(item => item.id === outcome.evidence.sourceId) || config.config.tasks?.some(item => item.id === outcome.evidence.sourceId) || config.config.sessions?.some(item => item.id === outcome.evidence.sourceId) || config.config.changes?.some(item => item.id === outcome.evidence.sourceId)))
            selected.push({id: outcome.evidence.sourceId, projectId: outcome.evidence.projectId, connectionId: outcome.evidence.connectionId, cursor: null});
        const result = await readAuthorizedDreamRun(this.evidence, owner, dream, operationId, selected, {authorize: async source => {
            const file = config.config.files.find(item => item.id === source.id);
            if (file) return this.sourceAuthorization.authorizeDreamSource(file.projectId, file.connectionId, file.capability);
            const change = config.config.changes?.find(item => item.id === source.id);
            if (change) {
                if (change.projectId !== source.projectId || change.connectionId !== source.connectionId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                return this.authorizeChange(change);
            }
            const session = config.config.sessions?.find(item => item.id === source.id);
            if (session) {
                if (session.projectId !== source.projectId || session.connectionId !== source.connectionId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                return this.authorizeSessionSource(session);
            }
            const task = config.config.tasks?.find(item => item.id === source.id);
            if (task) {
                if (task.projectId !== source.projectId || task.connectionId !== source.connectionId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                return this.authorizeTask(task);
            }
            const decision = config.config.decisions?.find(item => item.id === source.id);
            if (decision) {
                if (decision.projectId !== source.projectId || decision.connectionId !== source.connectionId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                return this.authorizeDecision(decision);
            }
            const adoption = config.config.adoptions?.find(item => item.id === source.id);
            if (!adoption) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const request = await this.authorizeConfiguredAdoption(owner, dream, adoption);
            return (await this.configuredAdoptionPort(owner, dream, source.id, request)).authorize(source);
        }});
        await this.evidence.checkConfig(owner, dream, config.revision);
        await this.options.authorizeOwner(owner); return result;
    }
    async history(owner: string, dream: string, before?: number) {
        await this.options.authorizeOwner(owner);
        const result = await this.evidence.history(owner, dream, before);
        await this.options.authorizeOwner(owner); return result;
    }
    async reviewFinding(owner: string, dream: string, id: string, operationId: string, expectedRevision: number, change: DreamReview) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const authorize = (sourceId: string) => this.authorizeMemory(owner, dream, config.config, sourceId);
        const result = await this.evidence.review(owner, dream, id, operationId, expectedRevision, change, authorize, config.revision);
        return {revision: result.revision};
    }
    async mergeFindings(owner: string, dream: string, ids: [string, string], revisions: [number, number], operationId: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        return this.evidence.merge(owner, dream, ids, revisions, operationId, config.revision,
            sourceId => this.authorizeMemory(owner, dream, config.config, sourceId));
    }
    async findingHistory(owner: string, dream: string, id: string, revision: number) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const entry = await this.evidence.reviewHistory(owner, dream, id, revision,
            sourceId => this.authorizeMemory(owner, dream, config.config, sourceId));
        await this.evidence.checkConfig(owner, dream, config.revision); await this.options.authorizeOwner(owner); return entry;
    }
    async memorySessions(owner: string, cursor?: string) {
        await this.options.authorizeOwner(owner);
        const project = await this.options.projects.get(owner);
        const page = await this.options.repository.listSummaryPage(project.path + '/@sessions', {limit: 50, ...(cursor ? {cursor} : {})});
        await this.options.authorizeOwner(owner);
        return {items: page.items.filter(item => !/^(dream-schedule-|twin-(analysis|collection)-)/.test(item.id))
            .map(item => ({id: item.id, title: item.title})), scanned: page.items.length, ...(page.nextCursor ? {nextCursor: page.nextCursor} : {})};
    }
    async remoteSessionProfiles(owner: string, project: string, connection: string) {
        return this.remoteCatalogRead(project, 'profiles', async () => {
        await this.options.authorizeOwner(owner);
        const authority = await this.sourceAuthorization.authorizeDreamSource(project, connection, 'sessionRead');
        const client = await this.options.remote.projectHarness(project, {timeoutMs: 5000});
        try {
            const all = (await client.profiles({timeoutMs: 5000})).profiles;
            if (all.length > 100) throw new Error('DREAM_SOURCE_LIMIT');
            const profiles = all.filter(item => item.projectRuntime && item.capabilities.sessionDigest && item.id.length <= 128 && item.kind.length <= 200);
            await this.options.authorizeOwner(owner);
            if (!sameAuthority(authority, await this.sourceAuthorization.authorizeDreamSource(project, connection, 'sessionRead'))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
            log.info('dream.session.catalog.page', {operationId: project, stage: 'profiles', result: 'success', returned: profiles.length});
            return profiles.map(item => ({id: item.id, name: item.kind}));
        } finally {await client.close();}
        });
    }
    async remoteSessionCandidates(owner: string, project: string, connection: string, profile: string, cursor?: string) {
        return this.remoteCatalogRead(project, 'sessions', async () => {
        await this.options.authorizeOwner(owner);
        const authority = await this.sourceAuthorization.authorizeDreamSource(project, connection, 'sessionRead');
        const client = await this.options.remote.projectHarness(project, {timeoutMs: 5000});
        try {
            const profiles = (await client.profiles({timeoutMs: 5000})).profiles;
            if (profiles.length > 100) throw new Error('DREAM_SOURCE_LIMIT');
            const allowed = profiles.some(item => item.id === profile && item.projectRuntime && item.capabilities.sessionDigest);
            if (!allowed) throw new Error('DREAM_SESSION_DIGEST_UNAVAILABLE');
            const page = await client.list(profile, {limit: 50, ...(cursor ? {cursor} : {})}, {timeoutMs: 5000});
            if (page.sessions.length > 50 || page.sessions.some(item => item.id.length > 128 || item.title.length > 200)) throw new Error('DREAM_SOURCE_LIMIT');
            await this.options.authorizeOwner(owner);
            if (!sameAuthority(authority, await this.sourceAuthorization.authorizeDreamSource(project, connection, 'sessionRead'))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
            log.info('dream.session.catalog.page', {operationId: project, stage: 'sessions', result: 'success', returned: page.sessions.length});
            return {items: page.sessions.map(item => ({id: item.id, title: item.title})), returned: page.sessions.length, ...(page.nextCursor ? {nextCursor: page.nextCursor} : {})};
        } finally {await client.close();}
        });
    }
    private async remoteCatalogRead<T>(project: string, stage: 'profiles' | 'sessions', action: () => Promise<T>): Promise<T> {
        const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(project) ? project : 'invalid';
        try {
            const result = await action();
            log.info('dream.session.catalog', {operationId, stage, result: 'success', durationMs: Date.now() - started});
            return result;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SESSION_CATALOG_FAILED';
            log.warn('dream.session.catalog', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    async sessionMemoryBinding(owner: string, session: string, dream?: string) {
        await this.assertSessionOwner(owner, session);
        const binding = await this.sessionMemory.read(session);
        await this.assertSessionOwner(owner, session);
        return binding ? {revision: binding.revision, available: !('disabled' in binding) && binding.owner === owner,
            sameDream: !('disabled' in binding) && binding.owner === owner && binding.dream === dream, disabled: 'disabled' in binding} : null;
    }
    async unbindSessionMemory(owner: string, session: string, operationId: string, expectedRevision: number) {
        const started = Date.now();
        try {
            await this.assertSessionOwner(owner, session);
            const receipt = await this.sessionMemory.unbind(session, operationId, expectedRevision);
            log.info('dream.session.unbind', {operationId, stage: 'commit', result: 'success', durationMs: Date.now() - started}); return receipt;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SESSION_UNBIND_FAILED';
            log.warn('dream.session.unbind', {operationId: /^[a-zA-Z0-9_-]{1,128}$/.test(operationId) ? operationId : 'invalid',
                stage: 'commit', result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
        }
    }
    async bindSessionMemory(owner: string, dream: string, session: string, runId: string, sourceIds: string[], operationId: string, expectedRevision: number | null, append = false) {
        const started = Date.now(); let stage = 'authorize';
        try {
            await this.assertSessionOwner(owner, session);
            const config = await this.configs.read(owner, dream);
            if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const view = await this.readRun(owner, dream, runId);
            if (!view || sourceIds.some(id => !view.sources.some(item => item.status === 'available' && item.evidence.sourceId === id)))
                throw new Error('DREAM_AUTHORIZATION_UNAVAILABLE');
            await this.evidence.checkConfig(owner, dream, config.revision);
            await this.assertSessionOwner(owner, session); stage = 'commit';
            const previous = append ? await this.sessionMemory.read(session) : null;
            if (append && (!previous || 'disabled' in previous || previous.owner !== owner || previous.dream !== dream || previous.configRevision !== config.revision))
                throw new Error('DREAM_SESSION_BINDING_CONFLICT');
            const base = previous && !('disabled' in previous) ? previous : {owner, dream, runId, sourceIds: [...sourceIds], configRevision: config.revision};
            const selections = [{runId: base.runId, sourceIds: [...base.sourceIds]}, ...('additional' in base ? base.additional ?? [] : []).map(item => ({runId: item.runId, sourceIds: [...item.sourceIds]}))];
            if (append) {
                const selection = selections.find(item => item.runId === runId);
                if (selection) selection.sourceIds = [...new Set([...selection.sourceIds, ...sourceIds])];
                else selections.push({runId, sourceIds: [...sourceIds]});
            }
            const receipt = await this.sessionMemory.bind(session, operationId, expectedRevision,
                {owner, dream, runId: selections[0].runId, sourceIds: selections[0].sourceIds, configRevision: config.revision,
                    ...(selections.length > 1 ? {additional: selections.slice(1)} : {})});
            log.info('dream.session.bind', {operationId, stage, result: 'success', count: sourceIds.length, durationMs: Date.now() - started}); return receipt;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SESSION_BIND_FAILED';
            log.warn('dream.session.bind', {operationId: /^[a-zA-Z0-9_-]{1,128}$/.test(operationId) ? operationId : 'invalid', stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    async retrieveSessionMemory(session: string, limit: number, tokenBudget?: number) {
        const started = Date.now(), operationId = 'dream-retrieve-' + sha256HexSync(session);
        try {
            if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('DREAM_SESSION_INVALID');
            if (!limit) return [];
            const binding = await this.sessionMemory.read(session);
            if (binding && 'disabled' in binding) return [];
            const active = await this.retrieveActiveSessionMemory(session, limit, tokenBudget);
            if (active !== null) return JSON.stringify(await this.sessionMemory.read(session)) === JSON.stringify(binding) ? active : [];
            if (!binding) return [];
            await this.assertSessionOwner(binding.owner, session);
            const config = await this.configs.read(binding.owner, binding.dream);
            if (!config?.config.enabled || config.revision !== binding.configRevision) return [];
            const findings = [];
            for (const selection of [{runId: binding.runId, sourceIds: binding.sourceIds}, ...binding.additional ?? []]) {
                const view = await this.readRun(binding.owner, binding.dream, selection.runId);
                findings.push(...(view?.findings ?? []).filter(finding => selection.sourceIds.includes(finding.sourceId)
                    && finding.state === 'active' && finding.kind !== 'suggestion').map(finding => ({runId: selection.runId, finding})));
            }
            const allowed = new Map<string, typeof findings[number]['finding']>();
            for (const selection of [{runId: binding.runId, sourceIds: binding.sourceIds}, ...binding.additional ?? []]) {
                const view = await this.readRun(binding.owner, binding.dream, selection.runId);
                for (const finding of view?.findings ?? []) if (selection.sourceIds.includes(finding.sourceId) && finding.state === 'active' && finding.kind !== 'suggestion')
                    allowed.set(JSON.stringify([selection.runId, finding.id]), finding);
            }
            await this.evidence.checkConfig(binding.owner, binding.dream, binding.configRevision);
            await this.assertSessionOwner(binding.owner, session);
            const current = await this.sessionMemory.read(session);
            if (!current || 'disabled' in current || JSON.stringify(current) !== JSON.stringify(binding)) return [];
            const unique = [], groups = new Set<string>();
            for (const entry of findings) {
                const finding = allowed.get(JSON.stringify([entry.runId, entry.finding.id])); if (!finding) continue;
                const group = await this.evidence.mergeGroup(binding.owner, binding.dream, finding);
                if (group && groups.has(group)) continue;
                if (group) groups.add(group);
                unique.push(finding);
                if (unique.length >= Math.min(limit, 20)) break;
            }
            const entries = unique.map(finding => {
                const content = JSON.stringify({kind: finding.kind, content: finding.content, quote: finding.quote, project: finding.project, eventTime: finding.eventTime});
                return {entryId: finding.id, namespaceId: `dream:${binding.owner}:${binding.dream}`, content, contentHash: sha256HexSync(content)};
            });
            log.info('dream.session.retrieve', {operationId, stage: 'complete', result: 'success', count: entries.length, durationMs: Date.now() - started}); return entries;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SESSION_RETRIEVAL_FAILED';
            log.warn('dream.session.retrieve', {operationId, stage: 'authorize', result: 'failure', code, durationMs: Date.now() - started}); return [];
        }
    }
    async searchSessionMemory(session: string, query: string, entryId?: string, namespaceId?: string) {
        if (typeof query !== 'string' || query.length > 500 || entryId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entryId))
            throw new Error('DREAM_SEARCH_INVALID');
        const binding = await this.sessionMemory.read(session);
        if (binding && 'disabled' in binding) return [];
        const items = await this.retrieveActiveSessionMemory(session, 50, 262144, query, entryId, namespaceId);
        if (JSON.stringify(await this.sessionMemory.read(session)) !== JSON.stringify(binding)) return [];
        return items ?? [];
    }
    private async retrieveActiveSessionMemory(session: string, limit: number, tokenBudget?: number, query?: string, entryId?: string, namespaceId?: string) {
        const manifest = await this.options.repository.getManifest(session);
        const project = manifest.folder ? await this.options.projects.forFolder(manifest.folder) : undefined;
        if (!project) return null;
        const owner = project.project.id, dreams = await this.list(owner);
        const configurations = await Promise.all(dreams.items.map(async item => ({item, config: await this.configs.read(owner, item.id)})));
        const entries: Array<{entryId: string; namespaceId: string; content: string; contentHash: string}> = [];
        const hotload: DreamHotloadItem[] = [];
        const checks: Array<{dream: string; revision: number; version: string}> = [];
        const requested = query === undefined ? Math.max(0, ...configurations.map(({config}) => config?.config.enabled && config.config.consolidation
            ? config.config.consolidation.hotLoadTokens ?? 1500 : 0)) : 262144;
        const hostLimit = query === undefined ? this.options.hotLoadTokenLimit ?? 100000 : 262144;
        let configured = false, remaining = Number.isSafeInteger(hostLimit) && hostLimit >= 0 ? Math.min(requested, hostLimit) : 0;
        if (tokenBudget !== undefined) remaining = Number.isSafeInteger(tokenBudget) && tokenBudget >= 0 ? Math.min(remaining, tokenBudget) : 0;
        for (const {item, config} of configurations) {
            if (!config?.config.enabled || !config.config.consolidation) continue;
            if (namespaceId !== undefined && namespaceId !== `dream:${owner}:${item.id}`) continue;
            configured = true;
            try {
                const candidate = await this.evidence.activeMemory(owner, item.id,
                    scopes => this.authorizeSessionScopes(owner, item.id, config.revision, scopes, session));
                if (candidate) checks.push({dream: item.id, revision: config.revision, version: candidate.version});
                for (const topic of [...candidate?.topics ?? []].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
                    if (entryId !== undefined && topic.id !== entryId || query !== undefined
                        && !topic.content.toLowerCase().includes(query.toLowerCase()) && !(topic.title ?? '').toLowerCase().includes(query.toLowerCase())) continue;
                    const namespaceId = `dream:${owner}:${item.id}`, content = topic.content;
                    if (query === undefined) hotload.push({namespaceId, topic, budget: config.config.consolidation.hotLoadTokens ?? 1500});
                    else {
                        const cost = new TextEncoder().encode(`Memory (${namespaceId}/${topic.id}):\n${content}`).byteLength;
                        if (entries.length < limit && cost <= remaining) {
                            entries.push({entryId: topic.id, namespaceId, content, contentHash: sha256HexSync(content)}); remaining -= cost;
                        }
                    }
                }
            } catch (error) {
                log.warn('dream.session.active', {operationId: 'dream-retrieve-' + sha256HexSync(session), stage: 'authorize', result: 'failure',
                    code: error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SESSION_RETRIEVAL_FAILED', durationMs: 0});
            }
        }
        for (const check of checks) {
            const current = await this.evidence.activeMemory(owner, check.dream,
                scopes => this.authorizeSessionScopes(owner, check.dream, check.revision, scopes, session));
            if (current?.version !== check.version) throw new Error('DREAM_VERSION_CONFLICT');
        }
        await this.assertSessionOwner(owner, session);
        return configured ? query === undefined ? assembleDreamHotload(owner, hotload, limit, remaining) : entries : null;
    }
    private async authorizeSessionScopes(owner: string, dream: string, revision: number, scopes: readonly string[], session: string) {
        let foreign = false;
        for (const scope of scopes) {
            const watermark = await this.evidence.watermark(owner, dream, scope);
            if (!watermark) throw new Error('DREAM_SESSION_SCOPE_CHANGED');
            if (watermark.projectId !== owner) foreign = true;
        }
        if (foreign) await this.authorizeJointSession(owner, dream, revision, scopes, session);
        await this.authorizeConsolidationScopes(owner, dream, revision, scopes);
    }
    private async authorizeJointSession(owner: string, dream: string, revision: number, scopes: readonly string[], session: string): Promise<void> {
        const binding = await this.sessionMemory.read(session);
        if (!binding || 'disabled' in binding || binding.owner !== owner || binding.dream !== dream || binding.configRevision !== revision)
            throw new Error('DREAM_SESSION_SCOPE_CHANGED');
        await this.assertSessionOwner(owner, session);
        const selections = [{runId: binding.runId, sourceIds: binding.sourceIds}, ...binding.additional ?? []];
        const covered = new Set<string>();
        for (const selection of selections) {
            const needed = selection.sourceIds.filter(source => scopes.includes(source));
            if (!needed.length) continue;
            const run = await this.readRun(owner, dream, selection.runId);
            for (const source of needed) if (run?.sources.some(item => item.status === 'available' && item.evidence.sourceId === source)) covered.add(source);
        }
        if (scopes.some(scope => !covered.has(scope)) || JSON.stringify(await this.sessionMemory.read(session)) !== JSON.stringify(binding))
            throw new Error('DREAM_SESSION_SCOPE_CHANGED');
        await this.assertSessionOwner(owner, session);
    }
    private async assertSessionOwner(owner: string, session: string): Promise<void> {
        await this.options.authorizeOwner(owner);
        const manifest = await this.options.repository.getManifest(session);
        const project = manifest.folder ? await this.options.projects.forFolder(manifest.folder) : undefined;
        if (!project || project.project.id !== owner) throw new Error('DREAM_SESSION_SCOPE_CHANGED');
    }
    private async authorizeMemory(owner: string, dream: string, config: DreamConfig, sourceId: string) {
        await this.options.authorizeOwner(owner);
        const file = config.files.find(item => item.id === sourceId), watermark = await this.evidence.watermark(owner, dream, sourceId);
        if (!file || !watermark || watermark.projectId !== file.projectId || watermark.connectionId !== file.connectionId)
            throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const current = await this.sourceAuthorization.authorizeDreamSource(file.projectId, file.connectionId, file.capability);
        if (!sameAuthority(current, watermark.authority)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
    }
    async setModelConnection(owner: string, dream: string, connectionId: string) {
        const started = Date.now(), operationId = 'dream-model-' + sha256HexSync(JSON.stringify([owner, dream, connectionId]));
        try {
            const twin = (await this.open(owner, dream)).twin, settings = await twin.getSettings();
            if (settings.data.connectionId !== connectionId) {
                if (settings.data.connectionId) throw new Error('DREAM_MODEL_CONNECTION_CONFLICT');
                await twin.configure({connectionId}, settings.revision);
            }
            await this.options.authorizeOwner(owner);
            log.info('dream.model.configure', {operationId, stage: 'configure', result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = error instanceof Error && /^(DREAM|TWIN)_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_MODEL_CONFIGURATION_FAILED';
            log.warn('dream.model.configure', {operationId, stage: 'configure', result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    async configure(owner: string, dream: string, operationId: string, expectedRevision: number, config: DreamConfig) {
        const frozen = validateDreamConfig(config), entry = await this.open(owner, dream);
        if (frozen.consolidation && !(await entry.twin.scannerTargets()).some(item => item.target.kind === frozen.consolidation!.target.kind
            && item.target.id === frozen.consolidation!.target.id && item.target.version === frozen.consolidation!.target.version
            && item.target.digest === frozen.consolidation!.target.digest)) throw new Error('DREAM_CONSOLIDATION_TARGET_INVALID');
        const reader = new NestosTwinSourceReader(entry.fs, this.options.repository, this.options.projects);
        for (const file of frozen.files) {
            const port = dreamProjectFilePort(this.sourceAuthorization, file, reader);
            const source = {id: file.id, projectId: file.projectId, connectionId: file.connectionId, cursor: null};
            await validateDreamTwinFilePlan({ownerProjectId: owner, dreamId: dream, operationId, planId: file.planId,
                planRevision: file.planRevision, twinSourceId: file.twinSourceId, target: port.target(source), source}, entry.twin, port);
        }
        return this.configs.save(owner, dream, operationId, expectedRevision, frozen, {owner: () => this.options.authorizeOwner(owner),
            source: async file => {await this.sourceAuthorization.authorizeDreamSource(file.projectId, file.connectionId, file.capability);}});
    }
    async setEnabled(owner: string, dream: string, operationId: string, expectedRevision: number, enabled: boolean) {
        if (typeof enabled !== 'boolean') throw new Error('DREAM_CONFIG_INVALID');
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
        const config = {...base.config, enabled};
        return this.configs.save(owner, dream, operationId, expectedRevision, config,
            {owner: () => this.options.authorizeOwner(owner), source: async () => {}});
    }
    async configureSchedule(owner: string, dream: string, operationId: string, expectedRevision: number,
        schedule: import('@nestos/kanban/contracts').KanbanRecurrence | null) {
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
        const {schedule: _previous, ...rest} = base.config;
        const config = await this.configs.save(owner, dream, operationId, expectedRevision, {...rest, ...(schedule ? {schedule} : {})},
            {owner: () => this.options.authorizeOwner(owner), source: async () => {}});
        if (!this.schedules) return {config, activation: 'pending' as const, code: 'DREAM_SCHEDULE_UNAVAILABLE'};
        try {await this.schedules.reconcile(owner, dream); return {config, activation: 'ready' as const};}
        catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCHEDULE_RECONCILE_FAILED';
            return {config, activation: 'pending' as const, code};
        }
    }
    async removeFile(owner: string, dream: string, operationId: string, expectedRevision: number, sourceId: string) {
        await this.options.authorizeOwner(owner);
        const base = await this.configs.readRevision(owner, dream, expectedRevision);
        if (!base || !base.config.files.some(file => file.id === sourceId)) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        return this.configs.save(owner, dream, operationId, expectedRevision,
            {...base.config, files: base.config.files.filter(file => file.id !== sourceId)},
            {owner: () => this.options.authorizeOwner(owner), source: async () => {}});
    }
    async addFile(owner: string, dream: string, operationId: string, expectedRevision: number, selection: DreamFileSelection) {
        const started = Date.now(); let stage = 'authorize';
        try {
            selection = structuredClone(selection);
            await this.options.authorizeOwner(owner);
            const authority = await this.sourceAuthorization.authorizeDreamSource(selection.projectId, selection.connectionId, 'fileRead');
            const base = await this.configs.readRevision(owner, dream, expectedRevision);
            if (!base) throw new Error('DREAM_CONFIG_CONFLICT');
            stage = 'reserve';
            const intent = await this.configs.reserveFile(owner, dream, operationId, expectedRevision, sha256HexSync(JSON.stringify(selection)));
            const file = {id: intent.id, projectId: selection.projectId, connectionId: selection.connectionId, path: selection.path,
                capability: 'fileRead' as const, planId: intent.planId, planRevision: 'pending', twinSourceId: intent.sourceId};
            validateDreamConfig({...base.config, files: [...base.config.files, file]});
            const entry = await this.open(owner, dream);
            const reader = new NestosTwinSourceReader(entry.fs, this.options.repository, this.options.projects);
            const port = dreamProjectFilePort(this.sourceAuthorization, file, reader);
            const target = port.target({...file, cursor: null});
            stage = 'scanner';
            const plan = await entry.twin.ensureBoundScanner({sourceId: intent.sourceId, planId: intent.planId,
                spec: {kind: 'file', target, label: ''}, executor: selection.executor, name: 'Dream', kinds: ['fact'],
                maxOutputTokens: selection.maxOutputTokens, runTokenLimit: selection.runTokenLimit});
            await this.options.authorizeOwner(owner);
            if (!sameAuthority(authority, await this.sourceAuthorization.authorizeDreamSource(selection.projectId, selection.connectionId, 'fileRead')))
                throw new Error('DREAM_AUTHORIZATION_CHANGED');
            stage = 'commit';
            const result = await this.configure(owner, dream, operationId, expectedRevision,
                {...base.config, files: [...base.config.files, {...file, planRevision: plan.planRevision}]});
            log.info('dream.file.add', {operationId, stage, result: 'success', durationMs: Date.now() - started});
            return {sourceId: intent.id, config: result};
        } catch (error) {
            const code = stage === 'scanner' && (error as {code?: unknown} | null)?.code === 'ENOENT'
                && error instanceof Error && error.message.endsWith('Twin source missing') ? 'DREAM_SOURCE_NOT_FOUND'
                : error instanceof Error && /^(DREAM|TWIN)_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_FILE_ADD_FAILED';
            log.warn('dream.file.add', {operationId: /^[a-zA-Z0-9_-]{1,128}$/.test(operationId) ? operationId : 'invalid', stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    async run(input: ConfiguredDreamRequest): Promise<void> {
        await this.scanConfigured(input);
        const config = await this.configs.read(input.ownerProjectId, input.dreamId);
        if (config?.config.consolidation) await this.consolidateRun(input, config);
    }
    private async scanConfigured(input: ConfiguredDreamRequest): Promise<void> {
        const entry = await this.open(input.ownerProjectId, input.dreamId);
        const config = await this.configs.read(input.ownerProjectId, input.dreamId);
        const selected = config?.config.decisions?.find(source => source.id === input.sourceId) ?? config?.config.tasks?.find(source => source.id === input.sourceId) ?? config?.config.sessions?.find(source => source.id === input.sourceId) ?? config?.config.changes?.find(source => source.id === input.sourceId);
        if (selected && config) await this.runSummary(input, entry, config, selected);
        else if (config?.config.adoptions?.some(source => source.id === input.sourceId)) await this.runAdoption(input, entry, config);
        else await runConfiguredDreamFile(input, {configs: this.configs, evidence: this.evidence, registry: this.registry,
            twin: entry.twin, kernel: this.options.kernel, remote: this.sourceAuthorization,
            reader: new NestosTwinSourceReader(entry.fs, this.options.repository, this.options.projects), authorizeOwner: this.options.authorizeOwner});
    }

    private async consolidateRun(input: ConfiguredDreamRequest, config: import('./config-store').DreamConfigRecord): Promise<void> {
        const {ownerProjectId: owner, dreamId: dream, sourceId} = input;
        const evidence = await this.evidence.readCapturedOperation(owner, dream, input.operationId, async captured => {
            if (captured.sourceId !== sourceId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            return this.authorizeConsolidationSource(owner, dream, config.revision, sourceId);
        });
        if (!evidence) return;
        if (sha256HexSync(evidence.snapshot) !== evidence.fingerprint) throw new Error('DREAM_CAPTURE_INVALID');
        const watermark = await this.evidence.watermark(owner, dream, sourceId);
        if (!watermark) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const authorize = (scopes: readonly string[]) => this.authorizeConsolidationScopes(owner, dream, config.revision, scopes);
        const model = new PublishedConsolidationModel({fs: this.options.fs, path: this.evidence.consolidationPath(owner, dream),
            target: config.config.consolidation!.target, repository: this.options.repository, calls: this.options.calls, kernel: this.options.kernel,
            authorize, bindSession: (sessionId, scopes) => this.registry.bind(sessionId, {ownerProjectId: owner, dreamId: dream,
                sourceId, configRevision: config.revision, authority: watermark.authority, consolidationScopes: [...scopes]})});
        const service = this.evidence.consolidation(owner, dream, model, {evidence: captured => {
            if (captured.sourceId !== sourceId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            return this.authorizeConsolidationSource(owner, dream, config.revision, sourceId);
        }, evidenceScope: captured => captured.sourceId, scopes: authorize}, config.revision);
        const sources = [...config.config.files, ...config.config.decisions ?? [], ...config.config.tasks ?? [],
            ...config.config.sessions ?? [], ...config.config.changes ?? []];
        const permittedScopes = [...new Set([sourceId, ...sources.filter(source => source.projectId === evidence.projectId).map(source => source.id)])].sort();
        await service.run({operationId: 'consolidate-' + sha256HexSync(JSON.stringify([owner, dream, input.operationId, config.revision])),
            captureOperationId: input.operationId, scope: evidence.projectId, scopes: [sourceId], permittedScopes,
            ...(config.config.consolidation!.focus !== undefined ? {focus: config.config.consolidation!.focus} : {})});
    }

    private async authorizeConsolidationScopes(owner: string, dream: string, revision: number, scopes: readonly string[]): Promise<void> {
        await this.options.authorizeOwner(owner);
        for (const sourceId of scopes) await this.authorizeConsolidationSource(owner, dream, revision, sourceId);
        await this.evidence.checkConfig(owner, dream, revision);
        await this.options.authorizeOwner(owner);
    }

    private async authorizeConsolidationSource(owner: string, dream: string, revision: number, sourceId: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream), watermark = await this.evidence.watermark(owner, dream, sourceId);
        if (!config?.config.enabled || config.revision !== revision || !watermark) throw new Error('DREAM_CONFIG_CONFLICT');
        const file = config.config.files.find(item => item.id === sourceId);
        const current = file ? await this.sourceAuthorization.authorizeDreamSource(file.projectId, file.connectionId, file.capability)
            : await this.adoptionBinding({ownerProjectId: owner, dreamId: dream, sourceId, configRevision: revision,
                authority: watermark.authority, adoptionPlanRevision: 'consolidation'});
        if (file && (file.projectId !== watermark.projectId || file.connectionId !== watermark.connectionId)
            || !sameSourceIdentity(current, watermark.authority)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        await this.evidence.checkConfig(owner, dream, revision);
        await this.options.authorizeOwner(owner);
        return watermark.authority;
    }

    async pendingConsolidation(owner: string, dream: string, scope: string, after?: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const result = await this.evidence.pendingProposals(owner, dream, scope, after, async scopes => {
            try {await this.authorizeConsolidationScopes(owner, dream, config.revision, scopes); return true;}
            catch (error) {
                if (error instanceof Error && ['DREAM_AUTHORIZATION_DENIED', 'DREAM_AUTHORIZATION_CHANGED', 'DREAM_CONFIG_CONFLICT',
                    'DREAM_OWNER_AUTHORIZATION_FAILED', 'DREAM_SOURCE_NOT_CONFIGURED'].includes(error.message)) return false;
                throw error;
            }
        });
        await this.evidence.checkConfig(owner, dream, config.revision);
        await this.options.authorizeOwner(owner);
        return result;
    }

    async readProposalEvidence(owner: string, dream: string, proposalId: string, evidenceId: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const authorize = (scopes: readonly string[]) => this.authorizeConsolidationScopes(owner, dream, config.revision, scopes);
        const proposal = await this.evidence.proposal(owner, dream, proposalId, authorize);
        if (!proposal || !proposal.evidenceIds.includes(evidenceId)) throw new Error('DREAM_EVIDENCE_MISSING');
        const known = [...config.config.files.map(item => ({id: item.id, projectId: item.projectId, type: 'file'})),
            ...(config.config.changes ?? []).map(item => ({id: item.id, projectId: item.projectId, type: item.commits ? 'git' : 'change'})),
            ...(config.config.sessions ?? []).map(item => ({id: item.id, projectId: item.projectId, type: 'session'})),
            ...(config.config.tasks ?? []).map(item => ({id: item.id, projectId: item.projectId, type: 'other'})),
            ...(config.config.decisions ?? []).map(item => ({id: item.id, projectId: item.projectId, type: 'other'}))];
        for (const adoption of config.config.adoptions ?? []) {
            const watermark = await this.evidence.watermark(owner, dream, adoption.id);
            if (watermark) known.push({id: adoption.id, projectId: watermark.projectId, type: 'other'});
        }
        for (const source of known.filter(item => proposal.requiredScopes.includes(item.id))) {
            const captured = await this.evidence.readCapturedEvidenceById(owner, dream, [source.projectId, source.type, source.id], evidenceId,
                async item => {
                    const authority = await this.authorizeConsolidationSource(owner, dream, config.revision, item.sourceId);
                    if (!sameSourceIdentity(authority, item.authority)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
                    return item.authority;
                });
            if (captured) {
                if (sha256HexSync(captured.snapshot) !== captured.fingerprint) throw new Error('DREAM_CAPTURE_INVALID');
                await authorize(proposal.requiredScopes);
                if (JSON.stringify(await this.evidence.proposal(owner, dream, proposalId, authorize)) !== JSON.stringify(proposal))
                    throw new Error('DREAM_PROPOSAL_CONFLICT');
                return {id: captured.id, sourceId: captured.sourceId, locator: captured.locator, fingerprint: captured.fingerprint,
                    granularity: captured.granularity, snapshot: captured.snapshot};
            }
        }
        throw new Error('DREAM_EVIDENCE_MISSING');
    }

    async activeConsolidation(owner: string, dream: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const result = await this.evidence.activeMemory(owner, dream, scopes => this.authorizeConsolidationScopes(owner, dream, config.revision, scopes));
        await this.evidence.checkConfig(owner, dream, config.revision);
        await this.options.authorizeOwner(owner);
        return result;
    }

    async authorizeDownstream(owner: string, dream: string, scopes: readonly string[]): Promise<void> {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        await this.authorizeConsolidationScopes(owner, dream, config.revision, scopes);
    }
    async readDownstream(owner: string, dream: string, kind: 'daily' | 'kanban', commitId: string) {
        if (kind !== 'daily' && kind !== 'kanban') throw new Error('DREAM_OUTBOX_INVALID');
        await this.options.authorizeOwner(owner);
        return new DreamDownstream(this.options.fs, (project, id, scopes) => this.authorizeDownstream(project, id, scopes)).read(owner, dream, kind, commitId);
    }
    async readCommittedVersion(owner: string, dream: string, commitId: string) {
        await this.options.authorizeOwner(owner);
        const authorize = (scopes: readonly string[]) => this.authorizeDownstream(owner, dream, scopes);
        return this.evidence.committedMemory(owner, dream, commitId, authorize);
    }
    async listDownstream(owner: string, dream: string, kind: 'daily' | 'kanban', after?: string) {
        if (kind !== 'daily' && kind !== 'kanban') throw new Error('DREAM_OUTBOX_INVALID');
        await this.options.authorizeOwner(owner);
        return new DreamDownstream(this.options.fs, (project, id, scopes) => this.authorizeDownstream(project, id, scopes)).list(owner, dream, kind, after);
    }

    async reviewConsolidation(owner: string, dream: string, scope: string, after?: string) {
        const active = await this.activeConsolidation(owner, dream);
        const page = await this.pendingConsolidation(owner, dream, scope, after);
        const current = await this.activeConsolidation(owner, dream);
        if ((active?.version ?? null) !== (current?.version ?? null)) throw new Error('DREAM_VERSION_CONFLICT');
        return {page, version: current?.version ?? null, topics: (current?.topics ?? []).map(({id, kind, priority, updatedAt, title}) =>
            ({id, ...(kind !== undefined ? {kind} : {}), ...(priority !== undefined ? {priority} : {}),
                ...(updatedAt !== undefined ? {updatedAt} : {}), ...(title !== undefined ? {title} : {})}))};
    }

    async commitConsolidation(owner: string, dream: string, operationId: string, expectedVersion: string | null,
        selected: Array<{id: string; revision: number}>) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        return this.evidence.commitProposals(owner, dream, operationId, expectedVersion, selected, config.revision,
            scopes => this.authorizeConsolidationScopes(owner, dream, config.revision, scopes));
    }

    async rollbackConsolidation(owner: string, dream: string, operationId: string, targetCommitId: string, expectedVersion: string) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        return this.evidence.rollbackMemory(owner, dream, operationId, targetCommitId, expectedVersion, config.revision,
            scopes => this.authorizeConsolidationScopes(owner, dream, config.revision, scopes));
    }

    async resolveConsolidation(owner: string, dream: string, operationId: string, id: string, revision: number,
        resolution: import('@nestos/dream/vfs').ProposalResolution) {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream);
        if (!config?.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        return this.evidence.resolveProposal(owner, dream, operationId, id, revision, resolution, config.revision,
            scopes => this.authorizeConsolidationScopes(owner, dream, config.revision, scopes));
    }
    private async runSummary(input: ConfiguredDreamRequest, entry: Entry, config: import('./config-store').DreamConfigRecord,
        selected: import('./config-store').DreamDecisionSourceConfig | import('./config-store').DreamTaskSourceConfig | import('./config-store').DreamSessionSourceConfig | import('./config-store').DreamChangeSourceConfig) {
        if (!config.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const file = selected && config.config.files.find(item => item.id === selected.scannerSourceId);
        if (!selected || !file) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const oldPlan = (await entry.twin.dreamScanEvidence(input.operationId, file.planId, file.twinSourceId)).plan;
        if (!oldPlan || oldPlan.revision !== file.planRevision || !oldPlan.data.executor || !oldPlan.data.maxOutputTokens || !oldPlan.data.runTokenLimit)
            throw new Error('DREAM_SCAN_PLAN_CHANGED');
        const authorize = () => 'recordId' in selected ? this.authorizeDecision(selected) : 'itemId' in selected ? this.authorizeTask(selected) : 'directory' in selected ? this.authorizeChange(selected) : this.authorizeSessionSource(selected);
        await authorize();
        const ids = adoptionScannerIds(input.ownerProjectId, input.dreamId, input.sourceId);
        const plan = await entry.twin.ensureBoundScanner({sourceId: ids.twinSourceId, planId: ids.planId,
            spec: {kind: 'managed-artifact', target: selected.id, label: ''}, executor: oldPlan.data.executor,
            name: 'Dream', kinds: ['fact'], maxOutputTokens: oldPlan.data.maxOutputTokens, runTokenLimit: oldPlan.data.runTokenLimit});
        const sourcePort = 'recordId' in selected ? this.decisionPort(selected) : 'itemId' in selected ? this.taskPort(selected) : 'directory' in selected ? this.changePort(selected) : this.sessionPort(selected);
        const port = {...sourcePort, target: (source: import('@nestos/dream').DreamSource) => {
            if (source.id !== selected.id) throw new Error('DREAM_SOURCE_BINDING_CHANGED'); return selected.id;
        }};
        const base = {id: selected.id, projectId: selected.projectId, connectionId: selected.connectionId, cursor: null};
        const authority = await authorize(), watermark = await this.evidence.watermark(input.ownerProjectId, input.dreamId, input.sourceId);
        if (watermark && (watermark.projectId !== base.projectId || watermark.connectionId !== base.connectionId || !sameAuthority(watermark.authority, authority))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const previous = await this.evidence.run(input.ownerProjectId, input.dreamId, input.operationId), outcome = previous?.outcomes[0];
        if (previous && (previous.outcomes.length !== 1 || outcome?.status !== 'ok' || outcome.evidence.sourceId !== input.sourceId)) throw new Error('DREAM_OPERATION_CONFLICT');
        const captured = previous ? null : await this.evidence.readCapturedOperation(input.ownerProjectId, input.dreamId, input.operationId, async evidence => {
            if (evidence.projectId !== base.projectId || evidence.sourceId !== base.id || evidence.connectionId !== base.connectionId
                || evidence.locator !== port.target(base)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            return port.authorize(base);
        });
        const latest = !previous && !captured ? await this.latestCapturedForSource(input, base, port) : null;
        const source = {...base, cursor: outcome?.status === 'ok' ? outcome.evidence.startCursor
            : captured?.startCursor !== undefined ? captured.startCursor : latest?.endCursor !== undefined ? latest.endCursor : watermark?.cursor ?? null};
        return runDreamTwinFileScan({...input, planId: plan.planId, planRevision: plan.planRevision, twinSourceId: plan.sourceId,
            target: selected.id, sourceKind: 'managed-artifact', evidenceSourceType: 'directory' in selected ? (selected.commits ? 'git' : 'change') : 'sessionId' in selected ? 'session' : 'other',
            source, configRevision: config.revision}, entry.twin, port,
            this.evidence, this.options.kernel, () => this.options.authorizeOwner(input.ownerProjectId),
            (runId, proof, retryPlan) => this.registry.bindRun(runId, {ownerProjectId: input.ownerProjectId, dreamId: input.dreamId,
                sourceId: input.sourceId, configRevision: config.revision, authority: proof, adoptionPlanRevision: plan.planRevision, ...(retryPlan ? {retryPlan} : {})}));
    }
    private async runAdoption(input: ConfiguredDreamRequest, entry: Entry, config: import('./config-store').DreamConfigRecord) {
        if (!config.config.enabled) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const selected = config.config.adoptions?.find(source => source.id === input.sourceId);
        if (!selected) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const request = await this.authorizeConfiguredAdoption(input.ownerProjectId, input.dreamId, selected);
        const original = await this.readRun(input.ownerProjectId, input.dreamId, request.runId);
        const finding = original?.findings.find(item => item.id === request.suggestionId);
        const file = config.config.files.find(item => item.id === finding?.sourceId);
        if (!file) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const originalPlan = (await entry.twin.dreamScanEvidence(input.operationId, file.planId, file.twinSourceId)).plan;
        if (!originalPlan || originalPlan.revision !== file.planRevision || !originalPlan.data.executor
            || !originalPlan.data.maxOutputTokens || !originalPlan.data.runTokenLimit) throw new Error('DREAM_SCAN_PLAN_CHANGED');
        const ids = adoptionScannerIds(input.ownerProjectId, input.dreamId, input.sourceId);
        const plan = await entry.twin.ensureBoundScanner({sourceId: ids.twinSourceId, planId: ids.planId,
            spec: {kind: 'managed-artifact', target: input.sourceId, label: ''}, executor: originalPlan.data.executor,
            name: 'Dream', kinds: ['fact'], maxOutputTokens: originalPlan.data.maxOutputTokens, runTokenLimit: originalPlan.data.runTokenLimit});
        const port = adoptionTwinScanPort(input.sourceId, await this.configuredAdoptionPort(input.ownerProjectId, input.dreamId, input.sourceId, request));
        const base = {id: input.sourceId, projectId: request.targetProjectId, connectionId: 'kanban-adoption', cursor: null};
        const authority = await port.authorize(base), watermark = await this.evidence.watermark(input.ownerProjectId, input.dreamId, input.sourceId);
        if (watermark && (watermark.projectId !== base.projectId || watermark.connectionId !== base.connectionId || !sameAuthority(watermark.authority, authority)))
            throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const previous = await this.evidence.run(input.ownerProjectId, input.dreamId, input.operationId), outcome = previous?.outcomes[0];
        if (previous && (previous.outcomes.length !== 1 || outcome?.status !== 'ok' || outcome.evidence.sourceId !== input.sourceId)) throw new Error('DREAM_OPERATION_CONFLICT');
        const captured = previous ? null : await this.evidence.readCapturedOperation(input.ownerProjectId, input.dreamId, input.operationId, async evidence => {
            if (evidence.projectId !== base.projectId || evidence.sourceId !== base.id || evidence.connectionId !== base.connectionId
                || evidence.locator !== port.target(base)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            return port.authorize(base);
        });
        const latest = !previous && !captured ? await this.latestCapturedForSource(input, base, port) : null;
        const source = {...base, cursor: outcome?.status === 'ok' ? outcome.evidence.startCursor
            : captured?.startCursor !== undefined ? captured.startCursor : latest?.endCursor !== undefined ? latest.endCursor : watermark?.cursor ?? null};
        return runDreamTwinFileScan({...input, planId: plan.planId, planRevision: plan.planRevision, twinSourceId: plan.sourceId,
            target: input.sourceId, sourceKind: 'managed-artifact', source, configRevision: config.revision}, entry.twin, port,
            this.evidence, this.options.kernel, () => this.options.authorizeOwner(input.ownerProjectId),
            (runId, proof, retryPlan) => this.registry.bindRun(runId, {ownerProjectId: input.ownerProjectId, dreamId: input.dreamId,
                sourceId: input.sourceId, configRevision: config.revision, authority: proof, adoptionPlanRevision: plan.planRevision, ...(retryPlan ? {retryPlan} : {})}));
    }
    private async latestCapturedForSource(input: ConfiguredDreamRequest, source: import('@nestos/dream').DreamSource,
        port: import('./project-file-source').DreamProjectFilePort) {
        const operation = await this.evidence.latestCapturedOperation(input.ownerProjectId, input.dreamId, input.sourceId);
        if (!operation) return null;
        return this.evidence.readCapturedOperation(input.ownerProjectId, input.dreamId, operation, async evidence => {
            if (evidence.projectId !== source.projectId || evidence.sourceId !== source.id || evidence.connectionId !== source.connectionId
                || evidence.locator !== port.target(source)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            return port.authorize(source);
        });
    }
    async runAll(owner: string, dream: string, operationId: string, configRevision: number, sourceIds?: string[]) {
        const started = Date.now();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(operationId)) throw new Error('DREAM_INVALID_OPERATION');
        await this.options.authorizeOwner(owner);
        const current = await this.configs.read(owner, dream);
        if (!current || current.revision !== configRevision || !current.config.enabled) throw new Error('DREAM_CONFIG_CONFLICT');
        const {files, adoptions, decisions, tasks, sessions, changes} = current.config;
        const available = [...files, ...adoptions ?? [], ...decisions ?? [], ...tasks ?? [], ...sessions ?? [], ...changes ?? []].map(source => source.id);
        const selected = this.batchSources(available, operationId, started, sourceIds);
        await this.configs.reserveBatch(owner, dream, operationId, configRevision, sourceIds === undefined ? undefined : selected);
        const gaps = current.config.consolidation ? await this.retryBatchGaps(owner, dream, operationId, current, selected) : [];
        const results: DreamBatchResult[] = [];
        for (const sourceId of selected) results.push(await this.runBatchSource(owner, dream, operationId, configRevision, sourceId, !!current.config.consolidation));
        if (current.config.consolidation) await this.consolidateBatch(owner, dream, operationId, current, [...gaps, ...results]);
        await this.options.authorizeOwner(owner); await this.evidence.checkConfig(owner, dream, configRevision);
        log.info('dream.scan.batch', {operationId, stage: 'complete', result: 'success', count: results.length,
            failed: results.filter(item => item.status === 'failed').length, durationMs: Date.now() - started});
        return {configRevision, results};
    }
    private async retryBatchGaps(owner: string, dream: string, batch: string, config: import('./config-store').DreamConfigRecord, selected: string[]): Promise<DreamBatchResult[]> {
        const started = Date.now();
        const entries = await Promise.all(selected.map(async sourceId => {
            try {
            const id = await this.evidence.latestCapturedOperation(owner, dream, sourceId);
            if (!id) return null;
            const authorize = async (evidence: import('@nestos/dream/vfs').CapturedEvidence) => {
                if (evidence.sourceId !== sourceId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                await authorizeDreamExecution('dream-gap', {ownerProjectId: owner, dreamId: dream, sourceId, configRevision: config.revision,
                    authority: evidence.authority, adoptionPlanRevision: 'gap'}, this.configs, this.sourceAuthorization,
                    this.options.authorizeOwner, binding => this.adoptionBinding(binding));
                return evidence.authority;
            };
            const evidence = await this.evidence.readCapturedOperation(owner, dream, id, authorize);
            return evidence ? {sourceId, evidence, authorize} : null;
            } catch (error) {
                const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                log.warn('dream.scan.gap', {operationId: batch, stage: 'authorize', result: 'failure', code, sourceId, durationMs: Date.now() - started});
                return null;
            }
        }));
        const available = entries.filter((entry): entry is NonNullable<typeof entry> => !!entry);
        if (config.config.consolidation!.crossProject && (config.config.adoptions ?? []).some(item => selected.includes(item.id)
            && !available.some(entry => entry.sourceId === item.id))) return [];
        const configured = [...config.config.files, ...config.config.decisions ?? [], ...config.config.tasks ?? [],
            ...config.config.sessions ?? [], ...config.config.changes ?? []].filter(item => selected.includes(item.id));
        const projects = [...new Set([...available.map(entry => entry.evidence.projectId), ...configured.map(item => item.projectId)])].sort();
        const rows: DreamBatchResult[] = [];
        for (const entry of available) {
            const scope = config.config.consolidation!.crossProject ? 'joint-' + sha256HexSync(JSON.stringify(projects)) : entry.evidence.projectId;
            const source: [string, string, string] = [entry.evidence.projectId, entry.evidence.sourceType, entry.sourceId];
            const watermark = await this.evidence.consolidationWatermark(owner, dream, scope, source);
            const pending = await this.evidence.pendingCapturedOperations(owner, dream, scope, source, watermark, 1, entry.authorize);
            for (const item of pending.items) {
                try {
                    await this.scanConfigured({ownerProjectId: owner, dreamId: dream, sourceId: entry.sourceId, operationId: item.operationId});
                    rows.push({sourceId: entry.sourceId, operationId: item.operationId, status: 'settled'});
                } catch (error) {
                    const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                    log.warn('dream.scan.gap', {operationId: batch, stage: 'retry', result: 'failure', code, sourceId: entry.sourceId, durationMs: Date.now() - started});
                }
            }
        }
        return rows;
    }
    private batchSources(available: string[], operationId: string, started: number, requested?: string[]): string[] {
        if (requested === undefined) return available;
        if (!Array.isArray(requested) || !requested.length || requested.length > 32
            || new Set(requested).size !== requested.length || requested.some(id => !available.includes(id))) {
            log.warn('dream.scan.batch', {operationId, stage: 'select-sources', result: 'failure',
                code: 'DREAM_BATCH_SELECTION_INVALID', durationMs: Date.now() - started});
            throw new Error('DREAM_BATCH_SELECTION_INVALID');
        }
        return available.filter(id => requested.includes(id));
    }
    private async consolidateBatch(owner: string, dream: string, batch: string, config: import('./config-store').DreamConfigRecord,
        results: DreamBatchResult[]): Promise<void> {
        const known: Array<{id: string; projectId: string}> = [...config.config.files, ...config.config.decisions ?? [], ...config.config.tasks ?? [],
            ...config.config.sessions ?? [], ...config.config.changes ?? []];
        for (const adoption of config.config.adoptions ?? []) if (results.some(row => row.sourceId === adoption.id)) {
            const watermark = await this.evidence.watermark(owner, dream, adoption.id);
            if (watermark) known.push({id: adoption.id, projectId: watermark.projectId});
        }
        const projectFor = (sourceId: string) => known.find(source => source.id === sourceId)?.projectId;
        const joint = config.config.consolidation!.crossProject === true;
        const projects = [...new Set(results.map(result => projectFor(result.sourceId)).filter((id): id is string => !!id))].sort();
        if (joint && (results.some(result => result.status === 'failed' || !projectFor(result.sourceId)) || !projects.length)) {
            for (const result of results) if (result.status === 'settled') Object.assign(result, {status: 'failed', code: 'DREAM_BATCH_INCOMPLETE'});
            return;
        }
        const groups = new Map<string, DreamBatchResult[]>();
        for (const result of results.filter(item => item.status === 'settled')) {
            const project = projectFor(result.sourceId);
            if (!project) {Object.assign(result, {status: 'failed', code: 'DREAM_SOURCE_NOT_CONFIGURED'}); continue;}
            const group = joint ? 'joint-' + sha256HexSync(JSON.stringify(projects)) : project;
            groups.set(group, [...groups.get(group) ?? [], result]);
        }
        for (const [scope, rows] of groups) {
            const started = Date.now();
            try {
                await this.consolidateBatchGroup(owner, dream, batch, config, scope, rows, joint ? projects : [scope], known);
                log.info('dream.consolidation.batch', {operationId: batch, stage: 'settle', result: 'success', count: rows.length, durationMs: Date.now() - started});
            }
            catch (error) {
                const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_CONSOLIDATION_FAILED';
                log.warn('dream.consolidation.batch', {operationId: batch, stage: 'settle', result: 'failure', code, count: rows.length, durationMs: Date.now() - started});
                for (const row of rows) Object.assign(row, {status: 'failed', code});
            }
        }
    }
    private async consolidateBatchGroup(owner: string, dream: string, batch: string, config: import('./config-store').DreamConfigRecord,
        scope: string, rows: DreamBatchResult[], projects: string[], known: Array<{id: string; projectId: string}>,
        recompute?: {receiptScope: string; expectedVersion: string | null}): Promise<void> {
        const selected = new Set(rows.map(row => row.sourceId));
        const permittedScopes = known.filter(source => projects.includes(source.projectId)).map(source => source.id).sort();
        const participants = config.config.consolidation!.crossProject ? projects.map(project => {
            const source = known.find(item => item.projectId === project && selected.has(item.id));
            if (!source) throw new Error('DREAM_SOURCE_NOT_CONFIGURED'); return source.id;
        }) : [];
        const captured: DreamBatchResult[] = [];
        for (const row of rows) {
            const evidence = await this.evidence.readCapturedOperation(owner, dream, row.operationId, async item => {
                if (item.sourceId !== row.sourceId || !projects.includes(item.projectId)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                return this.authorizeConsolidationSource(owner, dream, config.revision, item.sourceId);
            });
            if (!evidence && recompute) throw new Error('DREAM_EVIDENCE_MISSING');
            if (evidence && sha256HexSync(evidence.snapshot) !== evidence.fingerprint) throw new Error('DREAM_CAPTURE_INVALID');
            if (evidence) captured.push(row);
        }
        if (!captured.length) return;
        const sourceId = captured[0].sourceId, watermark = await this.evidence.watermark(owner, dream, sourceId);
        if (!watermark) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const authorize = async (scopes: readonly string[]) => {
            for (const participant of participants) await this.authorizeConsolidationSource(owner, dream, config.revision, participant);
            await this.authorizeConsolidationScopes(owner, dream, config.revision, scopes);
        };
        const model = new PublishedConsolidationModel({fs: this.options.fs, path: this.evidence.consolidationPath(owner, dream),
            target: config.config.consolidation!.target, repository: this.options.repository, calls: this.options.calls, kernel: this.options.kernel,
            authorize, bindSession: (sessionId, scopes) => this.registry.bind(sessionId, {ownerProjectId: owner, dreamId: dream,
                sourceId, configRevision: config.revision, authority: watermark.authority, consolidationScopes: [...new Set([...scopes, ...participants])].sort()})});
        const service = this.evidence.consolidation(owner, dream, model, {evidence: item => {
            if (!selected.has(item.sourceId) || !projects.includes(item.projectId)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            return this.authorizeConsolidationSource(owner, dream, config.revision, item.sourceId);
        }, evidenceScope: item => item.sourceId, scopes: authorize}, config.revision);
        await service.runBatch({operationId: 'consolidate-' + sha256HexSync(JSON.stringify([owner, dream, batch, config.revision, scope])),
            captureOperationIds: captured.map(row => row.operationId), scope, permittedScopes,
            ...(recompute ? recompute : {}),
            ...(config.config.consolidation!.focus !== undefined ? {focus: config.config.consolidation!.focus} : {})});
    }

    async planRecomputation(owner: string, dream: string): Promise<DreamRecomputePlan[]> {
        await this.options.authorizeOwner(owner);
        const config = await this.configs.read(owner, dream), active = await this.evidence.activeMemoryScopes(owner, dream);
        if (!config?.config.enabled || !config.config.consolidation) return [];
        const restricted = [...active?.requiredScopes ?? [], ...(await this.evidence.pendingMemoryScopes(owner, dream)).flat()];
        if (!restricted.length) return [];
        const known = await this.recomputeSources(owner, dream, config.config);
        const available = new Map<string, boolean>();
        for (const id of new Set([...restricted, ...known.map(source => source.id)])) {
            if (!known.some(source => source.id === id)) {available.set(id, false); continue;}
            if (!await this.evidence.watermark(owner, dream, id)) {available.set(id, false); continue;}
            try {await this.authorizeConsolidationSource(owner, dream, config.revision, id); available.set(id, true);}
            catch (error) {if (!recomputeAccessDenied(error)) throw error; available.set(id, false);}
        }
        if (!restricted.some(id => !available.get(id))) return [];
        const groups = new Map<string, Array<{sourceId: string; operationId: string}>>();
        for (const source of known.filter(item => available.get(item.id))) {
            const operationId = await this.evidence.latestCapturedOperation(owner, dream, source.id);
            if (!operationId) continue;
            const evidence = await this.evidence.readCapturedOperation(owner, dream, operationId, item => {
                if (item.sourceId !== source.id || item.projectId !== source.projectId) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                return this.authorizeConsolidationSource(owner, dream, config.revision, source.id);
            });
            if (evidence && sha256HexSync(evidence.snapshot) !== evidence.fingerprint) throw new Error('DREAM_CAPTURE_INVALID');
            if (evidence) groups.set(source.projectId, [...groups.get(source.projectId) ?? [], {sourceId: source.id, operationId}]);
        }
        await this.evidence.checkConfig(owner, dream, config.revision); await this.options.authorizeOwner(owner);
        return [...groups].map(([project, sources]) => {
            sources.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
            const activeVersion = active?.version ?? null;
            const id = 'recompute-' + sha256HexSync(JSON.stringify([owner, dream, project, config.revision, activeVersion, sources]));
            return {owner, dream, project, configRevision: config.revision, activeVersion, sources, id};
        });
    }

    async recomputeCatalog(after?: string): Promise<{items: Array<{owner: string; dream: string}>; next?: string}> {
        const projects = (await this.options.projects.list()).map(item => item.project.id).sort();
        const page = projects.filter(id => after === undefined || id > after).slice(0, 10);
        const items: Array<{owner: string; dream: string}> = [];
        for (const owner of page) {
            try {
                const dreams = await this.list(owner);
                for (const dream of dreams.items.filter(item => item.enabled)) {
                    const config = await this.configs.read(owner, dream.id);
                    if (config?.config.consolidation) items.push({owner, dream: dream.id});
                }
                if (dreams.truncated) log.warn('dream.recompute.catalog', {operationId: 'recompute-catalog', stage: 'list', result: 'failure',
                    code: 'DREAM_CATALOG_TRUNCATED', durationMs: 0});
            } catch (error) {
                log.warn('dream.recompute.catalog', {operationId: 'recompute-catalog', stage: 'authorize', result: 'failure',
                    code: error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_CATALOG_READ_FAILED', durationMs: 0});
            }
        }
        return {items, ...(page.length === 10 ? {next: page[page.length - 1]} : {})};
    }

    async executeRecomputation(plan: DreamRecomputePlan, attempt = 0): Promise<void> {
        if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 1000) throw new Error('DREAM_RECOMPUTE_INVALID');
        await this.options.authorizeOwner(plan.owner);
        const config = await this.configs.read(plan.owner, plan.dream);
        if (!config?.config.enabled || !config.config.consolidation || config.revision !== plan.configRevision) throw new Error('DREAM_CONFIG_CONFLICT');
        const known = await this.recomputeSources(plan.owner, plan.dream, config.config);
        if (!plan.sources.length || plan.sources.some(source => !known.some(item => item.id === source.sourceId && item.projectId === plan.project)))
            throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        const rows: DreamBatchResult[] = plan.sources.map(source => ({...source, status: 'settled'}));
        await this.consolidateBatchGroup(plan.owner, plan.dream, `${plan.id}-${attempt}`, config, plan.project, rows, [plan.project], known,
            {receiptScope: plan.id, expectedVersion: plan.activeVersion});
    }

    private async recomputeSources(owner: string, dream: string, config: DreamConfig): Promise<Array<{id: string; projectId: string}>> {
        const result: Array<{id: string; projectId: string}> = [...config.files, ...config.decisions ?? [], ...config.tasks ?? [],
            ...config.sessions ?? [], ...config.changes ?? []].map(source => ({id: source.id, projectId: source.projectId}));
        for (const source of config.adoptions ?? []) {
            const watermark = await this.evidence.watermark(owner, dream, source.id);
            if (watermark) result.push({id: source.id, projectId: watermark.projectId});
        }
        return result;
    }
    private async runBatchSource(owner: string, dream: string, batch: string, revision: number, sourceId: string, scanOnly = false) {
        const operationId = 'batch-' + sha256HexSync(JSON.stringify([owner, dream, batch, revision, sourceId]));
        try {
            const input = {ownerProjectId: owner, dreamId: dream, sourceId, operationId};
            if (scanOnly) await this.scanConfigured(input); else await this.run(input);
            return {sourceId, operationId, status: 'settled' as const};
        } catch (error) {
            await this.options.authorizeOwner(owner);
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
            return {sourceId, operationId, status: 'failed' as const, code};
        }
    }
    async forSession(sessionId: string): Promise<DigitalTwinService | null> {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) return null;
        const saved = await this.registry.find(sessionId);
        if (saved?.consolidationScopes) {
            await this.authorizeConsolidationScopes(saved.ownerProjectId, saved.dreamId, saved.configRevision, saved.consolidationScopes);
            return null;
        }
        if (saved) return resolveDreamExecution(sessionId, {registry: this.registry, configs: this.configs,
            remote: this.sourceAuthorization, authorizeOwner: this.options.authorizeOwner, authorizeAdoption: binding => this.adoptionBinding(binding),
            open: async (owner, dream) => (await this.open(owner, dream)).twin}, saved);
        return null;
    }
    async authorizeScannerTool(sessionId: string): Promise<void> {
        if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) && await this.registry.find(sessionId)) {
            log.warn('dream.scanner.tool', {operationId: sessionId, stage: 'authorize', result: 'failure', code: 'DREAM_SCANNER_TOOL_DISABLED', durationMs: 0});
            throw new Error('DREAM_SCANNER_TOOL_DISABLED');
        }
    }
    async quiesce(): Promise<void> {
        this.closed = true;
        const entries = await Promise.allSettled(this.opened.values());
        const results = await Promise.allSettled(entries.flatMap(entry => entry.status === 'fulfilled' ? [entry.value.twin.quiesce()] : []));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'DREAM_QUIESCE_FAILED');
    }
    async dispose(): Promise<void> {
        const stopped = await Promise.allSettled([this.quiesce()]);
        const entries = await Promise.allSettled(this.opened.values());
        const results = await Promise.allSettled(entries.flatMap(entry => entry.status === 'fulfilled' ? [disposeEntry(entry.value)] : []));
        const errors = [...stopped, ...results].filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'DREAM_DISPOSE_FAILED');
    }
    private async open(owner: string, dream: string): Promise<Entry> {
        if (this.closed) throw new Error('DREAM_HOST_CLOSED');
        await this.options.authorizeOwner(owner);
        if (this.closed) throw new Error('DREAM_HOST_CLOSED');
        const key = JSON.stringify([owner, dream]); let pending = this.opened.get(key);
        if (!pending) {
            pending = this.createEntry(owner, dream).catch(error => {this.opened.delete(key); throw error;});
            this.opened.set(key, pending);
        }
        return pending;
    }
    private async createEntry(owner: string, dream: string): Promise<Entry> {
        const started = Date.now(), operationId = 'dream-' + sha256HexSync(JSON.stringify([owner, dream]));
        if (!await this.configs.read(owner, dream)) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const view = await openDreamSystemWorkspace(this.options.fs, owner, dream, () => this.options.authorizeOwner(owner));
        try {
            const twin = createNativeDigitalTwin(view.fs, this.options.repository, this.options.kernel, this.options.models,
                this.options.hostKind, this.options.projects, {twinId: operationId, ownerId: owner, fs: view.fs, authorize: () => this.options.authorizeOwner(owner),
                    readManagedArtifact: target => this.readManagedAdoption(owner, dream, target),
                    prepareJob: job => prepareDreamExecution(job, {registry: this.registry, configs: this.configs,
                        remote: this.sourceAuthorization, authorizeOwner: this.options.authorizeOwner, authorizeAdoption: binding => this.adoptionBinding(binding)})});
            twin.setScannerExecution(new PublishedScannerExecutor({kernel: this.options.kernel, repository: this.options.repository,
                ready: () => ({commands: this.options.commands, calls: this.options.calls}), exchanges: job => twin.scannerExchangeCount(job),
                bind: (job, sessionId) => bindDreamExecutionFromRun(job, sessionId, {registry: this.registry, configs: this.configs,
                    remote: this.sourceAuthorization, twin, authorizeOwner: this.options.authorizeOwner, authorizeAdoption: binding => this.adoptionBinding(binding)})}));
            if (this.closed) {await twin.quiesce(); throw new Error('DREAM_HOST_CLOSED');}
            log.info('dream.host.open', {operationId, stage: 'open', result: 'success', durationMs: Date.now() - started});
            return {twin, fs: view.fs, disposeView: view.dispose};
        } catch (error) {
            await view.dispose();
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_HOST_OPEN_FAILED';
            log.warn('dream.host.open', {operationId, stage: 'open', result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
        }
    }
}
async function disposeEntry(entry: Entry): Promise<void> {
    try {await entry.twin.dispose();} finally {await entry.disposeView();}
}
function recomputeAccessDenied(error: unknown): boolean {
    const code = (error as {code?: unknown} | null)?.code;
    const message = error instanceof Error ? error.message : '';
    return code === 'EACCES' || ['DREAM_AUTHORIZATION_CHANGED', 'DREAM_AUTHORIZATION_DENIED', 'DREAM_OWNER_AUTHORIZATION_FAILED',
        'DREAM_SOURCE_NOT_CONFIGURED', 'DREAM_SERVER_IDENTITY_CHANGED'].includes(message);
}
function sameSourceIdentity(current: import('@nestos/dream').SourceAuthority, captured: import('@nestos/dream').SourceAuthority): boolean {
    return sameAuthority(current, current) && sameAuthority(captured, captured) && current.principalId === captured.principalId
        && current.serverId === captured.serverId && current.serverProjectId === captured.serverProjectId;
}
