import {expect,it,vi} from 'vitest';
import type {KanbanBoard,KanbanCommand} from '@nestos/kanban/contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {validateWorkProjects,workProjectId} from '../src/kanban/task-projects';
const reference=(id:string)=>({system:'nestos-remote-project',id});
const projects={get:vi.fn(async(id:string)=>({project:{id,source:{kind:id==='local'?'local':'remote'}}}))} as unknown as Pick<ProjectService,'get'>;
const board={id:'board',items:[{id:'parent',planning:{kind:'task'},externalRefs:[reference('one')]}]} as KanbanBoard;
const create=(id:string,parentId?:string):KanbanCommand=>({type:'create-item',item:{id:'child',title:'Child',responsibility:'Work',acceptance:'Checked',externalRefs:[reference(id)]},planning:{kind:'subtask',priority:2,dependencies:[],references:[],parentId}});
it('allows children to choose one project within a shared coordination group and keeps its primary hosting project',async()=>{
 const parent={...board.items[0],purpose:'planning' as const,externalRefs:[reference('one'),reference('two'),{system:'nestos-primary-project',id:'two'}]};
 const multi={...board,items:[parent]};
 expect(workProjectId(parent)).toBe('two');
 expect(workProjectId({...parent,purpose:'execution',planning:{...parent.planning,execution:'direct'}} as any)).toBe('one');
 await expect(validateWorkProjects(projects,multi,create('one','parent'),true)).resolves.toBeUndefined();
 await expect(validateWorkProjects(projects,multi,create('two','parent'),true)).resolves.toBeUndefined();
 await expect(validateWorkProjects(projects,multi,create('other','parent'),true)).rejects.toMatchObject({code:'CHILD_PROJECT_MISMATCH'});
});
it('requires one authorized remote project for executable development work and rejects cross-project children',async()=>{
    await expect(validateWorkProjects(projects,board,create('one','parent'),true)).resolves.toBeUndefined();
    await expect(validateWorkProjects(projects,board,create('two','parent'),true)).rejects.toMatchObject({code:'CHILD_PROJECT_MISMATCH'});
    await expect(validateWorkProjects(projects,board,create('local'),true)).rejects.toMatchObject({code:'REMOTE_PROJECT_REQUIRED'});
    const many=create('one');if(many.type==='create-item')many.item.externalRefs!.push(reference('two'));
    await expect(validateWorkProjects(projects,board,many,true)).rejects.toMatchObject({code:'SINGLE_PROJECT_TASK_REQUIRED'});
    const missing=create('one');if(missing.type==='create-item')missing.item.externalRefs=[];
    await expect(validateWorkProjects(projects,board,missing,true)).rejects.toMatchObject({code:'TASK_PROJECT_REQUIRED'});
    await expect(validateWorkProjects(projects,board,missing,false)).resolves.toBeUndefined();
});
it('prevents rebinding an existing task to another project through references or plan publication',async()=>{
    await expect(validateWorkProjects(projects,board,{type:'link-reference',itemId:'parent',reference:reference('two')},true)).rejects.toMatchObject({code:'TASK_PROJECT_IMMUTABLE'});
    await expect(validateWorkProjects(projects,board,{type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,rootItemId:'parent',items:[{
        id:'child',title:'Child',responsibility:'Work',acceptance:'Checked',workType:'subtask',externalRefs:[reference('two')],assignee:{kind:'service',id:'worker'},dependsOn:[]}] }},true)).rejects.toMatchObject({code:'CHILD_PROJECT_MISMATCH'});
});
