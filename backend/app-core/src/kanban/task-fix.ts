import {currentCoordination,KanbanCollaboration,createTaskFix as createFixRuntime} from '@nestos/kanban/integration';
import type {KanbanDispatch} from '@nestos/kanban/contracts';
import type {SessionInstruction,IndependentCallInput,SubmissionRequest} from '@nestos/llm-session/contracts';
import type {Options} from './task-fix-contracts';

import {acceptSnapshot} from './task-fix-acceptance';
import {observeFixMessages} from './task-fix-messages';
import {confirmFix} from './task-fix-confirmation';
import {freezeFix} from './task-fix-preparation';
import {kanbanControlOptions} from './control-adapter';
import {requireValue} from './validation';
/** Fix is a scoped round in the original Session, never a replacement execution. */
export function createTaskFix(options:Options) {
    const executor={
        async prepare(dispatch:KanbanDispatch) {
            const fix=await new KanbanCollaboration(options.service,options.journal).fix(dispatch.id);
            requireValue(fix.origin&&options.automation.collaboration,'CONTINUATION_UNSUPPORTED');
            const original=await options.automation.originalSession(fix.origin.input as IndependentCallInput);
            const owner=await options.journal.get<string>('fix-session:'+original.sessionId);
            if(owner&&owner!==fix.id){const active=await new KanbanCollaboration(options.service,options.journal).fix(owner);requireValue(active.accepted||active.state==='cancelled','COLLABORATION_IN_USE');}
            const instruction=await options.automation.collaboration.prepare({id:fix.id,originId:fix.origin.id,...original,
                context:fix.context,item:fix.item,board:await options.service.read(fix.boardId)});
            return {schema:3,request:original.request(fix.id,instruction)};
        },
        start:async(value:unknown)=>observe(options,value,true),inspect:async(value:unknown)=>observe(options,value,false),
    };
    const runtime=createFixRuntime<SessionInstruction>({service:options.service,journal:options.journal,executor,
        control:{control:async request=>{
            const fix=await new KanbanCollaboration(options.service,options.journal).fix(request.executionId);
            const frozen=fix.request as {schema:number;request:SubmissionRequest}|null;
            return kanbanControlOptions(options.automation,options.journal).control.control({...request,
                ...(frozen?.schema===3?{executionId:fix.sessionId,attemptId:fix.id,kind:'submission' as const,prepared:frozen.request}:{})});
        }},
        freeze:(board,request)=>freezeFix(options,board,request),confirm:(fix,input)=>confirmFix(options,fix,input),
        observe:fix=>observeFixMessages(options,fix),accept:fix=>acceptSnapshot(options,fix),log:options.log});
    return {...runtime,fixTask:async(boardId:string,request:{itemId:string;operationId:string})=>{
        const item=(await options.service.item(boardId,request.itemId)).item;
        if(item.planning?.parentId){const parent=(await options.service.item(boardId,item.planning.parentId)).item;if(parent.planning?.execution==='children')request={...request,itemId:parent.id};}
        const current=await currentCoordination(options.journal,boardId,request.itemId),input=current?.request as SubmissionRequest|undefined;
        if(current&&current.phase!=='settled'&&input?.expectedSessionId)return {id:current.id,boardId,itemId:request.itemId,sessionId:input.expectedSessionId,state:'clarifying' as const,code:current.code};
        return runtime.fixTask(boardId,request);
    }};
}
async function observe(options:Options,value:unknown,start:boolean) {
    const frozen=value as {schema:number;request:SubmissionRequest};
    requireValue(frozen?.schema===3&&frozen.request?.submission?.id,'INVALID_FROZEN_EXECUTION');
    requireValue(options.automation.collaboration,'CONTINUATION_UNSUPPORTED');
    const result=await options.automation.collaboration.submission[start?'start':'inspect'](frozen.request);
    return {...result,executionSessionId:result.sessionId};
}

export function cancelItemFixes(fixes:ReturnType<typeof createTaskFix>):NonNullable<import('./personal-automation').PersonalKanbanAutomationOptions['beforeCancel']> {
    return async(board,item,operation)=>{
        for(const fix of await fixes.taskFixes(board,item)) {
            if(['accepted','cancelled'].includes(fix.state))continue;
            if((await fixes.cancelFix(board,{fixId:fix.id,operationId:operation+'-fix'})).state!=='cancelled')return 'accepted';
        }
        return 'cancelled';
    };
}
