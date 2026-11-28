import type {KanbanItem,KanbanPlanning} from "@nestos/kanban/contracts";
import {planningCandidates} from "../src/presets/kanban-planning-candidates";
import {expect,it} from 'vitest';
import {planningSections} from '../src/presets/kanban-planning-sections';
it('keeps the current requirement and provenance while exposing other scopes only through lazy sections',()=>{
    const item={id:'current',title:'Outline',responsibility:'Clarify scope',acceptance:'User confirms',planning:{kind:'task',dependencies:[]}};
    const other={id:'other',title:'Previous work',status:'completed',responsibility:'UNRELATED_DETAIL'.repeat(6000),acceptance:'Evidence',planning:{kind:'task',dependencies:[]}};
    const context={board:{id:'development'},decision:{recordId:'decision'},task:item,snapshot:{item,items:[item,other],workTypes:[],defaultWorkType:'task'}};
    const published=planningSections(context),overview=published['planning-input'] as any;
    expect(overview.item.responsibility).toBe('Clarify scope');expect(overview.items[1].section).toBe('dependency:other');
    expect(JSON.stringify(overview)).not.toContain('UNRELATED_DETAIL');expect(JSON.stringify(published.context)).not.toContain('UNRELATED_DETAIL');
    expect(new TextEncoder().encode(JSON.stringify(published.context)).byteLength).toBeLessThan(65536);
    expect(published['dependency:other']).toBe(other);expect((published.context as any).decision).toEqual({recordId:'decision'});
    expect(context.snapshot.items[1].responsibility).toBe(other.responsibility);
});
it('preserves ordinary work contexts without manufacturing planning sections',()=>{
    const context={task:{id:'work'}};expect(planningSections(context)).toEqual({context});
});

it('keeps active candidates and the relevant history of the current decision',()=>{
    const row=(id:string,values:Partial<KanbanItem>={})=>({id,title:id,status:'completed',...values} as KanbanItem);
    const plan=(parentId?:string,dependencies:string[]=[]):KanbanPlanning=>({kind:'task',priority:2,parentId,dependencies,references:[]});
    const externalRefs=[{system:'nestos-decision-run',id:'decision'}];
    const current=row('current',{status:'open',planning:plan(undefined,['direct']),externalRefs});
    const items=[row('unrelated'),row('active',{status:'backlog'}),current,
        row('deleted',{deletedAt:1,status:'open'}),row('child',{planning:plan('current',['child-input'])}),
        row('peer',{externalRefs}),row('direct',{planning:plan(undefined,['transitive'])}),row('transitive'),row('child-input')];
    expect(planningCandidates(current,items).map(item=>item.id))
        .toEqual(['active','current','child','peer','direct','transitive','child-input']);
});
