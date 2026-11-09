import {expect,it} from 'vitest';
import {decisionProjectScope,requireDecisionProjectContext} from '../src/kanban/decision-project-scope';
const roots:Record<string,any>={
 one:{at:'/',serverId:'cell-one',serverProjectId:'p-one',serverProjectRevision:1,authorization:{principalId:'owner',revision:'auth'}},
 two:{at:'/',serverId:'cell-one',serverProjectId:'p-two',serverProjectRevision:2,authorization:{principalId:'owner',revision:'auth'}},
 other:{at:'/',serverId:'cell-two',serverProjectId:'p-other',serverProjectRevision:1,authorization:{principalId:'owner',revision:'auth'}},
};
const remote={list:(id:string)=>roots[id]?[roots[id]]:[]} as any;
it('requires an explicit primary and restricts secondary projects to the same Cell and authorization',()=>{
 expect(decisionProjectScope(remote,'two',['one','two'])).toEqual([{projectId:'p-one',revision:1},{projectId:'p-two',revision:2}]);
 expect(()=>decisionProjectScope(remote,'one',['one','other'])).toThrowError(expect.objectContaining({code:'DECISION_PROJECT_CELL_MISMATCH'}));
 expect(()=>decisionProjectScope(remote,'one',['two'])).toThrowError(expect.objectContaining({code:'DECISION_PROJECTS_REQUIRED'}));
 expect(()=>decisionProjectScope(remote,'one',['one','one'])).toThrowError(expect.objectContaining({code:'DECISION_PROJECTS_REQUIRED'}));
 const changed={list:(id:string)=>[{...roots[id],authorization:{principalId:id,revision:'auth'}}]} as any;
 expect(()=>decisionProjectScope(changed,'one',['one','two'])).toThrowError(expect.objectContaining({code:'DECISION_PROJECT_AUTHORIZATION_MISMATCH'}));
});
it('requires authoritative Cell directory mappings instead of accepting a legacy channel receipt',()=>{
 const projects=decisionProjectScope(remote,'one',['one','two']);
 expect(()=>requireDecisionProjectContext({accepted:true},projects)).toThrowError(expect.objectContaining({code:'CELL_PROJECT_CONTEXT_REQUIRED'}));
 expect(()=>requireDecisionProjectContext({projectContext:{projects:projects.map(row=>({...row,directory:'/projects/'+row.projectId}))}},projects)).not.toThrow();
});

it('creates the discussion channel on the explicit primary with only its selected Cell projects',async()=>{
 const {createVFS,MemoryBackend}=await import('@nestos/vfs-core');
 const {decisionConversationTransport}=await import('../src/kanban/decision-conversation-transport');
 const {vi}=await import('vitest');
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});
 try {
  const fs=await manager.openFileSystem('/'),close=vi.fn(async()=>{}),dispose=vi.fn(async()=>{});
  const projectHarness=vi.fn(async()=>({profiles:async()=>({epoch:'epoch',profiles:[{id:'codex',projectRuntime:true,capabilities:{create:true,sessionChannels:true,workingDirectory:true},workspaces:[{id:'unrelated'},{id:'p-two'}]}]}),close}));
  const sessionChannel=vi.fn(async(_project:string,_method:string,input:any)=>({projectContext:{projects:input.contextProjects.map((row:any)=>({...row,directory:'/projects/'+row.projectId}))}}));
  const options={fs,journal:{get:async()=>undefined},projects:{get:async(id:string)=>({path:'/'+id,name:id,project:{id,source:{kind:'remote'}}}),openWorkspace:async()=>({fs,dispose})},remote:{...remote,projectHarness,sessionChannel},log:vi.fn()} as any;
  const port=decisionConversationTransport(options,async()=>({})),resources=['one','two'].map(id=>({system:'nestos-remote-project',id}));
  expect(await port.prepare('conversation','board',resources,resources[1])).toMatchObject({projectId:'two',projectIds:['one','two'],workspaceId:'p-two'});
  expect(projectHarness).toHaveBeenCalledWith('two',{requireRegistered:true});
  expect(sessionChannel).toHaveBeenCalledWith('two','open',expect.objectContaining({cwd:'_nestos/kanban/conversations/conversation',contextProjects:[{projectId:'p-one',revision:1},{projectId:'p-two',revision:2}],snapshot:expect.objectContaining({context:expect.objectContaining({primaryProjectId:'two',secondaryProjectIds:['one']})})}));
  expect(close).toHaveBeenCalledOnce();expect(dispose).toHaveBeenCalledOnce();
  projectHarness.mockRejectedValueOnce(Object.assign(Error('Authorization changed'),{code:'ECONFLICT'}));
  await expect(port.prepare('conflict','board',resources,resources[1])).rejects.toMatchObject({code:'DECISION_AUTHORIZATION_CHANGED'});
  expect(options.log).toHaveBeenCalledWith(expect.objectContaining({stage:'decision.harness.open',code:'DECISION_AUTHORIZATION_CHANGED'}));
 }finally{await manager.dispose();}
});
