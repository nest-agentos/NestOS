// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {t} from '@nestos/common';
import type {ProjectRemoteMount} from '@nestos/app-contracts/services';
import {diagnosticAccessForProject,showProjectDiagnosticSettings} from '../src/projects/project-diagnostic-settings';

const methods:Array<()=>unknown>=[];
beforeEach(()=>{
    for(const name of ['showModal','close']){
        const descriptor=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,name);
        Object.defineProperty(HTMLDialogElement.prototype,name,{configurable:true,value:vi.fn()});
        methods.push(()=>descriptor?Object.defineProperty(HTMLDialogElement.prototype,name,descriptor):Reflect.deleteProperty(HTMLDialogElement.prototype,name));
    }
});
afterEach(()=>{document.body.replaceChildren();methods.splice(0).forEach(restore=>restore());});

it('saves only the selected sources and keeps the draft when another page saved first',async({onTestFinished})=>{
    const controller=new AbortController();
    onTestFinished(()=>controller.abort());
    const readDiagnosticAccess=vi.fn(async()=>({revision:'current',sources:[]}));
    const saveDiagnosticAccess=vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Conflict'),{remoteCode:'SERVICE_DIAGNOSTICS_ACCESS_CONFLICT'}))
        .mockResolvedValueOnce({revision:'next',sources:['cells']});
    const dialog=showProjectDiagnosticSettings({readDiagnosticAccess,saveDiagnosticAccess},'x1',controller.signal);
    await vi.waitFor(()=>expect(document.querySelector('dialog')).not.toBeNull());
    const submit=()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
    const cells=document.querySelector<HTMLInputElement>('input[name="cells"]')!;
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input=>input.checked)).toEqual([false,false]);
    cells.checked=true;
    submit();
    await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toBe(t('project.diagnosticAccess.conflict')));
    expect(cells.checked).toBe(true);
    expect(readDiagnosticAccess).toHaveBeenCalledExactlyOnceWith('x1');
    expect(saveDiagnosticAccess).toHaveBeenCalledExactlyOnceWith('x1',{sources:['cells'],expectedRevision:'current',operationId:expect.any(String)});
    submit();
    await dialog;
    expect(saveDiagnosticAccess.mock.calls[1]).toEqual(saveDiagnosticAccess.mock.calls[0]);
});

it('shows the menu only for the matching registered root and principal',()=>{
    const project={serverId:'local-cells',serverProjectId:'x1',principalId:'owner',alias:'prj',root:'/x1'};
    const mount:ProjectRemoteMount={...project,at:'/',access:'rw',mountId:'mount',endpoint:'http://127.0.0.1:8787',credentialRef:'credential',
        authorization:{principalId:'owner',anonymous:false,revision:'1'}};
    const access={projects:[project],readDiagnosticAccess:vi.fn(),saveDiagnosticAccess:vi.fn()};
    expect(diagnosticAccessForProject(access,[mount])).toBe(access);
    expect(diagnosticAccessForProject(access,[{...mount,serverId:'vm'}])).toBeUndefined();
    expect(diagnosticAccessForProject(access,[{...mount,authorization:{...mount.authorization!,principalId:'other'}}])).toBeUndefined();
    expect(access.readDiagnosticAccess).not.toHaveBeenCalled();
});

it('keeps stale binding errors inside the log settings without offering a save',async({onTestFinished})=>{
    const controller=new AbortController();
    onTestFinished(()=>controller.abort());
    const access={readDiagnosticAccess:vi.fn(async()=>{throw Object.assign(new Error('Denied'),{code:'SERVICE_PROJECT_UNAUTHORIZED'});}),
        saveDiagnosticAccess:vi.fn()};
    const dialog=showProjectDiagnosticSettings(access,'x1',controller.signal);
    await vi.waitFor(()=>expect(document.querySelector('dialog [role="alert"]')?.textContent).toBe(t('project.diagnosticAccess.bindingRequired')));
    expect(document.querySelector('dialog button[type="submit"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('dialog button')!.click();
    await dialog;
    expect(access.saveDiagnosticAccess).not.toHaveBeenCalled();
});
