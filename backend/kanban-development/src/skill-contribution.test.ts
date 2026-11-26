import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect,it,vi} from 'vitest';
import {sha256HexSync} from '@nestos/common';
import {projectKanbanSkills} from '@nestos/kanban/contracts';
import {kanbanWorkSkillContribution} from './skill-contribution';

it('packages the real external Skill bytes and requires selected module and permission',async()=>{
 const readBytes=vi.fn(async(path:string)=>new Uint8Array(await readFile(resolve('../..',path))));
 const contribution=await kanbanWorkSkillContribution({projectId:'project',revision:2,mountId:'root',serverId:'cells',operationId:'op',workspacePath:'',readBytes,
  parseYaml:text=>Object.fromEntries(text.split('\n').map(line=>{const index=line.indexOf(':');return [line.slice(0,index),line.slice(index+1).trim()];}))});
 expect(contribution.resources).toHaveLength(3);expect(contribution.frontmatter?.name).toBe('kanban-work');
 if(!Array.isArray(contribution.resources))throw new Error('Expected static resources');
 const first=await readBytes(contribution.resources[0].path);expect(contribution.resources[0]).toMatchObject({size:first.byteLength,digest:'sha256:'+sha256HexSync(first)});
 const scope={projectId:'project',stage:'task',permissions:['kanban-work:read'],modules:[{system:'nestos-decision-module',id:'software-development',revision:'1'}]};
 expect(projectKanbanSkills([contribution],scope)).toHaveLength(1);
 expect(projectKanbanSkills([contribution],{...scope,permissions:[]})).toEqual([]);
 expect(projectKanbanSkills([contribution],{...scope,modules:[]})).toEqual([]);
});
it('reports read failures without exposing file content or raw errors',async()=>{
 const log=vi.fn();
 await expect(kanbanWorkSkillContribution({projectId:'project',revision:1,mountId:'root',serverId:'cells',operationId:'op',workspacePath:'',
  readBytes:async()=>{throw new Error('SECRET_CONTENT');},parseYaml:()=>({}),log})).rejects.toThrow('SECRET_CONTENT');
 expect(log).toHaveBeenCalledWith(expect.objectContaining({operation:'kanban.skill.contribution',stage:'read',result:'failure',code:'KANBAN_SKILL_READ_FAILED'}));
 expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_CONTENT');
});
it('binds explicit worktree paths and refuses traversal before reading',async()=>{
 const readBytes=vi.fn(async(path:string)=>new Uint8Array(await readFile(resolve('../..',path.replace(/^_nestos\/worktrees\/attempt\//,'')))));
 const source={projectId:'project',revision:1,mountId:'root',serverId:'cells',operationId:'op',workspacePath:'_nestos/worktrees/attempt',readBytes,
  parseYaml:()=>({name:'kanban-work',description:'Kanban work'})};
 const contribution=await kanbanWorkSkillContribution(source);
 expect(Array.isArray(contribution.resources)&&contribution.resources.every(file=>file.path.startsWith('_nestos/worktrees/attempt/'))).toBe(true);
 readBytes.mockClear();await expect(kanbanWorkSkillContribution({...source,workspacePath:'../outside'})).rejects.toThrow('KANBAN_SKILL_WORKSPACE_INVALID');
 expect(readBytes).not.toHaveBeenCalled();
});
