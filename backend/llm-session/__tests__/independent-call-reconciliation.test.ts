import {expect,it,vi} from 'vitest';
import type {TaskRecord} from '@nestos/durable-kernel';
import type {IndependentCallView} from '@nestos/llm-session/contracts';
import {reconcileIndependentCallExecution as reconcileWorkExecution} from '../src/session/independent-call-reconciliation';
function fixture(){
 const state={id:'owned-task',settled:false,blockedBy:'effect',control:{requested:'run'}} as IndependentCallView['executionState'];
 const record={id:'owned-task',sessionId:'original-session',effects:{original:{status:'indeterminate',attemptCount:2,error:{code:'EIO'},attempts:[{id:'original-attempt',finishedAt:Date.now()-60000,outcome:'indeterminate'}]}}} as unknown as TaskRecord;
 const kernel={task:vi.fn(async()=>record),resolveEffect:vi.fn(async()=>{})};return {state,record,kernel};
}
it('requests only reconciliation of the original identity and reuses its resolution identity',async()=>{
 const f=fixture();expect(await reconcileWorkExecution(f.kernel,'original-session',f.state)).toBe(true);
 expect(await reconcileWorkExecution(f.kernel,'original-session',f.state)).toBe(true);
 const first=f.kernel.resolveEffect.mock.calls[0];expect(first).toEqual(['original-session','owned-task',{requestId:expect.stringMatching(/^work-reconcile-/),effectId:'original',outcome:{type:'reconcile'}}]);
 expect(f.kernel.resolveEffect.mock.calls[1]).toEqual(first);
});
it.each(['EACCES','CONTEXT_NATIVE_EPOCH_CHANGED','JOURNAL_CONFLICT'])('does not auto-resolve authority or identity failure %s',async code=>{
 const f=fixture();f.record.effects.original.error!.code=code;
 expect(await reconcileWorkExecution(f.kernel,'original-session',f.state)).toBe(true);expect(f.kernel.resolveEffect).not.toHaveBeenCalled();
});
it('backs off transient observation failures and respects explicit pause',async()=>{
 const f=fixture();f.record.effects.original.attempts[0].finishedAt=Date.now();
 expect(await reconcileWorkExecution(f.kernel,'original-session',f.state)).toBe(true);expect(f.kernel.resolveEffect).not.toHaveBeenCalled();
 f.record.effects.original.attempts[0].finishedAt=Date.now()-60000;f.record.sessionPaused=true;
 expect(await reconcileWorkExecution(f.kernel,'original-session',f.state)).toBe(true);expect(f.kernel.resolveEffect).not.toHaveBeenCalled();
});
it('rejects a mismatched execution identity and leaves healthy execution unchanged',async()=>{
 const f=fixture();f.record.sessionId='another-session';
 await expect(reconcileWorkExecution(f.kernel,'original-session',f.state)).rejects.toMatchObject({code:'WORK_EXECUTION_SCOPE_MISMATCH'});
 expect(f.kernel.resolveEffect).not.toHaveBeenCalled();
 expect(await reconcileWorkExecution(f.kernel,'original-session',{...f.state!,settled:true})).toBe(false);
});
it('keeps an in-flight reconciliation visibly unsettled without requesting it again',async()=>{
 const f=fixture();f.record.effects.original.status='pending';f.record.effects.original.replayAuthorized=false;
 expect(await reconcileWorkExecution(f.kernel,'original-session',f.state)).toBe(true);expect(f.kernel.resolveEffect).not.toHaveBeenCalled();
});

it.each(['any','all'] as const)('reconciles an effect inside a compound %s wait',async blockedBy=>{
 const f=fixture();f.state!.blockedBy=blockedBy;
 expect(await reconcileWorkExecution(f.kernel,'original-session',f.state)).toBe(true);expect(f.kernel.resolveEffect).toHaveBeenCalledOnce();
});
