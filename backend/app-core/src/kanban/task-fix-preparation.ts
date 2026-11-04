import {sha256HexSync,randomUUID} from '@nestos/common';
import type {KanbanBoard,KanbanItem,KanbanDispatch} from '@nestos/kanban/contracts';
import type {Options,SavedFix} from './task-fix-contracts';
import {workContext} from './work-context';
import {requireValue} from './validation';
export async function freezeFix(options:Options,boardId:string,request:{itemId:string;operationId:string}):Promise<SavedFix> {
    requireValue(/^[\w-]{1,128}$/.test(request.operationId),'INVALID_OPERATION_ID');
    const board=await options.service.read(boardId),item=(await options.service.item(boardId,request.itemId)).item;
    requireValue(item.launch?.admittedAt!==undefined||['claimed','review','completed'].includes(item.status),'FIX_REQUIRES_STARTED_TASK');
    const key='fix-operation:'+boardId+':'+request.operationId;
    const id=await options.journal.update<string>(key,old=>old??randomUUID());
    let fix=await options.journal.get<SavedFix>('fix:'+id);
    if(fix)requireValue(fix.boardId===boardId&&fix.item.id===item.id,'IDEMPOTENCY_CONFLICT');
    fix ??= await newFix(options,id,board,item);
    await options.journal.update<string[]>('fix-index',old=>old?.includes(id)?old:[...old??[],id]);
    return fix;
}
async function newFix(options:Options,id:string,board:KanbanBoard,item:KanbanItem):Promise<SavedFix> {
    const boardId=board.id;
    const refs=item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project')??[];
    requireValue(refs.length===1&&options.automation.projects?.openWorkspace,'SINGLE_PROJECT_TASK_REQUIRED');
    const context=await workContext(options.journal,board,item);
    const decision=await decisionSnapshot(options,context.decision);
    const parent=item.planning?.parentId?(await options.service.item(board.id,item.planning.parentId)).item:null;
    const input={...context,parent,task:structuredClone(item),decision,fix:{id,sourceSessionId:id,
        directory:'_nestos/kanban/fix/'+id,proposalPath:'_nestos/kanban/fix/'+id+'/proposal.yaml',definitionPath:'_nestos/kanban/fix/'+id+'/kanban.yaml'}};
    const dispatch:KanbanDispatch={id,itemId:item.id,itemRevision:item.revision,planId:id,planRevision:1,principal:board.automation!.worker,
        definitionDigest:sha256HexSync(JSON.stringify(input)),attempt:1,fence:id,preparedAt:Date.now(),outcome:'prepared',inputs:{}};
    // Persist context before worktree/Session preparation and before any external submission.
    return options.journal.update<SavedFix>('fix:'+id,old=>old??{id,boardId,itemId:item.id,sessionId:id,state:'clarifying',phase:'prepared',dispatch,item:structuredClone(item),projectId:refs[0].id,context:input,request:null});
}

async function decisionSnapshot(options:Options,identity:Awaited<ReturnType<typeof workContext>>['decision']) {
    if(!identity)return null;
    const runs=await options.journal.get<Array<{id:string;record:import('@nestos/kanban/contracts').KanbanProjectRecord}>>('record-runs:'+identity.sourceBoardId);
    const record=runs?.find(run=>run.id===identity.runId)?.record??await options.service.record(identity.sourceBoardId,identity.recordId);
    requireValue(record.id===identity.recordId&&record.revision===identity.recordRevision,'FIX_DECISION_REVISION_UNAVAILABLE');
    return {...identity,record};
}
