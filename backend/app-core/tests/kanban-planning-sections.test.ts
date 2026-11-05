import {expect,it} from 'vitest';
import {planningSections} from '../src/presets/kanban-planning-sections';
it('keeps the current requirement and provenance while exposing other scopes only through lazy sections',()=>{
    const item={id:'current',title:'Outline',responsibility:'Clarify scope',acceptance:'User confirms',planning:{kind:'task',dependencies:[]}};
    const other={id:'other',title:'Previous work',status:'completed',responsibility:'UNRELATED_DETAIL'.repeat(1000),acceptance:'Evidence',planning:{kind:'task',dependencies:[]}};
    const context={board:{id:'development'},decision:{recordId:'decision'},task:item,snapshot:{item,items:[item,other],workTypes:[],defaultWorkType:'task'}};
    const published=planningSections(context),overview=published['planning-input'] as any;
    expect(overview.item.responsibility).toBe('Clarify scope');expect(overview.items[1].section).toBe('dependency:other');
    expect(JSON.stringify(overview)).not.toContain('UNRELATED_DETAIL');expect(JSON.stringify(published.context)).not.toContain('UNRELATED_DETAIL');
    expect(published['dependency:other']).toBe(other);expect((published.context as any).decision).toEqual({recordId:'decision'});
    expect(context.snapshot.items[1].responsibility).toBe(other.responsibility);
});
it('preserves ordinary work contexts without manufacturing planning sections',()=>{
    const context={task:{id:'work'}};expect(planningSections(context)).toEqual({context});
});
