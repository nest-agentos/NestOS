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
import {DreamExecutionRegistry} from './execution-registry';
import {bindDreamExecutionFromRun, prepareDreamExecution} from './execution-bind';
import {resolveDreamExecution} from './execution-route';
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
import {changeSourcePort} from './change-source';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanService} from '@nestos/kanban/contracts';
import {isKanbanRecurringRunBoard} from '@nestos/kanban/contracts';
import type {DreamScheduleManager} from './schedule-manager';

interface Options {
    fs: IFileSystem; repository: SessionRepository; kernel: Kernel; models: Parameters<typeof createNativeDigitalTwin>[3] & {
        getConnections(): Promise<Array<{id: string; name: string; enabled: boolean}>>};
    projects: ProjectService; remote: ProjectRemoteMountService; commands: ICommandBus; calls: IndependentCallService;
    authorizeOwner(owner: string): Promise<void>; hostKind: string;
}
interface Entry {twin: DigitalTwinService; fs: IFileSystem; disposeView(): Promise<void>}
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
            await this.options.authorizeOwner(projectId);
            const revision = sha256HexSync(JSON.stringify([project.project.id, project.project.directory, project.project.source, project.path]));
            await this.options.authorizeOwner(projectId);
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
            owner: () => this.options.authorizeOwner(owner), source: async () => {}, change: async source => {
                const [result] = await scanSources([{id: source.id, projectId: source.projectId, connectionId: source.connectionId, cursor: null}], 1, this.changePort(source));
                if (result.status !== 'ok') throw new Error('DREAM_CHANGE_SCOPE_UNAVAILABLE');
            },
        });
    }
    private async authorizeChange(source: import('./config-store').DreamChangeSourceConfig) {
        if (this.options.remote.list(source.projectId).some(mount => mount.at !== '/')) throw new Error('DREAM_CHANGE_MOUNT_UNSUPPORTED');
        return this.sourceAuthorization.authorizeDreamSource(source.projectId, source.connectionId, 'fileRead');
    }
    private changePort(source: import('./config-store').DreamChangeSourceConfig) {
        return changeSourcePort(source, this.options.projects, value => this.authorizeChange(value));
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
        if (this.options.projects.fileSource(project).kind === 'local') return this.options.authorizeOwner(id);
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
    async retrieveSessionMemory(session: string, limit: number) {
        const started = Date.now(), operationId = 'dream-retrieve-' + sha256HexSync(session);
        try {
            if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('DREAM_SESSION_INVALID');
            if (!limit) return [];
            const binding = await this.sessionMemory.read(session); if (!binding || 'disabled' in binding) return [];
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
            const code = error instanceof Error && /^(DREAM|TWIN)_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_FILE_ADD_FAILED';
            log.warn('dream.file.add', {operationId: /^[a-zA-Z0-9_-]{1,128}$/.test(operationId) ? operationId : 'invalid', stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    async run(input: ConfiguredDreamRequest): Promise<void> {
        const entry = await this.open(input.ownerProjectId, input.dreamId);
        const config = await this.configs.read(input.ownerProjectId, input.dreamId);
        const selected = config?.config.decisions?.find(source => source.id === input.sourceId) ?? config?.config.tasks?.find(source => source.id === input.sourceId) ?? config?.config.sessions?.find(source => source.id === input.sourceId) ?? config?.config.changes?.find(source => source.id === input.sourceId);
        if (selected && config) return this.runSummary(input, entry, config, selected);
        if (config?.config.adoptions?.some(source => source.id === input.sourceId)) return this.runAdoption(input, entry, config);
        return runConfiguredDreamFile(input, {configs: this.configs, evidence: this.evidence, registry: this.registry,
            twin: entry.twin, kernel: this.options.kernel, remote: this.sourceAuthorization,
            reader: new NestosTwinSourceReader(entry.fs, this.options.repository, this.options.projects), authorizeOwner: this.options.authorizeOwner});
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
        const source = {...base, cursor: outcome?.status === 'ok' ? outcome.evidence.startCursor : watermark?.cursor ?? null};
        return runDreamTwinFileScan({...input, planId: plan.planId, planRevision: plan.planRevision, twinSourceId: plan.sourceId,
            target: selected.id, sourceKind: 'managed-artifact', source, configRevision: config.revision}, entry.twin, port,
            this.evidence, this.options.kernel, () => this.options.authorizeOwner(input.ownerProjectId),
            (runId, proof) => this.registry.bindRun(runId, {ownerProjectId: input.ownerProjectId, dreamId: input.dreamId,
                sourceId: input.sourceId, configRevision: config.revision, authority: proof, adoptionPlanRevision: plan.planRevision}));
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
        const source = {...base, cursor: outcome?.status === 'ok' ? outcome.evidence.startCursor : watermark?.cursor ?? null};
        return runDreamTwinFileScan({...input, planId: plan.planId, planRevision: plan.planRevision, twinSourceId: plan.sourceId,
            target: input.sourceId, sourceKind: 'managed-artifact', source, configRevision: config.revision}, entry.twin, port,
            this.evidence, this.options.kernel, () => this.options.authorizeOwner(input.ownerProjectId),
            (runId, proof) => this.registry.bindRun(runId, {ownerProjectId: input.ownerProjectId, dreamId: input.dreamId,
                sourceId: input.sourceId, configRevision: config.revision, authority: proof, adoptionPlanRevision: plan.planRevision}));
    }
    async runAll(owner: string, dream: string, operationId: string, configRevision: number) {
        const started = Date.now();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(operationId)) throw new Error('DREAM_INVALID_OPERATION');
        await this.options.authorizeOwner(owner);
        const current = await this.configs.read(owner, dream);
        if (!current || current.revision !== configRevision || !current.config.enabled) throw new Error('DREAM_CONFIG_CONFLICT');
        await this.configs.reserveBatch(owner, dream, operationId, configRevision);
        const results: Array<{sourceId: string; operationId: string; status: 'settled' | 'failed'; code?: string}> = [];
        for (const file of current.config.files) {
            const child = 'batch-' + sha256HexSync(JSON.stringify([owner, dream, operationId, configRevision, file.id]));
            try {
                await this.run({ownerProjectId: owner, dreamId: dream, sourceId: file.id, operationId: child});
                results.push({sourceId: file.id, operationId: child, status: 'settled'});
            } catch (error) {
                await this.options.authorizeOwner(owner);
                const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                results.push({sourceId: file.id, operationId: child, status: 'failed', code});
            }
        }
        for (const source of current.config.adoptions ?? []) {
            const child = 'batch-' + sha256HexSync(JSON.stringify([owner, dream, operationId, configRevision, source.id]));
            try {await this.run({ownerProjectId: owner, dreamId: dream, sourceId: source.id, operationId: child});
                results.push({sourceId: source.id, operationId: child, status: 'settled'});
            } catch (error) {await this.options.authorizeOwner(owner); const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                results.push({sourceId: source.id, operationId: child, status: 'failed', code});}
        }
        for (const source of current.config.decisions ?? []) {
            const child = 'batch-' + sha256HexSync(JSON.stringify([owner, dream, operationId, configRevision, source.id]));
            try {await this.run({ownerProjectId: owner, dreamId: dream, sourceId: source.id, operationId: child});
                results.push({sourceId: source.id, operationId: child, status: 'settled'});
            } catch (error) {await this.options.authorizeOwner(owner); const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                results.push({sourceId: source.id, operationId: child, status: 'failed', code});}
        }
        for (const source of current.config.tasks ?? []) {
            const child = 'batch-' + sha256HexSync(JSON.stringify([owner, dream, operationId, configRevision, source.id]));
            try {await this.run({ownerProjectId: owner, dreamId: dream, sourceId: source.id, operationId: child});
                results.push({sourceId: source.id, operationId: child, status: 'settled'});
            } catch (error) {await this.options.authorizeOwner(owner); const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                results.push({sourceId: source.id, operationId: child, status: 'failed', code});}
        }
        for (const source of current.config.sessions ?? []) {
            const child = 'batch-' + sha256HexSync(JSON.stringify([owner, dream, operationId, configRevision, source.id]));
            try {await this.run({ownerProjectId: owner, dreamId: dream, sourceId: source.id, operationId: child});
                results.push({sourceId: source.id, operationId: child, status: 'settled'});
            } catch (error) {await this.options.authorizeOwner(owner); const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                results.push({sourceId: source.id, operationId: child, status: 'failed', code});}
        }
        for (const source of current.config.changes ?? []) {
            const child = 'batch-' + sha256HexSync(JSON.stringify([owner, dream, operationId, configRevision, source.id]));
            try {await this.run({ownerProjectId: owner, dreamId: dream, sourceId: source.id, operationId: child});
                results.push({sourceId: source.id, operationId: child, status: 'settled'});
            } catch (error) {await this.options.authorizeOwner(owner); const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCAN_FAILED';
                results.push({sourceId: source.id, operationId: child, status: 'failed', code});}
        }
        await this.options.authorizeOwner(owner); await this.evidence.checkConfig(owner, dream, configRevision);
        log.info('dream.scan.batch', {operationId, stage: 'complete', result: 'success', count: results.length,
            failed: results.filter(item => item.status === 'failed').length, durationMs: Date.now() - started});
        return {configRevision, results};
    }
    async forSession(sessionId: string): Promise<DigitalTwinService | null> {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) return null;
        const saved = await this.registry.find(sessionId);
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
