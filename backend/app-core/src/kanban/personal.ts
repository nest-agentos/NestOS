import {createSoftwareDevelopmentPlugin} from '@nestos/kanban-development';
import {recordFollowUps} from './record-follow-ups';
import {assertWorkspaceCleanup} from './workspace-cleanup-blocker';
import {workProjectId} from './task-projects';
import {taskCommunication} from './task-communication';
import {restartBarrier} from './restart-barrier';
import type {KanbanClient} from '@nestos/kanban/contracts';
import {sha256HexSync} from '@nestos/common';
import {workContext} from './work-context';
import {KanbanError} from '@nestos/kanban';
import {assembleKanbanRuntime,KanbanAutomationJournal,type KanbanRuntimeContext,type KanbanRuntimeExtension} from '@nestos/kanban/integration';
import {kanbanControlOptions} from './control-adapter';
import {workLogOptions} from './work-log-policy';
import {kanbanJournalOptions} from './host-policy';
import {taskReplies} from './task-replies';
import {createTaskFix,cancelItemFixes} from './task-fix';
import {coordinationNotifications} from './task-coordinator';
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
import {createLocalKanbanSessionSource} from './session-source';
import {planningSessionReader} from './planning-sessions';
import {relatedKanbanSessions} from './related-sessions';
/** The authenticated runtime owns this user store; project boards require their own binding. */
export async function createPersonalKanban(fs: IFileSystem, events: UserEventService, diagnostics: DiagnosticJournal, sessions?: Pick<import('@nestos/llm-session/contracts').ISessionRepository, 'listSummaries'|'getManifest'>, activity?:import('@nestos/llm-session').SessionActivityReader, automationOptions?: PersonalKanbanAutomationOptions) {
    const store=await openPersonalKanbanStore(fs);await new KanbanExamples(store).seed();
    const journal=new KanbanAutomationJournal(fs,{...kanbanJournalOptions,diagnostic:event=>diagnostics.record({...event,module:'application',operation:'kanban.operation',level:event.result==='failure'?'warn':'info'})});
    let client:KanbanClient;
    const assertRestartIdle=restartBarrier(()=>client);
    let operations:ReturnType<typeof import('@nestos/kanban-development').createItemOperations>|undefined;
    const base=personalOptions({store,journal,events,diagnostics,sessions,activity,automationOptions:automationOptions?{...automationOptions,
        relatedSessions:async(board,item)=>[...await automationOptions.relatedSessions?.(board,item)??[],...await operations?.sessions(board,item)??[]]}:undefined});
    const runtime=await assembleKanbanRuntime({...base,assertRestartIdle,fs,store,journal,directory:'/var/lib/kanban',actor:{kind:'human',id:'admin'},
        workLog:workLogOptions(events,base.log),resources:automationOptions?.projects?projectResourceCatalog(automationOptions.projects):undefined,
        requiresItemResource:automationOptions?.requiresItemResource,archiveSession:automationOptions?.archiveSession,
        control:kanbanControlOptions(automationOptions??{calls:{list:async()=>[]}},journal),
        createService:options=>createNestOSKanban({...options,notifications:base.notifications}),
        extensions:context=>personalExtensions(context,automationOptions,events,base.log,value=>{operations=value;},()=>client)});
    client=runtime.service;
    try{await runtime.service.scan();await reportKanbanHealth(events);}catch(error){await reportKanbanHealth(events,error);}
    return runtime.service;
}
function personalExtensions(context:KanbanRuntimeContext,options:PersonalKanbanAutomationOptions|undefined,events:UserEventService,log:ReturnType<typeof personalOptions>['log'],setOperations:(value:ReturnType<typeof import('@nestos/kanban-development').createItemOperations>|undefined)=>void,client:()=>KanbanClient):KanbanRuntimeExtension[] {
    const {service,journal,workLog,fs,serviceFor}=context;
    const resourcePorts=options?.workResources?.({service,journal,workLog}),{archiveItemResources,...resources}=resourcePorts??{};
    const operations=options?.itemOperations?.({service,journal,workLog,log,automaticTarget:(_board,item)=>workProjectId(item),automatic:async(board,item)=>{
        const context=await workContext(journal,board,item);if((context.decision?.snapshot as {completion?:string})?.completion!=='automatic')return false;
        return (await service.record(context.decision!.sourceBoardId,context.decision!.recordId)).status==='confirmed';
    },cleanup:async(board,item,id)=>{
        const execution=await service.executionSession(board,item,{includeRelated:true});
        for(const session of new Set([execution.current?.sessionId,...execution.sessions?.map(row=>row.sessionId)??[],...execution.history.map(row=>row.sessionId)].filter((id):id is string=>!!id))){try{await options.archiveSession?.(session,id+'-archive-'+sha256HexSync(session).slice(0,12));}catch(error){if(['SESSION_ARCHIVE_STILL_RUNNING','SESSION_ARCHIVE_OUTCOME_UNKNOWN'].includes((error as {code:string}).code))return false;throw error;}}
        const rows=await resources.workResources?.(board,item,{inspect:true})??[];
        if(rows.length&&!resources.cleanupWorkResource)return false;
        for(const row of rows){if(row.state==='cleaned'||row.resolution?.kind==='ignored')continue;assertWorkspaceCleanup(row);await resources.cleanupWorkResource?.(board,{itemId:item,resourceId:row.id,version:row.version,operationId:id+'-cleanup-'+sha256HexSync(row.id).slice(0,12)});}
        return true;
    },reportAutomatic:async state=>{
        await workLog.append(service,state.boardId,state.itemId,{stage:state.handoff?'automatic.handoff':state.done?'automatic.completed':state.waitingForUser?'automatic.waiting-review':'automatic.blocked',result:state.code&&state.code!=='OPERATION_CANCELLED'?'failure':'success',dispatchId:state.id,code:state.code});
        if(state.waitingForUser)await events.journal.append('automatic-review:'+state.id,{type:'kanban.automatic.waiting-review',operationId:state.id,resourceId:'kanban:'+JSON.stringify(['personal:user-store',state.boardId,state.itemId]),notification:'info'});
        if(state.code&&state.code!=='OPERATION_CANCELLED')await events.journal.append('automatic:'+state.id+':'+state.code,{type:'kanban.automatic.blocked',operationId:state.id,resourceId:'kanban:'+JSON.stringify(['personal:user-store',state.boardId,state.itemId]),notification:'error'});
    }});setOperations(operations);
    const operationPlugins=[...operations?[createSoftwareDevelopmentPlugin(()=>operations)]:[],...options?.operationPlugins??[]];
    const recovery=options?.taskRecovery?.({service,client,journal,log});
    const conversations=options?.decisionConversations?.({service,client,journal,log});
    const communication=options&&conversations?taskCommunication(service,journal,options,conversations.openRecordCoordination,log):undefined;
    const fixes=options?.collaboration?createTaskFix({service,journal,events,automation:options,log}):undefined;
    const automation=options?createPersonalKanbanAutomation({...options,operationPlugins,fs,service,journal,workLog,log,serviceFor,deliveryReady:operations?.deliveryReady,notifyCoordination:coordinationNotifications(events),beforeCancel:fixes?cancelItemFixes(fixes):undefined}):undefined;
    const replies=options?.enqueueTaskReply?taskReplies(service,journal,options):undefined;
    const release=fixes?options?.registerInstructionGate?.((id,input)=>fixes.intercept(id,input)):undefined;
    const planning=options?planningSessionReader(service,journal,options):undefined;
    return [{operationPlugins,projectRecords:(board,page)=>recordFollowUps(journal,board,page,operations?.finalizationStatus),archiveItemResources,capabilities:{...(options?.boardSettings?{boardSettings:async(board:string)=>options.boardSettings!.catalog(await service.read(board))}:{}),...(recovery?{taskRecovery:recovery.taskRecovery,recoverTask:recovery.recoverTask,openTaskRecovery:recovery.openTaskRecovery}:{}),...(conversations?{startRecordConversation:conversations.startRecordConversation,openRecordCoordination:conversations.openRecordCoordination,...communication,recordConversations:conversations.recordConversations}:{}),...(planning?{planningSession:planning}:{}),...resources,
        ...(resources?.cleanupWorkResource&&operations?{cleanupWorkResource:(board,request)=>request.resolution==='ignore'?resources.cleanupWorkResource!(board,request):operations.guardResource(board,request.itemId,()=>resources.cleanupWorkResource!(board,request))}:{}),
        ...(options?.continuation?{executionSession:async(board,item,query)=>{
            const detail=await service.executionSession(board,item,query),current=(await service.item(board,item)).item;
            const previous=Object.values((await service.workflow(board)).dispatches).filter(row=>row.itemId===item).sort((a,b)=>b.attempt-a.attempt)[0];
            return {...detail,...(['backlog','open'].includes(current.status)&&previous&&['failed','cancelled'].includes(previous.outcome)?{continuation:{previousDispatchId:previous.id}}:{})};
        }}:{}),...(fixes?{fixTask:fixes.fixTask,taskFixes:fixes.taskFixes,cancelFix:fixes.cancelFix}:{}),...(replies?{replyTask:replies}:{})},scan:async()=>{await conversations?.scan();await recovery?.scan();},quiesce:async()=>{await conversations?.quiesce();await recovery?.quiesce();release?.();}},
        ...automation?[{...automation,capabilities:{automationCatalog:automation.automationCatalog,analysisStatus:automation.analysisStatus}}]:[],...fixes?[fixes]:[],...replies?[replies]:[]];
}


type PersonalOptions = {
    store: Awaited<ReturnType<typeof openPersonalKanbanStore>>; journal: KanbanAutomationJournal;
    events: UserEventService; diagnostics: DiagnosticJournal;
    sessions?: Pick<import('@nestos/llm-session/contracts').ISessionRepository, 'listSummaries' | 'getManifest'>;
    activity?:import('@nestos/llm-session').SessionActivityReader; automationOptions?: PersonalKanbanAutomationOptions;
};
function personalOptions({store, journal, events, diagnostics, sessions, activity, automationOptions}: PersonalOptions) {
    return {
        executionSessions:sessions&&activity?{source:{...createLocalKanbanSessionSource(sessions,activity,automationOptions?.executionResource,automationOptions?.sessionObservation),
            ...(automationOptions ? {related: relatedKanbanSessions({journal, calls: automationOptions.calls,
                executionReader:automationOptions.executionReader,
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
            if(command?.type==='configure-board-settings')await automationOptions?.boardSettings?.validate(board,command.settings);
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
