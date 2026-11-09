import {expect,it,vi} from 'vitest';
import {folderBrowserPath} from '@nestos/app-contracts';
import {projectDirectoryActions} from '../src/projects/directory-actions';
import {projectDecisionsPath} from '../src/kanban/links';
import {kanbanPresentation} from '../src/kanban/host';
it('opens decisions for the captured project without reading the default project or creating records',async()=>{
 const decisions=vi.fn(async()=>{}),projects={forFolder:vi.fn()} as any;
 const selected={path:'/Projects/secondary',project:{id:'secondary',source:{kind:'remote'}}} as any;
 const actions=await projectDirectoryActions(folderBrowserPath(selected.path),null,projects,{decisions,session:vi.fn(),project:vi.fn(),entry:vi.fn(),report:vi.fn()},selected);
 const action=actions.find(row=>row.id==='project-decisions')!;expect(action.primary).toBe(true);action.run();
 expect(decisions).toHaveBeenCalledExactlyOnceWith('secondary');expect(projects.forFolder).not.toHaveBeenCalled();
 expect(projectDecisionsPath('secondary')).toBe('/@resource/nestos-remote-project/secondary');
});
it('labels primary and secondary roles while leaving legacy ownership unclassified',()=>{
 const one={system:'nestos-remote-project',id:'one'},two={system:'nestos-remote-project',id:'two'},refs=[one,two,{system:'nestos-primary-project',id:'one'}];
 expect(kanbanPresentation.resourceRole?.(one,refs)).not.toBe(kanbanPresentation.resourceRole?.(two,refs));
 expect(kanbanPresentation.resourceRole?.(one,[one,two])).toBeUndefined();
});
