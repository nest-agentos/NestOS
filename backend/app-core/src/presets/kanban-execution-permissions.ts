import {parseSoftwareExecutionPermissions,softwareExecutionPermission} from '@nestos/kanban-development';
import {createModuleLogger,t} from '@nestos/common';
import {itemWithinRoots} from '@nestos/kanban/integration';
import type {KanbanProjectRecord,KanbanRecordExecution} from '@nestos/kanban/contracts';
import {answerExecutionPermissions,type ExecutionPermissionPorts} from '../kanban/execution-permissions';
import {hasDecisionModule,type KanbanApprovalModule} from '../kanban/decision-modules';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/resource-catalog';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {DevelopmentWorkspaceRecord} from './kanban-development';

type Observation=Parameters<NonNullable<PersonalKanbanAutomationOptions['observeApprovals']>>[0];
const log=createModuleLogger('kanban-permissions');
const moduleId='software-development';

export function softwareApprovalModule(settings:unknown):KanbanApprovalModule {
    const policy=parseSoftwareExecutionPermissions(settings);
    return {id:moduleId,version:'1',label:t('kanban.module.softwareDevelopment'),description:t('kanban.module.softwareDevelopmentHelp'),
        decide:context=>softwareExecutionPermission(policy,context)};
}

export function observeDevelopmentPermissions(remote:ProjectRemoteMountService,modules:readonly KanbanApprovalModule[],execute:ExecutionPermissionPorts['execute']) {
    return async (input:Observation)=>{
        if(input.call.receipt.operationId!==input.dispatch.id||input.call.input.request.expectedSessionId!==input.call.receipt.callerSessionId)return;
        const workspace=await input.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+input.dispatch.id);
        const source=(workspace?.context as {decision?:{recordId:string;sourceBoardId:string;runId:string;snapshot?:KanbanProjectRecord}}|undefined)?.decision;
        if(!workspace||!source)return;
        const selected=modules.filter(module=>hasDecisionModule(source.snapshot?.externalRefs,module));
        if(!selected.length)return;
        await answerExecutionPermissions({journal:input.journal,execute,log:event=>{
            log[event.result==='failure'?'warn':'info']('Execution permission evaluated',{operation:'kanban.permission',...event});
        },decide:request=>decide(remote,input,workspace,selected,request),canAnswer:()=>canAnswer(input,workspace,source,selected)},input.boardId,input.call);
    };
}

async function decide(remote:ProjectRemoteMountService,input:Observation,workspace:DevelopmentWorkspaceRecord,modules:readonly KanbanApprovalModule[],request:Record<string,unknown>) {
    const choice=await input.journal.get<{boardId:string;role:string;profileId:string}>('kanban-harness-choice:'+input.dispatch.id);
    if(choice?.boardId!==input.boardId||choice.role!=='execution')return {decision:'manual' as const,code:'PERMISSION_SESSION_SCOPE_CHANGED'};
    const context={projectId:workspace.projectId,profileId:choice.profileId,request};
    const preliminary=modules.map(module=>module.decide({...context,cwd:typeof request.cwd==='string'?request.cwd:null}));
    if(!preliminary.some(verdict=>verdict.decision==='allow'))return preliminary[0];
    const cwd=await boundDirectory(remote,workspace,choice.profileId,request);
    const verified=modules.map(module=>module.decide({...context,cwd}));
    return verified.find(verdict=>verdict.decision==='allow')??verified[0];
}

async function boundDirectory(remote:ProjectRemoteMountService,workspace:DevelopmentWorkspaceRecord,profileId:string,request:Record<string,unknown>):Promise<string|null> {
    const envelope=await remote.sessionChannel(workspace.projectId,'messages',{scopeId:workspace.channelId}) as {execution?:{sessionId:string}};
    const execution=envelope.execution;
    if(!execution?.sessionId||request.threadId!==execution.sessionId||typeof request.turnId!=='string')return null;
    const client=await remote.projectHarness(workspace.projectId,{requireRegistered:true});
    try {
        const observed=await client.inspect?.(profileId,execution.sessionId,{timeoutMs:5000});
        if(observed?.session.id!==execution.sessionId||observed.session.activeTurnId!==request.turnId)return null;
        return observed.session.cwd;
    }finally{await client.close();}
}

async function canAnswer(input:Observation,workspace:DevelopmentWorkspaceRecord,source:{recordId:string;sourceBoardId:string;runId:string},modules:readonly KanbanApprovalModule[]) {
    const [board,workflow,record]=await Promise.all([input.service.read(input.boardId),input.service.workflow(input.boardId),
        input.service.record(source.sourceBoardId,source.recordId)]);
    const dispatch=workflow.dispatches[input.dispatch.id],item=board.items.find(item=>item.id===input.dispatch.itemId);
    if(!dispatch||dispatch.fence!==input.dispatch.fence||!['prepared','running'].includes(dispatch.outcome))return false;
    if(board.lifecycle||board.deletedAt!==undefined||board.executionControl?.paused||!board.automation?.enabled)return false;
    if(!item||item.deletedAt!==undefined||item.restartPending||item.control?.action==='cancel'||item.control?.action==='pause')return false;
    if(!item.externalRefs?.some(ref=>ref.system==='nestos-decision-run'&&ref.id===source.runId))return false;
    const run=source.sourceBoardId===input.boardId?undefined:await input.journal.run<KanbanRecordExecution>(source.sourceBoardId,source.runId);
    const roots=source.sourceBoardId===input.boardId?record.itemIds:
        run?.boardId===input.boardId&&run.recordId===record.id&&run.archivedAt===undefined?(run.rootItemId?[run.rootItemId]:run.itemIds??[]):[];
    return record.status==='confirmed'&&record.archivedAt===undefined&&record.deletedAt===undefined
        &&itemWithinRoots(board.items,item.id,roots)
        &&item.externalRefs?.some(ref=>ref.system===REMOTE_PROJECT_REFERENCE&&ref.id===workspace.projectId)===true
        &&modules.every(module=>hasDecisionModule(record.externalRefs,module));
}
