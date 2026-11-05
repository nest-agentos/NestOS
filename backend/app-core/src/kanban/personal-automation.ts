import {scanTaskControls, type TaskControlPorts} from './task-controls';
import {taskDue} from '@nestos/kanban';
import {workContext} from './work-context';
import {completeCompositePlans} from './analysis-aggregation';
import type {KanbanWorkLog, WorkLogFact} from './work-log';
import {t} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {IndependentCallService, SessionRepository} from '@nestos/llm-session';
import type {Kernel} from '@nestos/durable-kernel';
import type {RootTargetCatalog} from '@nestos/llm-session/contracts';
import {boardAllowsStart, executableWorkItem} from '@nestos/kanban/contracts';
import type {KanbanActor, KanbanBoard, KanbanItem, KanbanService, KanbanArtifactRef} from '@nestos/kanban/contracts';
import {createNestOSKanbanExecutionBridge} from './module';
import {createPublishedKanbanWorkExecutor} from './published-work';
import {KanbanAutomationJournal} from './automation-journal';
import {analyzeItem, analysisStatus, safeCode} from './automation-analysis';
import {automationCatalog, automationTarget, assertAutomationPrincipals} from './automation-targets';
import {requireValue} from './validation';
import {withContinuedWork, type ContinueWorkOptions} from './continued-work';

