import {assembleKanbanRuntime,KanbanAutomationJournal,type KanbanRuntimeContext,type KanbanRuntimeExtension} from '@nestos/kanban/integration';
import {kanbanControlOptions} from './control-adapter';
import {workLogOptions} from './work-log-policy';
import {kanbanJournalOptions} from './host-policy';
import {taskReplies} from './task-replies';
import {createTaskFix} from './task-fix';
import {validateWorkProjects,inheritWorkReferences} from './task-projects';
import {validateRemoteReferences,projectResourceCatalog} from './resource-catalog';
import {createPersonalKanbanAutomation,type PersonalKanbanAutomationOptions} from './personal-automation';
import {authorizeAutomation} from './automation-authority';
import {reportKanbanHealth} from './health-events';
import type {IFileSystem} from '@nestos/vfs-core';
import type {UserEventService} from '../events/service';
import type {DiagnosticJournal} from '../diagnostics/journal';
import {createNestOSKanban} from './module';
import {openPersonalKanbanStore} from './store';
import {KanbanExamples} from '../presets/kanban-examples';
import {KanbanError} from '@nestos/kanban';
import {createLocalKanbanSessionSource} from './session-source';
import {planningSessionReader} from './planning-sessions';
import {relatedKanbanSessions} from './related-sessions';
/** The authenticated runtime owns this user store; project boards require their own binding. */
export async function createPersonalKanban(fs: IFileSystem, events: UserEventService, diagnostics: DiagnosticJournal, sessions?: Pick<import('@nestos/llm-session/contracts').ISessionRepository, 'listSummaries'|'getManifest'>, kernel?: Pick<import('@nestos/durable-kernel').Kernel,'sessionActivity'>, automationOptions?: PersonalKanbanAutomationOptions) {
    const store=await openPersonalKanbanStore(fs);await new KanbanExamples(store).seed();
    const journal=new KanbanAutomationJournal(fs,{...kanbanJournalOptions,diagnostic:event=>diagnostics.record({...event,module:'application',operation:'kanban.operation',level:event.result==='failure'?'warn':'info'})});
    let operations:ReturnType<typeof import('./item-operations').createItemOperations>|undefined;
    const base=personalOptions({store,journal,events,diagnostics,sessions,kernel,automationOptions:automationOptions?{...automationOptions,
        relatedSessions:async(board,item)=>[...await automationOptions.relatedSessions?.(board,item)??[],...await operations?.sessions(board,item)??[]]}:undefined});
    const runtime=await assembleKanbanRuntime({...base,fs,store,journal,directory:'/var/lib/kanban',actor:{kind:'human',id:'admin'},
        workLog:workLogOptions(events,base.log),resources:automationOptions?.projects?projectResourceCatalog(automationOptions.projects):undefined,
        requiresItemResource:automationOptions?.requiresItemResource,archiveSession:automationOptions?.archiveSession,
        control:kanbanControlOptions(automationOptions??{calls:{list:async()=>[]}},journal),
        createService:options=>createNestOSKanban({...options,notifications:base.notifications}),
        extensions:context=>personalExtensions(context,automationOptions,events,base.log,value=>{operations=value;})});
    try{await runtime.service.scan();await reportKanbanHealth(events);}catch(error){await reportKanbanHealth(events,error);}
    return runtime.service;
}
function personalExtensions(context:KanbanRuntimeContext,options:PersonalKanbanAutomationOptions|undefined,events:UserEventService,log:ReturnType<typeof personalOptions>['log'],setOperations:(value:ReturnType<typeof import('./item-operations').createItemOperations>|undefined)=>void):KanbanRuntimeExtension[] {
    const {service,journal,workLog,fs,serviceFor}=context;
    const operations=options?.itemOperations?.({service,journal,workLog,log});setOperations(operations);
    const resourcePorts=options?.workResources?.({service,journal,workLog}),{archiveItemResources,...resources}=resourcePorts??{};
    const automation=options?createPersonalKanbanAutomation({...options,fs,service,journal,workLog,log,serviceFor}):undefined;
    const fixes=options?.projects?.openWorkspace&&options.prepareWork?createTaskFix({fs,service,journal,events,automation:options,log,prepareSession:async id=>{
        await options.ensureReady?.();await options.sessions.ensureSession(id,'Fix');
        if(!await options.prepareSession(id))throw new KanbanError('AUTOMATION_SESSION_OWNED');return id;
    }}):undefined;
    const replies=options?.enqueueTaskReply?taskReplies(service,journal,options):undefined;
    const release=fixes?options?.registerInstructionGate?.((id,input)=>fixes.intercept(id,input)):undefined;
    const planning=options?planningSessionReader(service,journal,options):undefined;
    return [{archiveItemResources,capabilities:{...(planning?{planningSession:planning}:{}),...resources,...(operations?{itemOperations:operations.itemOperations,runItemOperation:operations.runItemOperation,bindItemOperation:operations.bindItemOperation}:{}),
        ...(resources?.cleanupWorkResource&&operations?{cleanupWorkResource:(board,request)=>operations.guardResource(board,request.itemId,()=>resources.cleanupWorkResource!(board,request))}:{}),
        ...(options?.continuation?{executionSession:async(board,item,query)=>{
            const detail=await service.executionSession(board,item,query),current=(await service.item(board,item)).item;
            const previous=Object.values((await service.workflow(board)).dispatches).filter(row=>row.itemId===item).sort((a,b)=>b.attempt-a.attempt)[0];
            return {...detail,...(['backlog','open'].includes(current.status)&&previous&&['failed','cancelled'].includes(previous.outcome)?{continuation:{previousDispatchId:previous.id}}:{})};
        }}:{}),...(fixes?{fixTask:fixes.fixTask,taskFixes:fixes.taskFixes,cancelFix:fixes.cancelFix}:{}),...(replies?{replyTask:replies}:{})},quiesce:async()=>{release?.();}},
        ...operations?[operations]:[],...automation?[{...automation,capabilities:{automationCatalog:automation.automationCatalog,analysisStatus:automation.analysisStatus}}]:[],...fixes?[fixes]:[],...replies?[replies]:[]];
}


