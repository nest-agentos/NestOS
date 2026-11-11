import {expect, it, vi} from 'vitest';
import {createSubmissionControl as submissionControl, type ControlJournal} from '@nestos/llm-session';
function fixture() {
    let task = {id:'primary',sessionId:'original',rootTaskId:'primary',labels:{roundId:'continuation'},program:{kind:'agent'},effects:{native:{status:'leased'}},status:'running',control:{epoch:2,mode:'run'},exit:undefined} as any;
    const child = {...task,id:'child',effects:{},exit:{status:'cancelled'}};
    let childrenSettled = false, lost = true;
    const cancel = vi.fn(async () => {if(lost) {lost=false;throw Object.assign(new Error('PRIVATE'),{code:'ECONNRESET'});}});
    const receipt = vi.fn(async () => ({requestId:'cancel'}));
    const kernel = {task:vi.fn(async()=>task),inspectSession:async()=>({snapshot:async()=>({tasks:[task,...childrenSettled?[]:[{...child,exit:undefined}]]})}),
        cancel,readTaskCancellationReceipt:receipt,readTaskTreeCancellationReceipt:receipt,cancelRemainingTaskTree:vi.fn(),controlTask:vi.fn(),withdrawTaskPause:vi.fn(),readTaskControlReceipt:vi.fn(async()=>({current:{requestId:'pause',acknowledged:true}}))};
    const repository = {readDocument:vi.fn(async()=>JSON.stringify({sessionId:'original',id:'continuation',executions:[{role:'primary',taskId:'primary'}]}))};
    const rows = new Map<string,any>();
    const journal:ControlJournal={get:async key=>rows.get(key),update:async(key,change)=>{const value=change(rows.get(key));rows.set(key,value);return value;},claim:async key=>{const row=rows.get(key);if(row.phase!=='prepared')return false;rows.set(key,{...row,phase:'submitting'});return true;}};
    const options={kernel,repository,contexts:{open:vi.fn()},ensureWritable:vi.fn(async()=>true)} as any;
    return {options,journal,kernel,repository,settle:()=>{task={...task,effects:{},exit:{status:'cancelled'}};},settleChildren:()=>{childrenSettled=true;}};
}
it('cancels the exact continuation round, observes lost replies without resubmission and waits for its full tree',async()=>{
    const f=fixture(),input={sessionId:'original',submissionId:'continuation',requestId:'cancel',action:'cancel' as const};
    await expect(submissionControl(f.options)(input,f.journal)).rejects.toMatchObject({code:'ECONNRESET'});
    expect(f.kernel.cancel).toHaveBeenCalledWith('original','primary','Cancelled by owner',{requestId:'cancel',expectedEpoch:2});
    f.settle();
    expect(await submissionControl(f.options)(input,f.journal)).toBe('accepted');
    expect(f.kernel.cancel).toHaveBeenCalledOnce();
    f.settleChildren();
    expect(await submissionControl(f.options)(input,f.journal)).toBe('cancelled');
    expect(f.options.contexts.open).not.toHaveBeenCalled();
});
it('rejects a mismatched round identity before controlling any task',async()=>{
    const f=fixture();f.repository.readDocument.mockResolvedValue(JSON.stringify({sessionId:'another',id:'continuation',executions:[]}));
    await expect(submissionControl(f.options)({sessionId:'original',submissionId:'continuation',requestId:'cancel',action:'cancel'},f.journal)).rejects.toMatchObject({code:'SUBMISSION_HISTORY_CONFLICT'});
    expect(f.kernel.cancel).not.toHaveBeenCalled();
});
it('keeps a known writer refusal retryable before claiming the persistent control',async()=>{
    const f=fixture();f.options.ensureWritable.mockResolvedValueOnce(false);
    const input={sessionId:'original',submissionId:'continuation',requestId:'pause',action:'pause' as const};
    await expect(submissionControl(f.options)(input,f.journal)).rejects.toMatchObject({code:'SESSION_WRITER_UNAVAILABLE'});
    expect(await submissionControl(f.options)(input,f.journal)).toBe('paused');
    expect(f.kernel.controlTask).toHaveBeenCalledOnce();
});

