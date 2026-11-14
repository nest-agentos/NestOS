// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({start:vi.fn(async()=>{}),destroy:vi.fn()}));
vi.mock('@nestos/llm-ui-adapter',()=>({NativeInteractionPanel:class {start=mocks.start;destroy=mocks.destroy;}}));
import {sessionInteractionDialog} from '../src/kanban/session-interactions';
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
function fixture(){
 const controls={close:vi.fn(async()=>{})},remoteMounts={projectConversation:vi.fn(async()=>controls)},projects={forFolder:vi.fn(async()=>({path:'/cx1',project:{id:'cx1'}})),remoteMounts},openSession=vi.fn(async()=>{});
 const open=sessionInteractionDialog(projects as never,openSession);
 return {open,controls,projects,remoteMounts,openSession};
}
it('opens the original authorized Session in a read-only-on-open panel and releases it on dismissal',async()=>{
 const f=fixture(),pending=f.open('/folder:cx1/@harness/codex/native');
 await vi.waitFor(()=>expect(mocks.start).toHaveBeenCalledOnce());
 expect(f.remoteMounts.projectConversation).toHaveBeenCalledWith('cx1','codex','native',{timeoutMs:3000});
 expect(document.querySelectorAll('.ui-modal__footer button')).toHaveLength(1);
 document.querySelector<HTMLButtonElement>('.settings-modal-close')!.click();await pending;
 expect(mocks.destroy).toHaveBeenCalledOnce();expect(f.controls.close).toHaveBeenCalledOnce();expect(f.openSession).not.toHaveBeenCalled();
});
it('retains the original Session entry and closes the panel when its owner is disposed',async()=>{
 const f=fixture(),abort=new AbortController(),pending=f.open('/folder:cx1/@harness/codex/native',abort.signal);
 await vi.waitFor(()=>expect(mocks.start).toHaveBeenCalledOnce());abort.abort();await pending;
 expect(f.controls.close).toHaveBeenCalledOnce();expect(mocks.destroy).toHaveBeenCalledOnce();
});
it('rejects changed project bindings before opening any native control port',async()=>{
 const f=fixture();f.projects.forFolder.mockResolvedValueOnce({path:'/other',project:{id:'cx1'}});
 await expect(f.open('/folder:cx1/@harness/codex/native')).rejects.toMatchObject({code:'EACCES'});
 expect(f.remoteMounts.projectConversation).not.toHaveBeenCalled();
});
