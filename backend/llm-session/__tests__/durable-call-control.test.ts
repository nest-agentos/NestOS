import {expect,it,vi} from 'vitest';
import {controlIndependentCall,type CallControlJournal,type DurableCallControlPorts} from '../src/session/durable-call-control';
import {IndependentCallCommand,type IndependentCallView} from '../src/contracts/independent-calls';
class Journal implements CallControlJournal{
    records=new Map<string,unknown>();
    async get<T>(key:string){return structuredClone(this.records.get(key)) as T|undefined;}
    async update<T>(key:string,change:(old:T|undefined)=>T){const next=change(structuredClone(this.records.get(key)) as T|undefined);this.records.set(key,structuredClone(next));return structuredClone(next);}
    async claim(key:string){const old=this.records.get(key) as {phase:string};if(old.phase!=='prepared')return false;this.records.set(key,{...old,phase:'submitting'});return true;}
}
function fixture(){
    const journal=new Journal(),request={sessionId:'parent',callId:'call',requestId:'control',action:'pause' as const};
    const view={input:{request:{submission:{id:'call'}}},receipt:{executionSessionId:'execution'},executionState:{id:'task',controlEpoch:4,settled:false},callerState:{settled:false},executionTree:{settled:false},controlCapabilities:{pause:'boundary',resume:true,withdrawPause:true,cancel:true,cancelRemaining:true}} as unknown as IndependentCallView;
    const list=vi.fn(async()=>[view]);
    const callControl=vi.fn(async(_command:string,input:any)=>({receipt:{current:{requestId:input.requestId,acknowledged:true}}}));
    const callCancel=vi.fn(async(_command:string,_input:unknown)=>({receipt:{}})),log=vi.fn();
    const ports={calls:{list},callControl,callCancel,log} as unknown as DurableCallControlPorts;
    return {journal,request,view,ports,list,callControl,callCancel,log,run:()=>controlIndependentCall(ports,journal,request)};
}
it('rejects the same identity with a changed action before any new control or query, including after settlement',async()=>{
    const f=fixture();expect(await f.run()).toBe('paused');
    for(const action of ['resume','cancel'] as const)await expect(controlIndependentCall(f.ports,f.journal,{...f.request,action})).rejects.toMatchObject({code:'CALL_CONTROL_IDEMPOTENCY_CONFLICT'});
    f.view.callerState!.settled=true;f.view.executionTree!.settled=true;
    await expect(controlIndependentCall(f.ports,f.journal,{...f.request,action:'resume'})).rejects.toMatchObject({code:'CALL_CONTROL_IDEMPOTENCY_CONFLICT'});
    expect(f.callControl).toHaveBeenCalledOnce();expect(f.callCancel).not.toHaveBeenCalled();
});
it('retains an identity even when the first call is already settled',async()=>{
    const f=fixture();f.view.callerState!.settled=true;f.view.executionTree!.settled=true;
    expect(await f.run()).toBe('paused');await expect(controlIndependentCall(f.ports,f.journal,{...f.request,action:'resume'})).rejects.toMatchObject({code:'CALL_CONTROL_IDEMPOTENCY_CONFLICT'});expect(f.callControl).not.toHaveBeenCalled();
});
it('never repeats a claimed write after response loss and queries without the obsolete epoch',async()=>{
    const f=fixture();f.callControl.mockRejectedValueOnce(Object.assign(new Error('Lost reply'),{code:'ECONNRESET'}));await expect(f.run()).rejects.toMatchObject({code:'ECONNRESET'});
    const restarted={...f.ports};expect(await controlIndependentCall(restarted,f.journal,f.request)).toBe('paused');
    expect(f.callControl.mock.calls.map(row=>row[0])).toEqual([IndependentCallCommand.Control,IndependentCallCommand.ControlReceipt]);
    expect(f.callControl.mock.calls[0][1].expectedEpoch).toBe(4);expect(f.callControl.mock.calls[1][1]).not.toHaveProperty('expectedEpoch');
});
it('treats a crash after claim but before dispatch as unknown and never resends',async()=>{
    const f=fixture(),key='independent-call-control:'+JSON.stringify(['parent','control']);
    await f.journal.update(key,()=>({phase:'submitting',action:'pause',command:IndependentCallCommand.Control,query:{...f.request,branchId:'main',executionSessionId:'execution',taskId:'task',expectedEpoch:4}}));
    f.callControl.mockResolvedValueOnce({} as never);expect(await f.run()).toBe('unknown');expect(f.callControl.mock.calls[0][0]).toBe(IndependentCallCommand.ControlReceipt);
});
it('preserves a legacy withdrawn pause as the original resume action without claiming another write',async()=>{
    const f=fixture(),keys={key:'host-key',legacyKey:'legacy-key'};
    await f.journal.update(keys.legacyKey,()=>({phase:'submitting',command:IndependentCallCommand.Control,query:{...f.request,action:'withdraw',branchId:'main',executionSessionId:'execution',taskId:'task',expectedEpoch:4}}));
    expect(await controlIndependentCall(f.ports,f.journal,{...f.request,action:'resume'},keys)).toBe('resumed');expect(f.callControl.mock.calls[0][0]).toBe(IndependentCallCommand.ControlReceipt);
    await expect(controlIndependentCall(f.ports,f.journal,f.request,keys)).rejects.toMatchObject({code:'CALL_CONTROL_IDEMPOTENCY_CONFLICT'});
});
it('rejects a rebound execution route and a missing control capability before writing',async()=>{
    const f=fixture();await f.run();f.view.receipt.executionSessionId='another';await expect(f.run()).rejects.toMatchObject({code:'CALL_CONTROL_SCOPE_MISMATCH'});expect(f.callControl).toHaveBeenCalledOnce();
    const g=fixture();g.view.controlCapabilities!.pause=undefined as never;await expect(g.run()).rejects.toMatchObject({code:'CALL_CONTROL_UNSUPPORTED'});expect(g.callControl).not.toHaveBeenCalled();
});
it('cancels the remaining tree and waits for both caller and tree to settle',async()=>{
    const f=fixture();f.view.executionState!.settled=true;f.view.callerState!.settled=true;
    expect(await controlIndependentCall(f.ports,f.journal,{...f.request,action:'cancel'})).toBe('accepted');expect(f.callCancel.mock.calls[0][0]).toBe(IndependentCallCommand.CancelRemaining);
    f.view.executionTree!.settled=true;expect(await controlIndependentCall(f.ports,f.journal,{...f.request,action:'cancel'})).toBe('cancelled');expect(f.callCancel).toHaveBeenCalledOnce();
});
it('does not let diagnostics replace a successful control result',async()=>{
    const f=fixture();f.log.mockImplementation(()=>{throw Error('Logger unavailable');});expect(await f.run()).toBe('paused');
});

it('serializes concurrent claims and rejects a concurrent conflicting action',async()=>{
    const f=fixture();await Promise.all([f.run(),f.run()]);expect(f.callControl.mock.calls.filter(row=>row[0]===IndependentCallCommand.Control)).toHaveLength(1);
    const g=fixture(),results=await Promise.allSettled([g.run(),controlIndependentCall(g.ports,g.journal,{...g.request,action:'resume'})]);
    expect(results.filter(row=>row.status==='rejected')).toHaveLength(1);expect(g.callControl.mock.calls.filter(row=>row[0]===IndependentCallCommand.Control)).toHaveLength(1);
});
