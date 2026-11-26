import {expect,it,vi} from 'vitest';
import {McpSkillSource} from './mcp-skill-source';
import {SkillDeviceDriver} from './skill-device-driver';
import type {McpSkillEntry} from './mcp-skill-verification';

const entry:McpSkillEntry={uri:'skill://example/SKILL.md',frontmatter:{name:'example',description:'Example'},resources:'dynamic'};
it('discovers source-qualified metadata without reading or activating remote content',async()=>{
 const listMcpSkills=vi.fn(async()=>[entry]);const source=new McpSkillSource('server-a',{listMcpSkills});
 const service=new SkillDeviceDriver({source});await service.setCwd('/workspace');
 const [skill]=service.getScopedSkills();expect(skill.metadata?.mcpOrigin).toEqual({serverId:'server-a',uri:entry.uri});
 expect(skill.autoLoad).toBe(false);expect(skill.disableModelInvocation).toBe(true);
 expect(await service.loadSkill(skill.id)).toMatchObject({success:false,error:'MCP_SKILL_ACTIVATION_GATE_REQUIRED'});
 expect(service.getLoadedSkills()).toEqual([]);
 const other=await new McpSkillSource('server-b',{listMcpSkills}).loadScope('/workspace');expect(other.skills[0].id).not.toBe(skill.id);
});
it('keeps legacy servers without the extension empty',async()=>{
 const source=new McpSkillSource('legacy',{listMcpSkills:async()=>[]});
 expect((await source.loadScope('/workspace')).skills).toEqual([]);
});
it('does not shadow a local skill with the same identity',async()=>{
 const source=new McpSkillSource('server',{listMcpSkills:async()=>[entry]});
 const [remote]=(await source.loadScope('/workspace')).skills;
 const local={...remote,metadata:undefined,instructions:'local'};
 const service=new SkillDeviceDriver({source,registry:new Map([[local.id,local]])});
 await expect(service.setCwd('/workspace')).rejects.toThrow('MCP_SKILL_IDENTITY_CONFLICT');
 expect(service.getSkill(local.id)?.instructions).toBe('local');
});
