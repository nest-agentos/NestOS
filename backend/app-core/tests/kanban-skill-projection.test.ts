import {expect,it,vi} from 'vitest';
import {openDevelopmentChannel,projectWorkSkills,type DevelopmentWorkspaceRecord} from '../src/presets/kanban-development';
import type {NativeWorkInput} from '../src/presets/kanban-native-workspace';
import {kanbanWorkSkillProvider} from '@nestos/kanban-development';
import {readFile} from 'node:fs/promises';
import {load} from 'js-yaml';

const contribution={moduleId:'example',moduleVersion:'1',serverId:'server',uri:'skill://example/SKILL.md',stages:['task'],permission:'read'};
const context={decision:{snapshot:{externalRefs:[{system:'nestos-decision-module',id:'example',revision:'1'}]}}};
const input={dispatch:{id:'attempt'}} as NativeWorkInput;

it('projects the frozen decision only with an explicit host authorization',async()=>{
 const options={skillContributions:[contribution],skillPermissions:vi.fn(async()=>['read'])};
 expect(await projectWorkSkills(options,input,'project',context,'project')).toEqual([{moduleId:'example',moduleVersion:'1',serverId:'server',uri:'skill://example/SKILL.md'}]);
 expect(await projectWorkSkills({...options,skillPermissions:async()=>[]},input,'project',context,'project')).toEqual([]);
 expect(await projectWorkSkills(options,input,'project',{},'project')).toEqual([]);
 expect(await projectWorkSkills({skillContributions:[contribution]},input,'project',context)).toEqual([]);
});

it('projects the actual software module files only with a frozen module and grant',async()=>{
 const source={projectId:'project',revision:3,mountId:'root',serverId:'cells_session',operationId:'attempt',workspacePath:'worktrees/task',
  readBytes:vi.fn(async(path:string)=>new Uint8Array(await readFile(new URL('../../../'+path.slice('worktrees/task/'.length),import.meta.url)))),parseYaml:load};
 const selected={decision:{snapshot:{externalRefs:[{system:'nestos-decision-module',id:'software-development',revision:'1'}]}}};
 const options={skillProviders:[kanbanWorkSkillProvider],skillPermissions:async()=>['kanban-work:read']};
 expect(await projectWorkSkills({...options,skillPermissions:async()=>[]},input,'project',selected,'project',source)).toEqual([]);
 expect(source.readBytes).not.toHaveBeenCalled();
 const [projected]=await projectWorkSkills(options,input,'project',selected,'project',source);
 expect(projected.source).toEqual({projectId:'project',revision:3,mountId:'root'});
 expect(projected.resources).toHaveLength(3);
 expect(Array.isArray(projected.resources)&&projected.resources.every(resource=>resource.path.startsWith('worktrees/task/backend/kanban-development/skills/'))).toBe(true);
 expect(source.readBytes).toHaveBeenCalledTimes(3);
});

it('passes the retained projection with the immutable scope, keeping the task and identity',async()=>{
 const remote={sessionChannel:vi.fn(async()=>undefined)};
 const skillProjection=await projectWorkSkills({skillContributions:[contribution],skillPermissions:async()=>['read']},input,'project',context,'project');
 const record={projectId:'project',directory:'/workspace/task',channelId:'attempt',repositories:[],availableRepositories:[],skillProjection,policy:{commit:'changes',prompts:{files:[]}}} as unknown as DevelopmentWorkspaceRecord;
 const identity={runId:'run',itemId:'task',attemptId:'attempt'},task={title:'task'};
 await openDevelopmentChannel(remote,'attempt',record,identity,task,undefined,true);
 expect(remote.sessionChannel).toHaveBeenCalledWith('project','open',expect.objectContaining({scopeId:'attempt',snapshot:expect.objectContaining({identity,task,skillProjection})}));
 await openDevelopmentChannel(remote,'attempt',record,identity,task);
 expect(remote.sessionChannel.mock.calls[1][2].snapshot).not.toHaveProperty('skillProjection');
});

