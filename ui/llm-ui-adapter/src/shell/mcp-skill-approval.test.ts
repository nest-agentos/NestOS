import {expect,it,vi} from 'vitest';
import {McpSkillApprovalAction} from './mcp-skill-approval';
import {rememberTaskAttachment} from './task-attachment-lifecycle';

it('retains the same request identity across an uncertain submission and retry',async()=>{
 const request=vi.fn().mockRejectedValueOnce(new Error('unconfirmed')).mockResolvedValueOnce('task');
 const attach=vi.fn(async()=>{}),controls={mcpApprovalWindow:async()=> 'window',requestMcpApproval:request};
 const action=new McpSkillApprovalAction(controls as never,'session',()=>({current:async()=>undefined}) as never,attach,()=>{});
 await expect(action.request('skill')).rejects.toThrow('unconfirmed');await action.request('skill');
 expect(request).toHaveBeenCalledTimes(2);expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);expect(attach).toHaveBeenCalledWith('task');
});
it('does not replace an active task or submit another request',async()=>{
 const request=vi.fn(),controls={mcpApprovalWindow:async()=> 'window',requestMcpApproval:request};
 const action=new McpSkillApprovalAction(controls as never,'session',()=>({current:async()=>({id:'other',status:'waiting'})}) as never,async()=>{},()=>{});
 await expect(action.request('skill')).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
it('preserves the task receipt but does not attach it to a replaced view',async()=>{
 let current=true;const attach=vi.fn(),setShared=vi.fn(async()=>{current=false;});
 const control={openSession:async()=>({setShared})};
 await expect(rememberTaskAttachment(control as never,'session',{attach} as never,'task',()=>{if(!current)throw new Error('stale');})).rejects.toThrow('stale');
 expect(setShared).toHaveBeenCalledWith('ui.privileged.active-task',{taskId:'task'});expect(attach).not.toHaveBeenCalled();
});
it('activates only the approved task in its original session and window',async()=>{
 const activate=vi.fn(async()=>[]),controls={mcpApprovalWindow:async()=> 'window',requestMcpApproval:async()=> 'task',activateMcpApproved:activate};
 const action=new McpSkillApprovalAction(controls as never,'session',()=>({current:async()=>undefined}) as never,async()=>{},()=>{});
 await action.request('skill');await action.observe({type:'task.succeeded',taskId:'other'} as never);expect(activate).not.toHaveBeenCalled();
 await Promise.all([action.observe({type:'task.succeeded',taskId:'task'} as never),action.observe({type:'task.succeeded',taskId:'task'} as never)]);
 expect(activate).toHaveBeenCalledOnce();expect(activate).toHaveBeenCalledWith('session','skill','task','window');
});
it('does not activate a denied task',async()=>{
 const activate=vi.fn(),controls={mcpApprovalWindow:async()=> 'window',requestMcpApproval:async()=> 'task',activateMcpApproved:activate};
 const action=new McpSkillApprovalAction(controls as never,'session',()=>({current:async()=>undefined}) as never,async()=>{},()=>{});
 await action.request('skill');await action.observe({type:'task.failed',taskId:'task'} as never);expect(activate).not.toHaveBeenCalled();
});
it('starts a new approval after activation fails',async()=>{
 const submit=vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
 const controls={mcpApprovalWindow:async()=> 'window',requestMcpApproval:submit,
  activateMcpApproved:vi.fn().mockRejectedValueOnce(new Error('MCP_SKILL_FRONTMATTER_MISMATCH'))};
 const action=new McpSkillApprovalAction(controls as never,'session',()=>({current:async()=>undefined}) as never,async()=>{},()=>{});
 await action.request('skill');
 await expect(action.observe({type:'task.succeeded',taskId:'first'} as never)).rejects.toThrow('MCP_SKILL_FRONTMATTER_MISMATCH');
 await action.request('skill');
 expect(submit.mock.calls).toHaveLength(2);
 expect(submit.mock.calls[1][2]).not.toBe(submit.mock.calls[0][2]);
});
