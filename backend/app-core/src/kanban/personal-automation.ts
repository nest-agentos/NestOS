import {taskCoordinator} from './task-coordinator';
import {recoverAnalysis} from './analysis-recovery';
import {readGlobalPlanningPrompt} from '../presets/kanban-configuration-files';
import {kanbanControlOptions} from './control-adapter';
import {drainBoardAnalyses} from '@nestos/kanban/integration';
import {scanTaskControls} from '@nestos/kanban/integration';
import type {CallLifecyclePorts as TaskControlPorts} from './call-lifecycle';
import {workContext} from './work-context';
import {createKanbanAutomation,type KanbanExecutorContext,type KanbanAutomationJournal,type KanbanWorkLog,type WorkLogFact} from '@nestos/kanban/integration';
import {executionSessionReference} from '@nestos/app-contracts';
import {t} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {IndependentCallService,SessionRepository} from '@nestos/llm-session';
import type {Kernel} from '@nestos/durable-kernel';
import type {RootTargetCatalog} from '@nestos/llm-session/contracts';
import type {KanbanActor,KanbanBoard,KanbanItem,KanbanService} from '@nestos/kanban/contracts';
import {createPublishedKanbanWorkExecutor} from './published-work';
import {analyzeItem} from './analysis-adapter';
import {automationCatalog,automationTarget} from './automation-targets';
import {requireValue} from './validation';
import {withContinuedWork,type ContinueWorkOptions} from './continued-work';
export interface PersonalKanbanAutomationOptions extends TaskControlPorts {
    deliveryReady?(boardId:string,item:KanbanItem):Promise<boolean>;
    notifyCoordination?(job:import('@nestos/kanban/integration').CoordinationOperation):Promise<void>;
    archiveSession?(sessionId:string,operationId:string):Promise<void>;
    sessionChannel?: import('@nestos/app-contracts/services').ProjectRemoteMountPort['sessionChannel'];
    itemOperations?(context: {service: KanbanService; journal: KanbanAutomationJournal; workLog: KanbanWorkLog;
        automaticTarget?:import('./item-operation-types').ReviewOperationsOptions['automaticTarget'];automatic?:import('./item-operation-types').ReviewOperationsOptions['automatic'];cleanup?:import('./item-operation-types').ReviewOperationsOptions['cleanup'];reportAutomatic?:import('./item-operation-types').ReviewOperationsOptions['reportAutomatic'];
        log: import('./item-operation-types').ReviewOperationsOptions['log']}): ReturnType<typeof import('./item-operations').createItemOperations>;
    relatedSessions?(boardId: string, itemId: string): Promise<import('@nestos/kanban/contracts').KanbanSessionAssociation[]>;
    sessionExecutionResources?(id: string): Promise<Array<{label: string; value: string}>>;
    collaboration?: {submission:ReturnType<typeof import('../run/session-submission').sessionSubmission>;
        prepare(input:{id:string;originId:string;sessionId:string;nativeSessionId?:string;context:unknown;item:KanbanItem;board:KanbanBoard}):Promise<string>};
    continuation?: Pick<ContinueWorkOptions, 'submission' | 'prepare'>;
    workResources?(context: {service: KanbanService; workLog: KanbanWorkLog; journal: KanbanAutomationJournal}): Pick<import('@nestos/kanban/contracts').KanbanClient, 'workResources' | 'cleanupWorkResource'> & {archiveItemResources?(boardId:string,itemId:string,operationId:string):Promise<void>};
    enqueueTaskReply?(request:import('@nestos/llm-session/contracts').SubmissionRequest):Promise<void>;
    registerInstructionGate?(gate:(sessionId:string,input:import('@nestos/llm-session/contracts').SessionInstruction)=>Promise<boolean>):()=>void;
    executionResource?(sessionId:string,branch:string,board?:import('@nestos/kanban/contracts').KanbanBoard):Promise<string|undefined>;
    requiresItemResource?(board:KanbanBoard):boolean;
    readAnalysisOutput?(id:string):Promise<import('@nestos/kanban/integration').KanbanAnalysisObservation|undefined>;
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
export function createPersonalKanbanAutomation(options:Options) {
    const prepareSession=async(id:string)=>{
        await options.ensureReady?.();await options.sessions.ensureSession(id,t('kanban.automationTitle'));
        requireValue(await options.prepareSession(id),'AUTOMATION_SESSION_OWNED');return id;
    };
    return createKanbanAutomation({...options,directory:'/var/lib/kanban/automation',executionReference:executionSessionReference,
        catalog:async()=>({...automationCatalog(await options.catalog()),preparations:options.preparations}),
        coordinate:taskCoordinator(options),
        controls:(board,service)=>scanTaskControls(kanbanControlOptions(options,options.journal),options.journal,board,service),
        drain:(board,service)=>drainBoardAnalyses(kanbanControlOptions(options,options.journal),options.journal,board,service),
        analyze:async(board,item,service,active)=>{
            await recoverAnalysis(options,board,item,service,active,async()=>{
            const target=board.automation!.enabled?automationTarget(board.automation!.planner,await options.catalog()):undefined;
            await analyzeItem({...options,prepareSession,active,readPlanningPrompt:board=>readGlobalPlanningPrompt(options.fs,board.automation?.preparationOptions?.profile??'development'),prepareAnalysis:options.prepareAnalysis?async input=>options.prepareAnalysis!({...input,
                context:await workContext(options.journal,board,item),
                reportActivity:fact=>options.workLog?.append(options.service,board.id,item.id,{...fact,actor:fact.actor??board.automation?.coordinator,dispatchId:input.id})??Promise.resolve()}) : undefined},board,item,target,service);
            });
        },executor:context=>createExecutor(options,context,prepareSession)});
}
async function createExecutor(options:Options,context:KanbanExecutorContext,prepareSession:(id:string)=>Promise<string>) {
    const {boardId,service}=context;
    const observe = options.observeWork ? async (dispatch: import('@nestos/kanban/contracts').KanbanDispatch, observation: import('@nestos/kanban/execution').KanbanExecutionObservation) => options.observeWork!({boardId, dispatch, observation,
        service, worker: options.serviceFor(dispatch.principal)}) : undefined;
    const primary = createPublishedKanbanWorkExecutor({...options, prepareSession,
        onSessionPrepared: (dispatch, item, sessionId) => options.workLog?.append(options.service, boardId, item.id, {stage: 'session.prepared', result: 'success', actor: dispatch.principal, dispatchId: dispatch.id,
            references: [{system: 'nestos-execution-session', id: sessionId, revision: dispatch.id}]}) ?? Promise.resolve(),
        observe,
        context: async (_dispatch, item) => context.dependencies(item),
        binding: async (dispatch, item) => {
            const board = await options.service.read(boardId);
            requireValue(board.automation?.enabled, 'AUTOMATION_PAUSED');
            const target = automationTarget(board.automation.executor, await options.catalog());
            if (board.automation.preparation) {
                requireValue(options.prepareWork, 'WORK_PREPARATION_UNAVAILABLE');
                return options.prepareWork({context:{...await workContext(options.journal,board,item),inputs:dispatch.inputs,dependencies:await context.dependencies(item)},dispatch, item, target, preparation: board.automation.preparation, options: board.automation.preparationOptions,
                    reportActivity: fact => options.workLog?.append(options.service, boardId, item.id, {...fact, actor: fact.actor ?? dispatch.principal, dispatchId: dispatch.id}) ?? Promise.resolve()});
            }
            return {target};
        }});
    const executor = options.continuation ? withContinuedWork(primary, {...options.continuation, calls: options.calls, kernel: options.kernel, observe}) : primary;
    return executor;
}