it('freezes the host source and metadata only for the selected project',async()=>{
 const bound={...contribution,source:{projectId:'project',revision:3,mountId:'root'},frontmatter:{name:'example',description:'Example',metadata:{owner:'team'}},
  resources:[{uri:contribution.uri,digest:'sha256:'+'a'.repeat(64),size:9,path:'skills/example/SKILL.md'}]};
 const options={skillContributions:[bound],skillPermissions:async()=>['read']};
 const [projection]=await projectWorkSkills(options,input,'project',context,'project');
 expect(await projectWorkSkills(options,input,'local-project',context,'project')).toHaveLength(1);
 bound.frontmatter.metadata.owner='changed';bound.resources[0].path='other';
 expect(projection.source).toEqual({projectId:'project',revision:3,mountId:'root'});
 expect(projection.frontmatter).toEqual({name:'example',description:'Example',metadata:{owner:'team'}});
 expect(Array.isArray(projection.resources)&&projection.resources[0].path).toBe('skills/example/SKILL.md');
 expect(await projectWorkSkills(options,input,'other',context,'other')).toEqual([]);
 expect(await projectWorkSkills({...options,skillPermissions:async()=>[]},input,'project',context,'project')).toEqual([]);
 await expect(projectWorkSkills(options,input,'project',context)).rejects.toMatchObject({code:'MCP_SKILL_PROJECT_BINDING_REQUIRED'});
});

it('builds a provider only after its module, stage and permission are authorized',async()=>{
 const source={projectId:'project',revision:3,mountId:'root',serverId:'server',operationId:'attempt',workspacePath:'worktrees/task',readBytes:vi.fn(),parseYaml:vi.fn()};
 const bound={...contribution,source:{projectId:'project',revision:3,mountId:'root'},frontmatter:{name:'example',description:'Example'},
  resources:[{uri:contribution.uri,digest:'sha256:'+'a'.repeat(64),size:9,path:'worktrees/task/SKILL.md'}]};
 const build=vi.fn(async()=>bound);
 const provider={moduleId:'example',moduleVersion:'1',stages:['task'],permission:'read',build};
 const options={skillProviders:[provider],skillPermissions:async()=>['read']};
 expect(await projectWorkSkills(options,input,'project',{},'project',source)).toEqual([]);
 expect(await projectWorkSkills({...options,skillPermissions:async()=>[]},input,'project',context,'project',source)).toEqual([]);
 expect(build).not.toHaveBeenCalled();
 expect(await projectWorkSkills(options,input,'project',context,'project',source)).toHaveLength(1);
 expect(build).toHaveBeenCalledOnce();
 build.mockResolvedValueOnce({...bound,source:{...bound.source,projectId:'other'}});
 await expect(projectWorkSkills(options,input,'project',context,'project',source)).rejects.toMatchObject({code:'MCP_SKILL_PROVIDER_BINDING_MISMATCH'});
 build.mockResolvedValueOnce({...bound,resources:[{...bound.resources[0],path:'outside/SKILL.md'}]});
 await expect(projectWorkSkills(options,input,'project',context,'project',source)).rejects.toMatchObject({code:'MCP_SKILL_PROVIDER_BINDING_MISMATCH'});
 const dynamic={...bound,resources:'dynamic' as const,dynamicPath:'worktrees/task/generated.md'};
 const dynamicOptions={...options,skillProviders:[{...provider,build:async()=>dynamic}]};
 await expect(projectWorkSkills(dynamicOptions,input,'project',context,'project',source))
   .resolves.toMatchObject([{resources:'dynamic',dynamicPath:dynamic.dynamicPath}]);
 dynamic.dynamicPath='worktrees/task/../outside.md';
 await expect(projectWorkSkills(dynamicOptions,input,'project',context,'project',source)).rejects.toThrow('SKILL_SOURCE_INVALID');
});
