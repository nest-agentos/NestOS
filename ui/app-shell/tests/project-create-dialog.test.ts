// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FSError} from '@nestos/vfs-core';
import type {ProjectService} from '@nestos/app-contracts/services';
import {showProjectDialog} from '../src/files/project-dialog';
beforeEach(()=>{
    HTMLDialogElement.prototype.showModal=function(){this.open=true;};
    HTMLDialogElement.prototype.close=function(){this.open=false;};
});
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});
function setup(pending:Promise<any[]>) {
    const navigationFolders=vi.fn(()=>pending),navigation=vi.fn(),forFolder=vi.fn(),create=vi.fn(async()=>({path:'/New'}));
    const projects={navigationFolders,forFolder,canSelectDirectory:false,sessions:{navigation},create} as unknown as ProjectService;
    const controller=new AbortController(),created=vi.fn(async()=>{});
    const closed=showProjectDialog(projects,null,controller.signal,created);
    return {navigationFolders,navigation,forFolder,create,controller,created,closed};
}
function submit(){document.querySelector<HTMLFormElement>('dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
function cancel(){document.querySelector<HTMLDialogElement>('dialog')!.dispatchEvent(new Event('cancel',{cancelable:true}));}
it('shows immediately while loading one folder query, without reading sessions or probing every folder',async()=>{
    let resolve!:(folders:any[])=>void;const f=setup(new Promise(value=>{resolve=value;}));
    expect(document.querySelector('dialog[open]')).not.toBeNull();expect(document.body.textContent).toContain('正在加载项目分组');
    expect(f.navigationFolders).toHaveBeenCalledOnce();expect(f.navigation).not.toHaveBeenCalled();expect(f.forFolder).not.toHaveBeenCalled();
    submit();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')!.textContent).toContain('正在加载'));expect(f.create).not.toHaveBeenCalled();
    resolve([{path:'/Group',name:'Group'}, {path:'/Group/Project',name:'Project',project:{id:'demo'}},
        {path:'/Group/Project/@sessions',name:'@sessions'}, {path:'/Group/Project/docs',name:'docs'}]);
    await vi.waitFor(()=>expect(document.querySelector('select')!.disabled).toBe(false));
    expect([...document.querySelectorAll('select option')].map(option=>(option as HTMLOptionElement).value)).toEqual(['','/Group']);
    document.querySelector<HTMLInputElement>('form > label input')!.value='New';submit();await f.closed;
    expect(f.create).toHaveBeenCalledWith('New',null,undefined,undefined);expect(f.created).toHaveBeenCalledWith('/New');
});
it('explains folder loading errors and retries without losing the entered name',async()=>{
    const f=setup(Promise.reject(new FSError('ETIMEDOUT','private server response')));
    await vi.waitFor(()=>expect(document.body.textContent).toContain('ETIMEDOUT'));
    expect(document.body.textContent).not.toContain('private server response');
    const input=document.querySelector<HTMLInputElement>('form > label input')!;input.value='Kept draft';
    f.navigationFolders.mockResolvedValueOnce([]);
    const retry=[...document.querySelectorAll('button')].find(button=>button.textContent==='重新加载分组')!;retry.click();
    await vi.waitFor(()=>expect(document.querySelector('select')!.disabled).toBe(false));expect(input.value).toBe('Kept draft');
    expect(f.navigationFolders).toHaveBeenCalledTimes(2);cancel();await f.closed;expect(f.create).not.toHaveBeenCalled();
});
it('ignores late folder results after closing the dialog',async()=>{
    let resolve!:(folders:any[])=>void;const f=setup(new Promise(value=>{resolve=value;}));
    const select=document.querySelector('select')!;cancel();await f.closed;resolve([{path:'/Late'}]);
    await Promise.resolve();await Promise.resolve();expect(document.querySelector('dialog')).toBeNull();expect(select.options).toHaveLength(1);
    expect(f.create).not.toHaveBeenCalled();
});
