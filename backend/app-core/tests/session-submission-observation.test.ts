import{expect,it,vi}from'vitest';
import{sessionSubmission}from'../src/run/session-submission';
function fixture(){
 const submission={id:'request',source:{kind:'conversation',ownerId:'session',id:'request'}},round={id:'request',sessionId:'session',submission,status:'running',executions:[{role:'primary',taskId:'task'}]};
 const task={id:'task',sessionId:'session',rootTaskId:'task',labels:{roundId:'request'},program:{kind:'agent'},effects:{},exit:{status:'succeeded'}};
 const submit=vi.fn(),options={repository:{readDocument:vi.fn(async()=>JSON.stringify(round))},kernel:{task:async()=>task,inspectSession:async()=>({snapshot:async()=>({tasks:[task]})})},contexts:{open:async()=>({dispose:async()=>{},commandBus:{execute:submit}})}};
 return{api:sessionSubmission(options as never),request:{expectedSessionId:'session',expectedBranch:'main',submission} as any,round,task,submit};
}
it('keeps a proven settled execution running while its round acknowledgement catches up, without resubmission',async()=>{
 const f=fixture();expect(await f.api.inspect(f.request)).toMatchObject({outcome:'running',code:'SUBMISSION_SETTLEMENT_PENDING'});
 f.round.status='completed';expect(await f.api.inspect(f.request)).toMatchObject({outcome:'succeeded'});expect(f.submit).not.toHaveBeenCalled();
});
it('retains a real failed execution after settlement instead of treating it as user cancellation',async()=>{
 const f=fixture();Object.assign(f.task.exit,{status:'failed',error:{code:'CELLS_UNAVAILABLE'}});
 expect(await f.api.inspect(f.request)).toMatchObject({outcome:'running'});f.round.status='failed';
 expect(await f.api.inspect(f.request)).toMatchObject({outcome:'failed',code:'CELLS_UNAVAILABLE'});expect(f.submit).not.toHaveBeenCalled();
});

it.each(['CELLS_UNAVAILABLE','unsafe message with token'])('keeps an indeterminate harness effect unknown without resubmitting (%s)',async code=>{
 const f=fixture();delete (f.task as any).exit;
 Object.assign(f.task.effects,{harness:{status:'indeterminate',error:{code}}});
 expect(await f.api.inspect(f.request)).toMatchObject({outcome:'unknown',code:code==='CELLS_UNAVAILABLE'?code:'SUBMISSION_EFFECT_INDETERMINATE'});
 expect(f.submit).not.toHaveBeenCalled();
});
