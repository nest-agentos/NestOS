// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {showWebDavMountDialog} from '../src/files/webdav-mount-dialog';

afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');Reflect.deleteProperty(HTMLDialogElement.prototype,'close');});
it('mounts only after explicit location selection and retains the form after a failure', async()=>{
    Object.defineProperty(HTMLDialogElement.prototype,'showModal',{value:vi.fn(),configurable:true});
    Object.defineProperty(HTMLDialogElement.prototype,'close',{value:vi.fn(),configurable:true});
    const fs={viewId:'local-view'},dispose=vi.fn(async()=>{});
    const add=vi.fn().mockRejectedValueOnce(Object.assign(new Error('DAV_LOCK_CONFLICT'),{code:'EBUSY'})).mockResolvedValueOnce(undefined);
    const projects={list:async()=>[{path:'/Local',name:'Local',project:{id:'local',source:{kind:'local'}}}],
        openFiles:vi.fn(async()=>({fs,dispose})),remoteMounts:{connection:()=>({endpoint:'https://dav.test/dav/tlj',protocol:'webdav'}),add}};
    const pending=showWebDavMountDialog(projects as never,'connection');
    await vi.waitFor(()=>expect(document.querySelector('dialog')).not.toBeNull());
    expect(add).not.toHaveBeenCalled();expect(projects.openFiles).not.toHaveBeenCalled();
    const form=document.querySelector('form')!,at=form.querySelector<HTMLInputElement>('[name=at]')!;
    at.value='/tlj';form.querySelector<HTMLSelectElement>('[name=access]')!.value='rw';
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(form.querySelector('[role=status]')!.textContent).toBe('DAV_LOCK_CONFLICT'));
    expect(at.value).toBe('/tlj');expect(dispose).toHaveBeenCalledOnce();
    await vi.waitFor(()=>expect(form.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(false));
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await pending;
    expect(add).toHaveBeenLastCalledWith('local',expect.objectContaining({connectionId:'connection',at:'/tlj',root:'/',access:'rw',protocol:'webdav'}),'',fs,{timeoutMs:10000});
    expect(document.querySelector('dialog')).toBeNull();expect(dispose).toHaveBeenCalledTimes(2);
});