type PersonalOptions = {
    store: Awaited<ReturnType<typeof openPersonalKanbanStore>>; journal: KanbanAutomationJournal;
    events: UserEventService; diagnostics: DiagnosticJournal;
    sessions?: Pick<import('@nestos/llm-session/contracts').ISessionRepository, 'listSummaries' | 'getManifest'>;
    kernel?: Pick<import('@nestos/durable-kernel').Kernel, 'sessionActivity'>; automationOptions?: PersonalKanbanAutomationOptions;
};
function personalOptions({store, journal, events, diagnostics, sessions, kernel, automationOptions}: PersonalOptions) {
    return {
        executionSessions:sessions&&kernel?{source:{...createLocalKanbanSessionSource(sessions,kernel,automationOptions?.executionResource),
            ...(automationOptions ? {related: relatedKanbanSessions({journal, calls: automationOptions.calls,
                repository: automationOptions.sessions, kernel: automationOptions.kernel, resources: automationOptions.sessionExecutionResources,
                related: automationOptions.relatedSessions})} : {})}}:undefined,
        suggestions: async (_board, kind, search, limit) => {
            if (kind !== 'session') return undefined;
            const rows = await sessions?.listSummaries?.() ?? [];
            return rows.filter(row => `${row.title} ${row.id} ${row.folder ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit)
                .map(row => ({id: row.id, label: row.title.slice(0, 256), detail: row.folder?.slice(0, 256) ?? ''}));
        },
        store, restartReferences:inheritWorkReferences, verifyOutputs: async ({board, itemId, dispatchId, outputs}: Parameters<NonNullable<import('./module').NestOSKanbanOptions['verifyOutputs']>>[0]) => {
            const state = await store.read(board.id);
            const dispatch = dispatchId ? state?.workflow?.dispatches[dispatchId] : undefined;
            if (dispatch?.itemId !== itemId || !await journal.verify(outputs, dispatch.id)) return false;
            await automationOptions?.verifyWork?.(dispatch.id);
            return true;
        },
        authorize: async (input: Parameters<import('./module').NestOSKanbanOptions['authorize']>[0]) => {
            const {board, command} = input;
            await authorizeAutomation(input, automationOptions?.catalog);
            if (command?.type === 'continue-execution') {
                if (!automationOptions?.continuation) throw new KanbanError('CONTINUATION_UNSUPPORTED');
                if (!board.automation?.enabled) throw new KanbanError('AUTOMATION_PAUSED');
            }
            if(command&&automationOptions?.projects)await validateWorkProjects(automationOptions.projects,board,command,automationOptions.requiresItemResource?.(board)===true);
            if (command?.type === 'configure-automation' && command.settings.preparation)
                automationOptions?.validatePreparation?.(command.settings.preparation, command.settings.preparationOptions);
            if (command?.type === 'append-record' && command.record.id.startsWith('activity-')) throw new KanbanError('RESERVED_RECORD_ID');
            if (command?.type === 'append-record' && command.record.externalRefs?.length) {
                if (!automationOptions?.projects) throw new KanbanError('PROJECT_SELECTION_UNAVAILABLE');
                await validateRemoteReferences(automationOptions.projects, command.record);
            }
            if (board.scope.kind === 'project') throw new KanbanError('PROJECT_STORE_REQUIRED');
            if (command?.type === 'apply-discovery') throw new KanbanError('DISCOVERY_BINDING_REQUIRED');
        },
        notifications: {sourceId: 'personal:user-store', journal: events.journal},
        log: event => {diagnostics.record({...event, module: 'application', operation: 'kanban.operation',
            level: event.result === 'failure' ? 'warn' : 'info'});},
    } satisfies Omit<import('./module').NestOSKanbanOptions, 'actor'>;
}
