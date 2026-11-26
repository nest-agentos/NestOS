import {expect,it,vi} from 'vitest';
import {sessionChannelSkillSource} from '../src/projects/session-channel-skills';
import {SkillDeviceDriver} from '@nestos/kernel-adapters';
import {sha256HexSync} from '@nestos/common';

vi.mock('../src/projects/harness-context-catalog',()=>({readContextCatalog:async()=>({value:{bindings:{one:{branchId:'main',validity:'valid',nativeRef:{nodeConnectionId:'connection',workspaceId:'cell-project',profileId:'profile',sessionId:'native'}}}}})}));

it('discovers only from the bound native session and retains the local source',async()=>{
 const close=vi.fn(),inspect=vi.fn(async()=>({session:{id:'native',cwd:'/projects/cell-project/work'}}));
 let serverId='node-one',channelScope='scope',projectRevision=1,hold:(()=>Promise<unknown>)|undefined;
 const text='---\nname: example\ndescription: Example\n---\nBody\n',uri='skill://example/SKILL.md';
 const grant={uri,frontmatter:{name:'example',description:'Example'},resources:[{uri,digest:'sha256:'+sha256HexSync(text),size:new TextEncoder().encode(text).length}]};
 const sessionChannel=vi.fn(async(_project:string,operation:string,input:Record<string,unknown>)=>operation==='current'
  ?{scopeId:channelScope,execution:{sessionId:'native'}}:input.skillResourceUri?(hold?hold():{contents:[{uri,text}]}):input.nativeSessionId==='native'?{skills:[grant]}:{skills:[]});
 const deps={kernel:()=>({}),manifest:async()=>({folder:'folder',currentBranch:'main'}),project:async()=>({project:{id:'project'}}),
  remote:{list:()=>[{at:'/',connectionId:'connection',serverId,serverProjectId:'cell-project',serverProjectRevision:projectRevision,mountId:'mount',alias:'root',authorization:{principalId:'alice',revision:'1'}}],projectHarness:async()=>({inspect,close}),sessionChannel}} as never;
 const local={loadScope:async(cwd:string)=>({cwd,skills:[],agentInstructions:'local'})};
 const result=await sessionChannelSkillSource({sessionId:'session',cwd:'/workspace',scopeId:'scope'},local,deps).loadScope('/workspace');
 expect(result.agentInstructions).toBe('local');expect(result.skills).toHaveLength(1);
 expect(result.skills[0].metadata?.mcpOrigin).toMatchObject({serverId:'node-one',uri:grant.uri,scopeId:'scope',projectId:'cell-project',projectRevision:1,mountId:'root'});
 expect(sessionChannel).toHaveBeenLastCalledWith('project','messages',expect.objectContaining({scopeId:'scope',nativeSessionId:'native',skillsMetadata:true}));
 expect(close).toHaveBeenCalledOnce();
 const other=await sessionChannelSkillSource({sessionId:'session',cwd:'/workspace',scopeId:'other'},local,deps).loadScope('/workspace');
 expect(other.skills).toEqual([]);expect(sessionChannel).toHaveBeenCalledTimes(3);
 inspect.mockResolvedValueOnce({session:{id:'different',cwd:'/projects/cell-project/work'}});
 const wrongNative=await sessionChannelSkillSource({sessionId:'session',cwd:'/workspace'},local,deps).loadScope('/workspace');
 expect(wrongNative.skills).toEqual([]);expect(sessionChannel).toHaveBeenCalledTimes(3);
 sessionChannel.mockRejectedValueOnce(Object.assign(new Error('closed'),{remoteCode:'CHANNEL_SCOPE_UNKNOWN'}));
 const detached=await sessionChannelSkillSource({sessionId:'session',cwd:'/workspace'},local,deps).loadScope('/workspace');
 expect(detached.skills).toEqual([]);
 serverId='node-two';
 const second=await sessionChannelSkillSource({sessionId:'session',cwd:'/workspace',scopeId:'scope'},local,deps).loadScope('/workspace');
 expect(second.skills[0].metadata?.mcpOrigin).toMatchObject({serverId:'node-two',uri:grant.uri,scopeId:'scope'});
 expect(second.skills[0].id).not.toBe(result.skills[0].id);
 channelScope='next-scope';
 const next=await sessionChannelSkillSource({sessionId:'session',cwd:'/workspace',scopeId:'next-scope'},local,deps).loadScope('/workspace');
 expect(next.skills[0].id).not.toBe(second.skills[0].id);
 projectRevision=2;
 const revised=await sessionChannelSkillSource({sessionId:'session',cwd:'/workspace',scopeId:'next-scope'},local,deps).loadScope('/workspace');
 expect(revised.skills[0].id).not.toBe(next.skills[0].id);projectRevision=1;
 const source=sessionChannelSkillSource({sessionId:'session',cwd:'/workspace',scopeId:'next-scope'},local,deps);
 const approved=(await source.loadScope('/workspace')).skills[0];
 const readCount=()=>sessionChannel.mock.calls.filter(call=>call[2].skillResourceUri).length;
 await expect(source.readApproved!('session',approved.id,'task','window',{verifyMcpApproval:async()=>false})).rejects.toThrow('MCP_SKILL_APPROVAL_DENIED');
 expect(readCount()).toBe(0);
 expect(await source.readApproved!('session',approved.id,'task','window',{verifyMcpApproval:async()=>true})).toBe(text);
 expect(readCount()).toBe(1);
 let release!:(value:unknown)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 hold=()=>{entered();return new Promise(resolve=>{release=resolve;});};
 const pending=source.readApproved!('session',approved.id,'task','window',{verifyMcpApproval:async()=>true});
 await started;await source.dispose!();release({contents:[{uri,text}]});
 await expect(pending).rejects.toThrow('MCP_SKILL_SCOPE_CHANGED');hold=undefined;
 const driver=new SkillDeviceDriver({source:sessionChannelSkillSource({sessionId:'session',cwd:'/workspace'},local,deps)});
 try {await driver.setCwd('/workspace');const [skill]=driver.getScopedSkills();
  expect(await driver.loadSkill(skill.id)).toMatchObject({success:false,error:'MCP_SKILL_ACTIVATION_GATE_REQUIRED'});
  serverId='node-one';await driver.refreshScopedSkills();expect(driver.getSkill(skill.id)).toBeUndefined();
  expect(driver.getScopedSkills()[0].id).not.toBe(skill.id);
 } finally {await driver.dispose();}
});