it('removes only the original queued continuation and reconciles a lost removal reply without resending',async()=>{
    const f=fixture();f.repository.readDocument.mockResolvedValue(undefined as never);
    f.options.repository.getManifest=vi.fn(async()=>({id:'original'}));
    let items=[{id:'continuation',state:'pending'}],lost=true; const cancelledIds:string[]=[];
    const execute=vi.fn(async(command:string)=>{
        if(command==='session.instructions.get')return {sessionId:'original',revision:2,items,cancelledIds};
        if(command==='session.instructions.edit'){items=[];cancelledIds.push('continuation');if(lost){lost=false;throw Object.assign(new Error('PRIVATE'),{code:'ECONNRESET'});}return;}
    });
    const dispose=vi.fn();f.options.contexts.open.mockResolvedValue({commandBus:{execute},dispose});
    const input={sessionId:'original',submissionId:'continuation',requestId:'cancel-queue',action:'cancel' as const};
    await expect(submissionControl(f.options)(input,f.journal)).rejects.toMatchObject({code:'ECONNRESET'});
    expect(await submissionControl(f.options)(input,f.journal)).toBe('cancelled');
    expect(execute.mock.calls.filter(row=>row[0]==='session.instructions.edit')).toHaveLength(1);
    expect(f.kernel.cancel).not.toHaveBeenCalled();expect(dispose).toHaveBeenCalledTimes(2);
});
it('does not cancel dispatching work or overwrite an admitted identity whose round is unknown',async()=>{
    const f=fixture();f.repository.readDocument.mockResolvedValue(undefined as never);
    f.options.repository.getManifest=vi.fn(async()=>({id:'original'}));
    let items=[{id:'continuation',state:'dispatching'}];
    const execute=vi.fn(async(command:string)=>{if(command==='session.instructions.edit')throw Object.assign(new Error('Admitted'),{code:'QUEUE_EXECUTION_UNSETTLED'});return {sessionId:'original',revision:2,items};});
    f.options.contexts.open.mockResolvedValue({commandBus:{execute},dispose:vi.fn()});
    const input={sessionId:'original',submissionId:'continuation',requestId:'cancel-queue',action:'cancel' as const};
    expect(await submissionControl(f.options)(input,f.journal)).toBe('unknown');
    items=[];expect(await submissionControl(f.options)(input,f.journal)).toBe('unknown');
    expect(execute.mock.calls.filter(row=>row[0]==='session.instructions.edit')).toHaveLength(1);
    expect(f.kernel.cancel).not.toHaveBeenCalled();
});

it('requires a durable cancellation receipt before accepting cancellation of unadmitted input',async()=>{
    const f=fixture();f.repository.readDocument.mockResolvedValue(undefined as never);
    f.options.repository.getManifest=vi.fn(async()=>({id:'original'}));
    const execute=vi.fn(async(command:string)=>command==='session.instructions.get'?{sessionId:'original',revision:0,items:[]}:{cancelledIds:[]});
    f.options.contexts.open.mockResolvedValue({commandBus:{execute},dispose:vi.fn()});
    const input={sessionId:'original',submissionId:'continuation',requestId:'cancel-empty',action:'cancel' as const};
    await expect(submissionControl(f.options)(input,f.journal)).rejects.toMatchObject({code:'SUBMISSION_CANCEL_UNCONFIRMED'});
    execute.mockImplementation(async(command:string)=>command==='session.instructions.get'?{sessionId:'original',revision:0,items:[]}:{cancelledIds:['continuation']});
    expect(await submissionControl(f.options)(input,f.journal)).toBe('cancelled');expect(f.kernel.cancel).not.toHaveBeenCalled();
});
