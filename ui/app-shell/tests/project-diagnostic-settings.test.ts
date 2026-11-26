// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {t} from '@nestos/common';
import {showProjectDiagnosticSettings} from '../src/projects/project-diagnostic-settings';

afterEach(()=>document.body.replaceChildren());

it('saves only the selected sources and keeps the draft when another page saved first',async({onTestFinished})=>{
    const controller=new AbortController();
    const methods=['showModal','close'].map(name=>{
        const descriptor=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,name);
        Object.defineProperty(HTMLDialogElement.prototype,name,{configurable:true,value:vi.fn()});
        return ()=>descriptor?Object.defineProperty(HTMLDialogElement.prototype,name,descriptor):Reflect.deleteProperty(HTMLDialogElement.prototype,name);
    });
    onTestFinished(()=>{controller.abort();methods.forEach(restore=>restore());});
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
