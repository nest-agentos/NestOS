import {expect,it,vi} from 'vitest';
import {unavailableDecisionReference} from '../src/kanban/decision-conversation-availability';
import {decisionConversationViews} from '../src/kanban/decision-conversation-views';
function fixture(){
 const inspect=vi.fn(async()=>({session:{id:'native'}})),close=vi.fn(async()=>{});
 const projects={get:vi.fn(async()=>({path:'/folder:project',project:{id:'project'}}))};
 const remote={list:()=>[{at:'/',serverProjectId:'workspace'}],projectHarness:vi.fn(async()=>({inspect,close}))};
 const value={id:'discussion',boardId:'board',state:'error',createdAt:1,sessionId:'native',resourceId:'/folder:old/@harness/codex/native',binding:{projectId:'project',workspaceId:'workspace',profileId:'codex'}};
 return {inspect,close,projects,remote,value};
}
it('accepts authoritative missing-project evidence but preserves transient and permission failures',async()=>{
 const f=fixture();f.projects.get.mockRejectedValueOnce(Object.assign(Error('Missing'),{code:'ENOENT'}));
 expect(await unavailableDecisionReference(f as never,f.value as never)).toBe(true);expect(f.remote.projectHarness).not.toHaveBeenCalled();
 f.projects.get.mockRejectedValueOnce(Object.assign(Error('Denied'),{code:'EACCES'}));
 await expect(unavailableDecisionReference(f as never,f.value as never)).rejects.toMatchObject({code:'EACCES'});
});
it('inspects only the original workspace and never treats transport failures as a deleted session',async()=>{
 const f=fixture();expect(await unavailableDecisionReference(f as never,f.value as never)).toBe(false);
 f.inspect.mockRejectedValueOnce(Object.assign(Error('Missing'),{code:'ENOENT'}));
 expect(await unavailableDecisionReference(f as never,f.value as never)).toBe(true);
 f.inspect.mockRejectedValueOnce(Object.assign(Error('Offline'),{code:'EIO'}));
 await expect(unavailableDecisionReference(f as never,f.value as never)).rejects.toMatchObject({code:'EIO'});
 expect(f.close).toHaveBeenCalledTimes(3);
});
it('validates persisted discussion links even when an old resource URL already exists',async()=>{
 const f=fixture(),log=vi.fn();f.projects.get.mockRejectedValueOnce(Object.assign(Error('PRIVATE_BODY'),{code:'ENOENT'}));
 const options={...f,log,journal:{getMany:async()=>[undefined,undefined,{binding:f.value.binding},undefined,undefined]}};
 const [view]=await decisionConversationViews(options as never,[f.value] as never);
 expect(view.unavailable).toEqual({kind:'project',code:'DECISION_CONVERSATION_PROJECT_MISSING',cleanupAllowed:true});
 expect(view.resourceId).toBe(f.value.resourceId);expect(view.resources).toEqual([{system:'nestos-remote-project',id:'project'}]);
 expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_BODY');
});
