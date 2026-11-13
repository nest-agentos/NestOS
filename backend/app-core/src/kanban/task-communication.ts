import type {KanbanClient,KanbanRecordConversation} from '@nestos/kanban/contracts';
import {safeCode,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import {planningSessionReader} from './planning-sessions';
import {workContext} from './work-context';
import {requireValue} from './validation';
import {managementOwner} from './task-owner';
type Request={itemId:string;operationId:string};
type Log=(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number})=>void;
/** Routing is advisory; native execution receipts still control task settlement. */
export function taskCommunication(service:KanbanClient,journal:KanbanAutomationJournal,options:PersonalKanbanAutomationOptions,open:NonNullable<KanbanClient['openRecordCoordination']>,log?:Log){
    const coordinate=async(boardId:string,request:Request)=>{
        const board=await service.read(boardId),item=(await service.item(boardId,request.itemId)).item,context=await workContext(journal,board,item,service);
        requireValue(context.decision,'DECISION_LINK_UNAVAILABLE');
        const owner=await managementOwner(service,board,item)??item;
        const current=owner.purpose==='planning'||owner.planning?.execution==='children'
            ?await planningSessionReader(service,journal,options)(boardId,owner.id):undefined;
        if(current)return {id:current.analysisId,boardId,recordId:context.decision.recordId,sessionId:current.sessionId,
            resourceId:current.resourceId??current.sessionId,state:current.state==='waiting-input'?'blocked' as const:current.state==='completed'?'confirmed' as const:'clarifying' as const,
            createdAt:current.createdAt??owner.createdAt,purpose:'coordination' as const};
        return open(context.decision.sourceBoardId,{recordId:context.decision.recordId,operationId:request.operationId});
    };
    return {openTaskCoordination:coordinate,openTaskCommunication:async(boardId:string,request:Request):Promise<KanbanRecordConversation>=>{
        const started=Date.now();
        try{
            const current=await originalTaskSession(service,journal,options,boardId,request.itemId);
            const result=current??await coordinate(boardId,request);
            log?.({operationId:request.operationId,boardId,stage:current?'task.communication.self':'task.communication.parent',result:'success',durationMs:Date.now()-started});
            return result;
        }catch(error){log?.({operationId:request.operationId,boardId,stage:'task.communication.resolve',result:'failure',code:safeCode(error,'COMMUNICATION_SESSION_FAILED'),durationMs:Date.now()-started});throw error;}
    }};
}
async function originalTaskSession(service:KanbanClient,journal:KanbanAutomationJournal,options:PersonalKanbanAutomationOptions,boardId:string,itemId:string):Promise<KanbanRecordConversation|undefined>{
    const {item,task}=await service.item(boardId,itemId);
    if(item.purpose==='planning'||item.planning?.execution==='children'){
        const current=item.analysis?.handler==='self'?await planningSessionReader(service,journal,options)(boardId,item.id):undefined;
        if(current?.state==='waiting-input')return {id:current.analysisId,boardId,sessionId:current.sessionId,resourceId:current.resourceId??current.sessionId,state:'blocked',createdAt:current.createdAt??item.createdAt};
        return;
    }
    const issues=item.issues?.filter(issue=>!issue.resolvedBy)??[];
    if(!task?.sessionId||!issues.length||issues.some(issue=>issue.handler!=='self'))return;
    const dispatch=(await service.workflow(boardId)).dispatches[task.dispatchId??''];
    if(dispatch&&['prepared','running'].includes(dispatch.outcome))return {id:dispatch.id,boardId,sessionId:task.sessionId,resourceId:await options.executionResource?.(task.sessionId,'main')??task.sessionId,state:'blocked',createdAt:dispatch.preparedAt};
}
