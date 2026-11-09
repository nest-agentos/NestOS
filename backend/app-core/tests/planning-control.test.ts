import {it,expect,vi} from 'vitest';
import {planningConversationControl} from '../src/presets/kanban-planning-control';
function fixture(status='completed') {
    const data=new Map<string,unknown>([['development-workspace:scope',{projectId:'p'}]]);
    const execution={sessionId:'s',turnId:'t',status,revision:4};
    const claim=new Set<string>();
    const journal={get:async(key:string)=>structuredClone(data.get(key)),update:async(key:string,change:any)=>{const next=change(data.get(key));data.set(key,next);return next;},claim:async(key:string)=>{if(claim.has(key))return false;claim.add(key);return true;}};
    const client={profiles:vi.fn(async()=>({epoch:'epoch'})),interrupt:vi.fn(async()=>{}),operation:vi.fn(async()=>({outcome:'committed'})),close:vi.fn(async()=>{})};
    const remote={sessionChannel:vi.fn(async(_p:string,op:string)=>op==='messages'?{execution}:{}),projectHarness:vi.fn(async()=>client)};
    const options={remote,connections:{get:vi.fn(async()=>({connection:{profileId:'codex'}}))}};
    const control=planningConversationControl(options as any,journal as any);
    const input={scopeId:'scope',operationId:'cancel',action:'cancel' as const};
    return {control,input,remote,client,execution,data,options};
}
it('only closes an idle retained conversation with its observed revision',async()=>{
    const f=fixture();expect(await f.control(f.input)).toBe('cancelled');
    expect(f.remote.sessionChannel).toHaveBeenLastCalledWith('p','close',{scopeId:'scope',expectedExecutionRevision:4,requireIdle:true});
    expect(f.client.interrupt).not.toHaveBeenCalled();
});
it('freezes one interruption and only inspects its original receipt on retry',async()=>{
    const f=fixture('running');expect(await f.control(f.input)).toBe('accepted');expect(await f.control(f.input)).toBe('accepted');
    expect(f.client.interrupt).toHaveBeenCalledTimes(1);expect(f.client.operation).toHaveBeenCalledWith('codex','cancel',{epoch:'epoch'});
    f.execution.status='interrupted';expect(await f.control(f.input)).toBe('cancelled');
});
it('does not report unknown or submitting conversations as cancelled or paused',async()=>{
    for(const status of ['unknown','submitting']){
        const f=fixture(status);expect(await f.control(f.input)).toBe('unknown');
        await expect(f.control({...f.input,action:'pause'})).rejects.toMatchObject({code:'TASK_CONTROL_UNSUPPORTED'});
        expect(f.remote.sessionChannel.mock.calls.some(row=>row[1]==='close')).toBe(false);
    }
});
it('does not repeat an interrupt whose response was lost',async()=>{
    const f=fixture('running');f.client.interrupt.mockRejectedValueOnce(Error('NETWORK'));
    await expect(f.control(f.input)).rejects.toThrow('NETWORK');
    expect(await f.control(f.input)).toBe('accepted');expect(f.client.interrupt).toHaveBeenCalledTimes(1);
});

it('uses the original worktree connection when a review scope reuses its native conversation',async()=>{
 const f=fixture('running');f.data.set('development-workspace:scope',{projectId:'p',worktreeId:'original-worktree'});
 expect(await f.control(f.input)).toBe('accepted');expect(f.options.connections.get).toHaveBeenCalledWith('work-original-worktree');
});
it('preserves an authoritative rejected interrupt receipt instead of reporting acceptance',async()=>{
 const f=fixture('running');await f.control(f.input);
 f.client.operation.mockResolvedValueOnce({outcome:'not-committed',code:'EACCES'} as never);
 await expect(f.control(f.input)).rejects.toMatchObject({code:'EACCES',cancelRejected:true});expect(f.client.interrupt).toHaveBeenCalledOnce();
});
