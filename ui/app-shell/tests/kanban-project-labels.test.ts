// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {t} from '@nestos/common';
import {kanbanPresentation} from '../src/kanban/host';
import {recordsView,recordDetail} from '../../../libraries/kanban-ui/src/context-view';
const primary='79bdb661-8766-4af8-bb61-10c8d4f2f8cf',secondary='1d53a062-dc77-4350-9688-c13962e3506d';
const ref=(id:string)=>({system:'nestos-remote-project',id});
const refs=[ref(secondary),ref(primary),{system:'nestos-primary-project',id:primary}];
const resources=[{reference:ref(secondary),label:'项目 B'},{reference:ref(primary),label:'项目 A <安全>'}];
const record={id:'decision',kind:'decision',title:'Decision',content:'Scope',rationale:'Check',status:'confirmed',origin:'manual',author:{kind:'human',id:'owner'},createdAt:1,updatedAt:2,revision:1,itemIds:[],sessionIds:[],sources:[],externalRefs:refs} as any;
const board={id:'board',title:'Board',items:[]} as any;
it('uses catalog names in the project cell with primary first, no duplicate prefixes and stable IDs',()=>{
 const original=JSON.stringify(record),root=document.createElement('div');
 root.innerHTML=recordsView(kanbanPresentation,{revision:1,total:1,items:[record]},'decision',false,board,false,{resources});
 const cell=root.querySelector('tbody td:nth-child(2)')!;
 expect(cell.textContent).toBe('项目 A <安全>、项目 B');expect(cell.textContent).not.toContain(primary);expect(cell.textContent).not.toContain(t('kanban.primaryProject'));
 expect(cell.querySelector('span')?.getAttribute('title')).toBe(primary);expect(cell.querySelector('安全')).toBeNull();expect(JSON.stringify(record)).toBe(original);
});
it('shows names in decision details using the same project catalog',()=>{
 const root=document.createElement('div');root.innerHTML=recordDetail(kanbanPresentation,record,board,[],false,resources);
 expect(root.querySelector('.kanban__resource-summary')?.textContent).toBe('项目 A <安全>、项目 B');
});
it('distinguishes unavailable project names from missing or inaccessible references without claiming a failed association',()=>{
 const root=document.createElement('div');
 root.innerHTML=recordsView(kanbanPresentation,{revision:1,total:1,items:[record]},'decision',false,board,false,{resources:undefined});
 expect(root.querySelector('tbody td:nth-child(2)')?.textContent).toContain(t('kanban.projectNamesUnavailable'));
 root.innerHTML=recordsView(kanbanPresentation,{revision:1,total:1,items:[record]},'decision',false,board,false,{resources:[resources[0]]});
 const cell=root.querySelector('tbody td:nth-child(2)')!;
 expect(cell.textContent).toBe(t('kanban.projectReferenceUnavailable')+'、项目 B');expect(cell.textContent).not.toContain(primary);
});
it('uses updated catalog labels on rerender after renaming a project',()=>{
 const root=document.createElement('div'),updated=resources.map(row=>row.reference.id===primary?{...row,label:'项目新名称'}:row);
 root.innerHTML=recordsView(kanbanPresentation,{revision:1,total:1,items:[record]},'decision',false,board,false,{resources:updated});
 expect(root.querySelector('tbody td:nth-child(2)')?.textContent).toBe('项目新名称、项目 B');
});

it('also puts the explicit primary project first in an unconfirmed draft with reversed resource order',()=>{
 const draft={id:'draft',boardId:'board',state:'draft',createdAt:1,resourceId:'/native/draft',primaryResource:ref(primary),resources:[ref(secondary),ref(primary)]};
 const page={revision:1,total:1,items:[],decisionRows:[{kind:'conversation',value:draft}]} as any;
 const root=document.createElement('div');root.innerHTML=recordsView(kanbanPresentation,page,'decision',false,board,false,{resources});
 expect(root.querySelector('tbody td:nth-child(2)')?.textContent).toBe('项目 A <安全>、项目 B');
});

it('resolves project names in task details as well as decision details',async()=>{
 const {detailView}=await import('../../../libraries/kanban-ui/src/forms');
 const item={id:'task',title:'Task',status:'completed',createdAt:1,updatedAt:2,planning:{kind:'task',dependencies:[],references:[],priority:1},externalRefs:refs,participants:[],sources:[],responsibility:'Build',acceptance:'Check'} as any;
 const root=document.createElement('div');root.innerHTML=detailView(kanbanPresentation,board,item,undefined,false,[],false,undefined,false,{phase:'completed',actions:[]},false,resources);
 expect(root.querySelector('.kanban__resource-summary')?.textContent).toBe('项目 A <安全>、项目 B');expect(root.textContent).not.toContain(t('kanban.projectNamesUnavailable'));
});
