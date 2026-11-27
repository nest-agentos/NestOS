import {expect,it} from 'vitest';
import {kanbanSkillPermissions} from '../src/runtime/kanban-module-permissions';

it('grants Skills only for the configured Cells node and project',async()=>{
    const authorize=kanbanSkillPermissions('{"cells-east":{"project-a":["read","read"]}}')!;
    await expect(authorize({},'renamed',{serverId:'cells-east',projectId:'project-a'})).resolves.toEqual(['read']);
    await expect(authorize({},'project-a',{serverId:'cells-west',projectId:'project-a'})).resolves.toEqual([]);
    await expect(authorize({},'project-a',{serverId:'cells-east',projectId:'project-b'})).resolves.toEqual([]);
    await expect(authorize({},'project-a')).resolves.toEqual([]);
    expect(kanbanSkillPermissions(undefined)).toBeUndefined();
    expect(()=>kanbanSkillPermissions('{"cells-east":{"project-a":[42]}}')).toThrow('Invalid Kanban Skill permissions');
});
