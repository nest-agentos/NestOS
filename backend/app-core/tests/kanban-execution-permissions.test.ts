import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {IndependentCallCommand,type IndependentCallView} from '@nestos/llm-session/contracts';
import {observeDevelopmentPermissions,softwareApprovalModule} from '../src/presets/kanban-execution-permissions';

const command='git status --short',cwd='/worktrees/current-task';
const pending={method:'item/commandExecution/requestApproval',command,cwd,threadId:'native',turnId:'turn',availableDecisions:['accept','acceptForSession']};
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});

async function fixture() {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});
    closes.push(()=>manager.dispose());
    const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));
    await journal.open();
    const refs=[{system:'nestos-decision-module',id:'software-development',revision:'1'}];
    const dispatch={id:'current-task',itemId:'item',fence:'fence',outcome:'running'};
    const decision={recordId:'decision',sourceBoardId:'board',runId:'run',snapshot:{externalRefs:refs}};
    await journal.update('development-workspace:current-task',()=>({projectId:'project',channelId:'channel',context:{decision}}));
    await journal.update('kanban-harness-choice:current-task',()=>({boardId:'board',role:'execution',profileId:'codex'}));
    const service={
        read:vi.fn(async()=>({automation:{enabled:true},items:[{id:'item',externalRefs:[{system:'nestos-decision-run',id:'run'},{system:'nestos-remote-project',id:'project'}]}]})),
        workflow:vi.fn(async()=>({dispatches:{'current-task':dispatch}})),
        record:vi.fn(async()=>({id:'decision',status:'confirmed',itemIds:['item'],externalRefs:refs})),
    };
    const call={receipt:{operationId:'current-task',callerSessionId:'caller',executionSessionId:'executor',execution:{role:'primary',taskId:'root'}},
        input:{request:{expectedBranch:'main',expectedSessionId:'caller'}},controlCapabilities:{respond:true},
        interactions:{items:[{taskId:'harness',interactionId:'approval',requestedAt:100,kind:'approval'}]}} as IndependentCallView;
    return {journal,dispatch,decision,service,call};
}

function automation(f:Awaited<ReturnType<typeof fixture>>) {
    const remote={sessionChannel:vi.fn(async()=>({execution:{sessionId:'native'}})),
        projectHarness:vi.fn(async()=>({inspect:vi.fn(async()=>({session:{id:'native',activeTurnId:'turn',cwd}})),close:vi.fn()}))};
    const native={...pending};
    let committed=false,loseResponse=false,submit=false;
    const execute=vi.fn(async(name:string,input:any)=>{
        if(name===IndependentCallCommand.Interaction)return {interaction:{kind:'approval',status:'pending',payload:native}};
        if(name===IndependentCallCommand.Respond){committed=submit;if(loseResponse)throw Object.assign(new Error('lost'),{code:'EIO'});}
        return committed?{receipt:{requestId:input.requestId,taskId:input.targetTaskId,interactionId:input.interactionId,resolvedAt:101}}:{};
    });
    const module=softwareApprovalModule({allow:[{projectId:'project',profileId:'codex',command}]});
    const observe=observeDevelopmentPermissions(remote as never,[module],execute as never);
    return {remote,native,execute,observe:()=>observe({...f,boardId:'board'} as never),submit:(success:boolean,lose=false)=>{submit=success;loseResponse=lose;}};
}

it('routes the original request to the selected module and reconciles a lost answer with its original receipt',async()=>{
    const f=await fixture(),a=automation(f);a.submit(true,true);
    await Promise.all([a.observe(),a.observe()]);
    await a.observe();
    const requests=a.execute.mock.calls.filter(([name])=>name===IndependentCallCommand.Respond);
    expect(requests).toHaveLength(1);
    const response=requests[0][1];
    expect(response).toMatchObject({callId:'current-task',executionSessionId:'executor',targetTaskId:'harness',interactionId:'approval',value:{decision:'accept'}});
    expect(a.execute).toHaveBeenCalledWith(IndependentCallCommand.ResponseReceipt,expect.objectContaining({requestId:response.requestId}));
    expect(await f.journal.get('execution-permission:'+response.requestId)).toMatchObject({phase:'committed'});
});

it('keeps unconfirmed answers observation-only, including across new observers',async()=>{
    const f=await fixture(),first=automation(f);first.submit(false,true);
    await first.observe();
    const restarted=automation(f);await restarted.observe();
    expect(restarted.execute.mock.calls.map(([name])=>name)).toEqual([IndependentCallCommand.ResponseReceipt]);
});

it.each([
    {command:'git status --short && chmod -R 777 .'}, {cwd:'/outside'},
    {availableDecisions:['acceptForSession']}, {additionalPermissions:{network:true}}, {turnId:'other-turn'},
])('leaves a different or wider request pending (%j)',async patch=>{
    const a=automation(await fixture());Object.assign(a.native,patch);await a.observe();
    expect(a.execute.mock.calls.map(([name])=>name)).toEqual([IndependentCallCommand.Interaction]);
});

it('preserves manual approval for historical decisions and a revoked selection',async()=>{
    const f=await fixture(),a=automation(f);
    f.service.record.mockResolvedValueOnce({id:'decision',status:'confirmed',itemIds:['item'],externalRefs:[]});
    await a.observe();
    expect(a.execute.mock.calls.map(([name])=>name)).toEqual([IndependentCallCommand.Interaction]);
    a.execute.mockClear();
    await f.journal.update('development-workspace:current-task',()=>({projectId:'project',channelId:'channel',context:{decision:{...f.decision,snapshot:{}}}}));
    await a.observe();
    expect(a.execute).not.toHaveBeenCalled();
});
