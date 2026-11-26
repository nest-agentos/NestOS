// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {Kernel} from '@nestos/durable-kernel';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {sha256HexSync} from '@nestos/llm-context';
import {McpSkillApprovalProgram} from '../../../backend/kernel-adapters/src/programs/approved-effect-program';
import {McpSkillSource} from '../../../backend/kernel-adapters/src/skill/mcp-skill-source';
import {SkillDeviceDriver} from '../../../backend/kernel-adapters/src/skill/skill-device-driver';
import {createSessionSkillControls} from '../../../backend/kernel-adapters/src/skill/session-skill-controls';
import {SharedChatCommands} from '../../llm-ui-adapter/src/shell/SharedChatCommands';
import {createOperationLedger} from '@nestos/llm-ui';
import {RunAttachmentController} from '../../llm-ui-adapter/src/shell/RunAttachmentController';

it.each([true,false])('requests a durable approval through the Skill button (approved: %s)',async approved=>{
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{fn(0);return 0;});
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/approval');
 const kernel=new Kernel({catalog:{fs},pollMs:0});kernel.registerStorageResolver({kind:'test',async resolve(){return {fs,rootPath:'/session'};}});
 kernel.registerProgram(new McpSkillApprovalProgram());await kernel.initialize();
 const session=await kernel.createSession({id:'session',storage:{kind:'test',locator:null}});
 const uri='skill://example/SKILL.md',body='---\nname: example\ndescription: Example\n---\nBody\n';
 const entry={uri,frontmatter:{name:'example',description:'Example'},resources:[{uri,digest:'sha256:'+sha256HexSync(body),size:new TextEncoder().encode(body).length}]};
 const source=new McpSkillSource('origin',{listMcpSkills:async()=>[entry],getMcpSkill:async()=>entry,readMcpSkillBytes:async()=>new TextEncoder().encode(body)}),service=new SkillDeviceDriver({source});await service.setCwd('/workspace');
 const scope={skillService:service,readMcpSkillApproved:source.readApproved.bind(source),stageMcpSkill:service.stageMcpSkill.bind(service),commitMcpSkill:service.commitMcpSkill.bind(service)},controls=createSessionSkillControls(kernel,{get:async()=>scope} as never);
 let attachment!:RunAttachmentController;const signal=new AbortController(),root=document.createElement('div');
 const commands=new SharedChatCommands({config:{sessionId:'session',kernel,sessionSkills:controls,agentService:{}},signal:signal.signal,
  operations:createOperationLedger(),current:()=>true,view:()=>undefined,taskCallbacks:{onEvent:()=>{},onWaiting:()=>{}},
  attach:(value:RunAttachmentController)=>{attachment=value;},report:vi.fn()} as never);
 try {
  commands.mountSkills(root);const skill=service.getScopedSkills()[0];
  await vi.waitFor(()=>expect(root.querySelector('[data-skill-approval]')).not.toBeNull());
  const button=root.querySelector<HTMLButtonElement>('[data-skill-approval]');
  button!.click();await vi.waitFor(()=>expect(attachment.activeTaskId).toBeTruthy());
  const id=attachment.activeTaskId!,task=await session.attachTask(id);
  expect((await session.getShared('ui.privileged.active-task'))?.value).toEqual({taskId:id});
  await vi.waitFor(async()=>expect((await task.status()).task.interactions['approve:mcp-skill']?.status).toBe('pending'));
  const record=(await task.status()).task,window=record.input as {windowId:string};
  expect(record.interactions['approve:mcp-skill'].payload).toMatchObject({sessionId:'session',serverId:'origin',uri,windowId:window.windowId,manifestDigest:expect.stringMatching(/^sha256:[a-f0-9]{64}$/)});
  await attachment.respondApproval('approve:mcp-skill',approved,'',attachment.revision);await task.wait({timeoutMs:5000});
  expect(await controls.verifyMcpApproval!('session',id,skill.id,window.windowId)).toBe(approved);
  if(approved)await vi.waitFor(()=>expect(service.getLoadedSkills()).toHaveLength(1));
  else expect(service.getLoadedSkills()).toEqual([]);
 } finally {signal.abort();await commands.destroy();await service.dispose();await kernel.dispose();await manager.dispose();vi.unstubAllGlobals();}
},20_000);