export interface PersonalKanbanAutomationOptions extends TaskControlPorts {
    sessionChannel?: import('@nestos/app-contracts/services').ProjectRemoteMountPort['sessionChannel'];
    itemOperations?(context: {service: KanbanService; journal: KanbanAutomationJournal; workLog: KanbanWorkLog;
        log: import('./item-operation-types').ReviewOperationsOptions['log']}): ReturnType<typeof import('./item-operations').createItemOperations>;
    relatedSessions?(boardId: string, itemId: string): Promise<import('@nestos/kanban/contracts').KanbanSessionAssociation[]>;
    sessionExecutionResources?(id: string): Promise<Array<{label: string; value: string}>>;
    continuation?: Pick<ContinueWorkOptions, 'submission' | 'prepare'>;
    workResources?(context: {service: KanbanService; workLog: KanbanWorkLog; journal: KanbanAutomationJournal}): Pick<import('@nestos/kanban/contracts').KanbanClient, 'workResources' | 'cleanupWorkResource'>;
    enqueueTaskReply?(request:import('@nestos/llm-session/contracts').SubmissionRequest):Promise<void>;
    registerInstructionGate?(gate:(sessionId:string,input:import('@nestos/llm-session/contracts').SessionInstruction)=>Promise<boolean>):()=>void;
    executionResource?(sessionId:string,branch:string):Promise<string|undefined>;
    requiresItemResource?(board:KanbanBoard):boolean;
    readAnalysisOutput?(id:string):Promise<unknown|undefined>;
    onAnalysis?(input: {boardId: string; id: string; item: KanbanItem; target: import('@nestos/llm-flow/contracts').TargetRef; outcome: 'succeeded' | 'failed' | 'cancelled'; code?: string}): Promise<void>;
    prepareAnalysis?(input: {context?:unknown;reportActivity?(fact: WorkLogFact): Promise<void>; id: string; board: KanbanBoard; item: KanbanItem; target: import('@nestos/llm-flow/contracts').TargetRef}): Promise<{target: import('@nestos/llm-flow/contracts').TargetRef; instruction: string; contextRef?: unknown}>;
    validatePreparation?(reference: import('@nestos/kanban/contracts').KanbanExternalReference, options?: Record<string, string>): void;
    verifyWork?(dispatchId: string): Promise<void>;
    preparations?: import('@nestos/kanban/contracts').KanbanAutomationTarget[];
    observeWork?(input: {boardId: string; dispatch: import('@nestos/kanban/contracts').KanbanDispatch;
        observation: import('@nestos/kanban/execution').KanbanExecutionObservation; service: KanbanService; worker: KanbanService}): Promise<import('@nestos/kanban/execution').KanbanExecutionObservation>;
    prepareWork?(input: {context?:unknown;dispatch: import('@nestos/kanban/contracts').KanbanDispatch; item: KanbanItem;
        reportActivity?(fact: WorkLogFact): Promise<void>; stage?: 'decision' | 'task' | 'fix'; options?: Record<string, string>; preparation: import('@nestos/kanban/contracts').KanbanExternalReference; target: import('@nestos/llm-flow/contracts').TargetRef}): Promise<{target:import('@nestos/llm-flow/contracts').TargetRef;contextRef?:unknown}>;
    projects?: Pick<import('@nestos/app-contracts/services').ProjectService, 'list' | 'get'> & Partial<Pick<import('@nestos/app-contracts/services').ProjectService,'openWorkspace'>>;
    calls: IndependentCallService; kernel: Kernel; sessions: SessionRepository;
    prepareSession(id: string): Promise<boolean>; catalog(): Promise<RootTargetCatalog>;
    ensureReady?(): Promise<void>;
}
interface Options extends PersonalKanbanAutomationOptions {
    fs: IFileSystem; service: KanbanService; workLog?: KanbanWorkLog; journal: KanbanAutomationJournal;
    serviceFor(actor: KanbanActor): KanbanService;
    log(input: {operationId: string; boardId?: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
export function createPersonalKanbanAutomation(options: Options) {
    let stopped = false, pending: Promise<void> | undefined;
    const bridges = new Map<string, Awaited<ReturnType<typeof createNestOSKanbanExecutionBridge>>>();
    const prepareSession = async (id: string) => {
        await options.ensureReady?.();
        await options.sessions.ensureSession(id, t('kanban.automationTitle'));
        requireValue(await options.prepareSession(id), 'AUTOMATION_SESSION_OWNED'); return id;
    };
    const scan = () => {
        if (stopped) return Promise.resolve();
        return pending ??= scanBoards(options, bridges, prepareSession, () => !stopped).finally(() => {pending = undefined;});
    };
    return {scan, async quiesce() {
        stopped = true; await Promise.allSettled([...bridges.values()].map(bridge => bridge.quiesce()));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {await Promise.race([pending?.catch(() => {}), new Promise<void>(resolve => {timer = setTimeout(resolve, 5000);})]);}
        finally {if (timer) clearTimeout(timer); await options.journal.drain();}
    },
        automationCatalog: async () => {requireValue(!stopped, 'SERVICE_STOPPING'); return {...automationCatalog(await options.catalog()), preparations: options.preparations};},
        analysisStatus: async (boardId: string, itemId: string) => {const {item}=await options.service.item(boardId, itemId); return item.analysis ?? analysisStatus(options.journal, boardId, itemId);},
        verifyOutputs: (outputs: KanbanArtifactRef[]) => options.journal.verify(outputs)};
}
async function scanBoards(options: Options, bridges: Map<string, Awaited<ReturnType<typeof createNestOSKanbanExecutionBridge>>>,
    prepareSession: (id: string) => Promise<string>, active: () => boolean): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of await options.service.catalog()) {
        if (!active()) return;
        if (!entry.automation) continue;
        const started = Date.now();
        try {
            const board = await options.service.read(entry.id); if (!active()) return; assertAutomationPrincipals(board.automation!);
            let bridge = bridges.get(board.id);
            if (!bridge) {bridge = await createBridge(options, board.id, prepareSession); bridges.set(board.id, bridge);}
            if (!active()) {await bridge.quiesce(); return;}
            await scanTaskControls(options, options.journal, board, options.serviceFor(board.automation!.coordinator));
            if (!active()) return;
            await bridge.scan();
            if (!active()) return;
            await planNext(options, await options.service.read(board.id), prepareSession, active);
            if (active()) await bridge.scan();
            if(active())await completeCompositePlans(options.service,options.journal,board.id,options.serviceFor);
            options.log({operationId: board.id, boardId: board.id, stage: 'automation.scan', result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            options.log({operationId: entry.id, boardId: entry.id, stage: 'automation.scan', result: 'failure', code: safeCode(error, 'AUTOMATION_SCAN_FAILED'), durationMs: Date.now() - started});
            failures.push(error);
        }
    }
    if (failures.length) throw new AggregateError(failures, 'KANBAN_AUTOMATION_FAILED');
}
async function planNext(options: Options, board: KanbanBoard, prepareSession: (id: string) => Promise<string>, active: () => boolean): Promise<void> {
    const workflow = await options.service.workflow(board.id), planned = new Set(Object.values(workflow.plans).flatMap(plan => plan.itemIds));
    const candidates = board.items.filter(item => !planned.has(item.id) && ['backlog', 'open'].includes(item.status) && !item.owner && !item.blocked
        && boardAllowsStart(board, item) && !['failed','clarification'].includes(item.analysis?.state??'') && executableWorkItem(board,item) && item.control?.action !== 'pause' && (item.launch?.admittedAt !== undefined || taskDue(item, Date.now())));
    const target = board.automation!.enabled ? automationTarget(board.automation!.planner, await options.catalog()) : undefined;
    for (const item of candidates) {
        if (!active()) return;
        if(!await dependenciesComplete(options.service,board,item))continue;
        if (item.launch?.admittedAt === undefined) {
            const source = options.serviceFor(board.automation!.coordinator), latest = await source.read(board.id);
            try {await source.execute(board.id, {operationId:'admit:'+item.id+':'+item.revision, expectedRevision:latest.revision, command:{type:'admit-item',itemId:item.id,trigger:item.launch?.requestedAt !== undefined?'manual':'automatic'}});}
            catch(error) {if (['REVISION_CONFLICT','TASK_DEFINITION_FROZEN','EDIT_LEASE_ACTIVE'].includes(safeCode(error,''))) return; throw error;}
            board = await source.read(board.id); Object.assign(item, board.items.find(i => i.id === item.id));
        }
        try {
        await analyzeItem({...options, prepareSession, active, prepareAnalysis: options.prepareAnalysis ? async input => options.prepareAnalysis!({...input,context:await workContext(options.journal,board,item),
            reportActivity: fact => options.workLog?.append(options.service, board.id, item.id, {...fact, actor: fact.actor ?? board.automation?.coordinator, dispatchId: input.id}) ?? Promise.resolve()}) : undefined}, board, item, target, options.serviceFor(board.automation!.coordinator));
        } catch(error) {
            const client=options.serviceFor(board.automation!.coordinator),latest=await client.read(board.id),code=safeCode(error,'AUTOMATION_ANALYSIS_PREPARATION_FAILED');
            await client.execute(board.id,{operationId:'analysis-prepare-failed:'+item.id+':'+item.revision,expectedRevision:latest.revision,command:{type:'report-analysis',itemId:item.id,operationId:item.id,status:{itemId:item.id,state:'failed',code}}});
            options.log({operationId:item.id,boardId:board.id,stage:'automation.analysis.prepare',result:'failure',code,durationMs:0});
        }
        const status = await analysisStatus(options.journal, board.id, item.id);
        if (status?.state === 'analyzing' || status?.state === 'unknown' || status?.state === 'ready') return;
    }
}
async function createBridge(options: Options, boardId: string, prepareSession: (id: string) => Promise<string>) {
    const manager = async () => {const board = await options.service.read(boardId); return options.serviceFor(board.automation!.coordinator);};
    const service = await manager();
    const observe = options.observeWork ? async (dispatch: import('@nestos/kanban/contracts').KanbanDispatch, observation: import('@nestos/kanban/execution').KanbanExecutionObservation) => options.observeWork!({boardId, dispatch, observation,
        service, worker: options.serviceFor(dispatch.principal)}) : undefined;
    const primary = createPublishedKanbanWorkExecutor({...options, prepareSession,
        onSessionPrepared: (dispatch, item, sessionId) => options.workLog?.append(options.service, boardId, item.id, {stage: 'session.prepared', result: 'success', actor: dispatch.principal, dispatchId: dispatch.id,
            references: [{system: 'nestos-execution-session', id: sessionId, revision: dispatch.id}]}) ?? Promise.resolve(),
        observe,
        context: async (_dispatch, item) => dependencyResults(options, boardId, item),
        binding: async (dispatch, item) => {
            const board = await options.service.read(boardId);
            requireValue(board.automation?.enabled, 'AUTOMATION_PAUSED');
            const target = automationTarget(board.automation.executor, await options.catalog());
            if (board.automation.preparation) {
                requireValue(options.prepareWork, 'WORK_PREPARATION_UNAVAILABLE');
                return options.prepareWork({context:{...await workContext(options.journal,board,item),inputs:dispatch.inputs,dependencies:await dependencyResults(options,boardId,item)},dispatch, item, target, preparation: board.automation.preparation, options: board.automation.preparationOptions,
                    reportActivity: fact => options.workLog?.append(options.service, boardId, item.id, {...fact, actor: fact.actor ?? dispatch.principal, dispatchId: dispatch.id}) ?? Promise.resolve()});
            }
            return {target};
        }});
    const executor = options.continuation ? withContinuedWork(primary, {...options.continuation, calls: options.calls, kernel: options.kernel, observe}) : primary;
    return createNestOSKanbanExecutionBridge({fs: options.fs, directory: '/var/lib/kanban/automation/' + encodeURIComponent(boardId), boardId,
        service, worker: async principal => options.serviceFor(principal), executor,
        autoDispatch: async () => (await options.service.read(boardId)).automation?.enabled === true,
        estimate: item => estimateFor(options.journal, boardId, item),
        authorize: async stage => {const board = await options.service.read(boardId); if (stage !== 'inspect') {requireValue(board.automation?.enabled, 'AUTOMATION_PAUSED'); requireValue(!board.executionControl?.paused, 'BOARD_EXECUTION_PAUSED');}},
        log: event => options.log({...event, boardId})});
}
async function estimateFor(journal: KanbanAutomationJournal, boardId: string, item: KanbanItem) {
    const decomposed=await journal.get<import('@nestos/kanban/contracts').KanbanEstimate>('decomposition-estimate:'+JSON.stringify([boardId,item.id]));
    if(decomposed)return decomposed;
    const key = await journal.get<string>('analysis-current:' + JSON.stringify([boardId, item.id]));
    return key ? (await journal.get<{result?: {estimate?: import('@nestos/kanban/contracts').KanbanEstimate}}>(key))?.result?.estimate : undefined;
}
async function dependencyResults(options: Options, boardId: string, item: KanbanItem): Promise<unknown> {
    const workflow = await options.service.workflow(boardId), results: Array<{itemId: string; outputs: Array<{reference: KanbanArtifactRef; value: unknown}>}> = [];
    for (const itemId of item.planning?.dependencies ?? []) {
        const dispatch = Object.values(workflow.dispatches).reverse().find(dispatch => dispatch.itemId === itemId && dispatch.outcome === 'accepted');
        const outputs: Array<{reference: KanbanArtifactRef; value: unknown}> = [];
        for (const output of dispatch?.outputs ?? []) {
            requireValue(await options.journal.verify(dispatch?.outputs ?? [], dispatch?.id), 'DEPENDENCY_OUTPUT_INVALID');
            outputs.push({reference: output, value: JSON.parse((await options.journal.get<string>('artifact:' + output.sha256))!)});
        }
        results.push({itemId, outputs});
    }
    requireValue(new TextEncoder().encode(JSON.stringify(results)).byteLength <= 128 * 1024, 'DEPENDENCY_CONTEXT_TOO_LARGE');
    return results;
}

async function dependenciesComplete(service:KanbanService,board:KanbanBoard,item:KanbanItem):Promise<boolean> {
    for(const id of item.planning?.dependencies??[]) {
        const dependency=board.items.find(i=>i.id===id)??(await service.item(board.id,id)).item;
        if(dependency.status!=='completed')return false;
    }
    return true;
}
