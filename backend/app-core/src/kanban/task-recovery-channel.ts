import {conversationPolicy,conversationInstruction} from './conversation-policy';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import type {KanbanTaskRecoveryRequest,KanbanTaskRecoveryResult} from '@nestos/kanban/contracts';
import {DirectorySubscriptions} from '../run/directory-subscriptions';
import {channelRequests,channelDigest,type ChannelResponse,type ChannelRequest} from '../run/channel-protocol';
import type {TaskRecoveryOptions,RecoverySession} from './task-recovery-ports';
import {requireValue} from './validation';
interface Ports {active():boolean;inspect:typeof import('./task-recovery-state').taskRecoveryState;recoverTask(board:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult>}
export function taskRecoveryChannels(options:TaskRecoveryOptions,ports:Ports) {
    const watches=new DirectorySubscriptions(),pending=new Map<string,Promise<void>>(),restored=new Set<string>();
    const advance=(scope:RecoverySession)=>{if(!ports.active())return Promise.resolve();const next=(pending.get(scope.scopeId)??Promise.resolve()).catch(()=>{}).then(()=>processRequests(options,ports,scope));pending.set(scope.scopeId,next);void next.finally(()=>{if(pending.get(scope.scopeId)===next)pending.delete(scope.scopeId);}).catch(()=>{});return next;};
    const watch=async(scope:RecoverySession)=>{await watches.ensure(scope.scopeId,async()=>{const client=await options.remote.projectHarness(scope.projectId);try{requireValue(client.subscribeChannel,'SESSION_CHANNEL_REQUIRED');const stop=client.subscribeChannel(scope.scopeId,()=>{void advance(scope).catch(error=>options.log({operationId:scope.dispatchId,boardId:scope.boardId,stage:'task.recovery.channel',result:'failure',code:safeCode(error),durationMs:0}));});return async()=>{stop();await client.close();};}catch(error){await client.close();throw error;}});restored.add(scope.scopeId);};
    return {open:async(boardId:string,request:{itemId:string;operationId:string})=>{
        const state=await ports.inspect(options,boardId,request.itemId);requireValue(state.resourceId,'CONTINUATION_SESSION_UNKNOWN');
        const target=resolveBrowserTarget(state.resourceId);requireValue(target.kind==='remote'&&target.profileId&&target.nativeSessionId,'CONTINUATION_NATIVE_SESSION_UNKNOWN');
        const dispatch=Object.values((await options.service.workflow(boardId)).dispatches).filter(row=>row.itemId===request.itemId).sort((a,b)=>b.attempt-a.attempt)[0];requireValue(dispatch,'EXECUTION_NOT_FOUND');
        const record=await options.journal.get<import('../presets/kanban-development').DevelopmentWorkspaceRecord>('development-workspace:'+dispatch.id);requireValue(record?.channelId,'CONTINUATION_WORKSPACE_UNAVAILABLE');
        const scope=await options.journal.update<RecoverySession>('task-recovery-session:'+dispatch.id,old=>old??{boardId,itemId:request.itemId,dispatchId:dispatch.id,scopeId:record.channelId!,projectId:record.projectId,profileId:target.profileId!,sessionId:target.nativeSessionId!,resourceId:state.resourceId!});
        await watch(scope);
        if(!scope.ready){await enqueue(options,scope,'recovery-open-'+dispatch.id,(await conversationPolicy(options.fs)).recoveryBootstrap);await options.journal.update<RecoverySession>('task-recovery-session:'+dispatch.id,old=>({...old!,ready:true}));}
        await advance(scope);return {operationId:request.operationId,state:'accepted' as const,resourceId:scope.resourceId};
    },recover:async()=>{for(const row of await options.journal.find<RecoverySession>('task-recovery-session:',()=>true)){if(!ports.active())return;if(!restored.has(row.value.scopeId)){await watch(row.value);void advance(row.value).catch(error=>options.log({operationId:row.value.dispatchId,boardId:row.value.boardId,stage:'task.recovery.restore',result:'failure',code:safeCode(error),durationMs:0}));}}},close:async()=>{await watches.dispose();await Promise.allSettled([...pending.values()]);}};
}
async function processRequests(options:TaskRecoveryOptions,ports:Ports,scope:RecoverySession):Promise<void> {
    if(!ports.active())return;
    const rows=channelRequests(await options.remote.sessionChannel(scope.projectId,'requests',{scopeId:scope.scopeId}),scope.scopeId);
    const envelope=await options.remote.sessionChannel(scope.projectId,'messages',{scopeId:scope.scopeId}) as {execution?:{status?:string}};
    if(['running','submitting'].includes(envelope.execution?.status??''))return;
    for(const row of rows.filter(row=>row.request.method.startsWith('kanban.recovery.'))) {
        if(!ports.active())return;
        const key='task-recovery-response:'+scope.scopeId+':'+row.request.id;
        let response=await options.journal.get<ChannelResponse>(key);
        if(!response) {
            try{response={id:row.request.id,scopeId:scope.scopeId,requestDigest:row.requestDigest,status:'ok',payload:await resolve(options,ports,scope,row.request),error:null};}
            catch(error){const code=safeCode(error);if(['EIO','HTTP_CONNECTION_LOST','SERVICE_STOPPING'].includes(code))throw error;response={id:row.request.id,scopeId:scope.scopeId,requestDigest:row.requestDigest,status:'error',payload:null,error:{code}};}
            response=await options.journal.update<ChannelResponse>(key,old=>old??response!);
        }
        if(!row.response){const value=await options.remote.sessionChannel(scope.projectId,'respond',response as unknown as Record<string,unknown>);requireValue(channelDigest(value)===channelDigest(response),'CHANNEL_RESPONSE_CHANGED');}
        const result=response.payload as KanbanTaskRecoveryResult|undefined;
        if(result?.dispatchId)continue;
        if(ports.active()&&!await options.journal.get<boolean>(key+':resumed')){await enqueue(options,scope,'recovery-response-'+row.request.id,conversationInstruction((await conversationPolicy(options.fs)).resumeRecovery,row.request.id));await options.journal.update(key+':resumed',()=>true);}
    }
}
async function resolve(options:TaskRecoveryOptions,ports:Ports,scope:RecoverySession,request:ChannelRequest):Promise<unknown> {
    const state=await ports.inspect(options,scope.boardId,scope.itemId);
    if(request.method==='kanban.recovery.inspect')return {...state,methods:[{method:'kanban.recovery.retry',params:{expectedRevision:state.revision},available:state.canRetry},{method:'kanban.recovery.retry-current',params:{expectedRevision:state.revision},available:state.canSelectCurrentVersion,confirmationRequired:true},{method:'kanban.recovery.fix',params:{expectedRevision:state.revision,sourceItemId:state.related[0]?.itemId??scope.itemId},available:true}],confirmation:(await conversationPolicy(options.fs)).confirmVersion};
    const action=request.method==='kanban.recovery.retry'?'retry':request.method==='kanban.recovery.retry-current'?'retry-current':request.method==='kanban.recovery.fix'?'fix':undefined;requireValue(action,'RECOVERY_METHOD_UNSUPPORTED');
    requireValue(request.params.itemId===undefined||request.params.itemId===scope.itemId,'RECOVERY_SCOPE_MISMATCH');
    if(action==='retry-current') {
        const port=await options.remote.projectConversation(scope.projectId,scope.profileId,scope.sessionId);
        try {const message=(await port.read()).messages.filter(row=>row.role==='user').at(-1);requireValue(message?.text.trim()===(await conversationPolicy(options.fs)).confirmVersion,'RECOVERY_USER_CONFIRMATION_REQUIRED');requireValue(request.params.expectedRevision===state.revision,'RECOVERY_STALE_REFRESH');
            await options.journal.update<{digest:string}>('recovery-user-confirmation:'+scope.sessionId+':'+message.id,old=>{const digest=channelDigest(request);requireValue(!old||old.digest===digest,'RECOVERY_CONFIRMATION_ALREADY_USED');return old??{digest};});}
        finally{await port.close();}
    }
    return ports.recoverTask(scope.boardId,{operationId:'recovery-'+request.id,itemId:scope.itemId,expectedRevision:String(request.params.expectedRevision??''),action,sourceItemId:typeof request.params.sourceItemId==='string'?request.params.sourceItemId:undefined,confirmed:action==='retry-current'});
}
async function enqueue(options:TaskRecoveryOptions,scope:RecoverySession,id:string,text:string):Promise<void> {
    const port=await options.remote.projectConversation(scope.projectId,scope.profileId,scope.sessionId);
    try{requireValue(port.enqueue,'NATIVE_QUEUE_UNSUPPORTED');await port.enqueue(text,[],undefined,id,'next-turn');}finally{await port.close();}
}
function safeCode(error:unknown):string {const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'TASK_RECOVERY_FAILED';}
