// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {createSettingsFactory,type SettingsFactoryOptions} from '@nestos/app-settings';
import {mountKanbanHarnessSettings} from '../../src/kanban/model-defaults-section';

const choices=[{value:'',label:'Auto'},{value:'codex',label:'Codex'},{value:'agy',label:'Antigravity'}];
const catalog={fields:['decision','coordination','execution'].map(role=>({name:'harness-'+role,label:role,choices}))};
const board={id:'board',title:'Board',revision:7,settings:{'harness-decision':'codex','harness-execution':'agy'}};

async function fixture(){
    const service={
        catalog:vi.fn(async()=>[board]),
        boardSettings:vi.fn(async()=>catalog),
        execute:vi.fn(async()=>({...board,revision:8})),
    };
    const global={
        readKanbanHarnessDefaults:vi.fn(async()=>({revision:2,settings:{'harness-decision':'agy'},catalog})),
        readKanbanHarnessModels:vi.fn(async()=>[{id:'neon',label:'Gemini Neon',reasoningEfforts:[{id:'high',label:'High'}]}]),
        saveKanbanHarnessDefaults:vi.fn(async(request)=>({...request,revision:3})).mockRejectedValueOnce(Object.assign(new Error('Unknown receipt'),{code:'ETIMEDOUT',outcome:'unknown'})),
    };
    class Editor {async init(host:HTMLElement){host.textContent='Models';} async destroy(){}}
    const section=vi.fn(async(host:HTMLElement)=>mountKanbanHarnessSettings(host,service as never,global));
    const factory=createSettingsFactory({llmUiEditors:{ModelDefaultsEditor:Editor},modelDefaultsSection:section} as unknown as SettingsFactoryOptions);
    const host=document.createElement('div');
    const editor=await factory(host,{target:{kind:'configuration',id:'model-defaults'}} as never);
    const tabs=host.querySelectorAll<HTMLButtonElement>('[role=tab]');
    const field=(role:string)=>host.querySelector<HTMLSelectElement>('select[name=setting-harness-'+role+']')!;
    return {host,editor,tabs,field,service,global,section};
}

it('loads the Kanban tab on demand and retries one global save with all three roles',async()=>{
    const f=await fixture();
    expect(f.section).not.toHaveBeenCalled();
    expect(f.tabs[0].getAttribute('aria-selected')).toBe('true');
    f.tabs[1].click();
    await vi.waitFor(()=>expect(f.field('decision')?.value).toBe('agy'));
    expect(f.tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(f.service.boardSettings).not.toHaveBeenCalled();
    f.field('coordination').value='codex'; f.field('execution').value='agy';
    const decisionModel=()=>f.field('decision').parentElement!.querySelectorAll<HTMLSelectElement>('select')[1];
    const decisionEffort=()=>f.field('decision').parentElement!.querySelectorAll<HTMLSelectElement>('select')[2];
    await vi.waitFor(()=>expect(decisionModel().querySelector('option[value=neon]')).toBeTruthy());
    decisionModel().value='neon'; decisionModel().dispatchEvent(new Event('change'));
    decisionEffort().value='high'; decisionEffort().dispatchEvent(new Event('change'));
    const form=f.field('decision').form!;
    form.dispatchEvent(new Event('submit',{cancelable:true}));
    await vi.waitFor(()=>expect(f.host.querySelector('[role=alert]')?.textContent).toContain('ETIMEDOUT'));
    expect(f.field('decision').disabled).toBe(true);
    form.dispatchEvent(new Event('submit',{cancelable:true}));
    await vi.waitFor(()=>expect(f.field('decision').disabled).toBe(false));
    expect(f.global.saveKanbanHarnessDefaults.mock.calls[1]).toEqual(f.global.saveKanbanHarnessDefaults.mock.calls[0]);
    expect(f.global.saveKanbanHarnessDefaults).toHaveBeenCalledWith({operationId:expect.any(String),revision:2,
        settings:{'harness-decision':'agy','harness-coordination':'codex','harness-execution':'agy',
            'harness-decision-selection':JSON.stringify({profileId:'agy',modelId:'neon',reasoningEffort:'high'})}});
    f.tabs[0].click(); f.tabs[1].click();
    expect(f.global.readKanbanHarnessDefaults).toHaveBeenCalledOnce();
    await f.editor.destroy(); expect(f.host.children).toHaveLength(0);
});

it('edits per-board overrides without saving global defaults or execution limits',async()=>{
    const f=await fixture(); f.tabs[1].click();
    await vi.waitFor(()=>expect(f.host.querySelector('option[value=board]')).toBeTruthy());
    const select=f.host.querySelector<HTMLSelectElement>('select[id^=model-defaults-harness-scope]')!;
    select.value='board'; select.dispatchEvent(new Event('change'));
    await vi.waitFor(()=>expect(f.field('decision')?.value).toBe('codex'));
    expect(f.field('coordination').value).toBe('');
    expect(f.field('execution').value).toBe('agy');
    expect(f.host.querySelector('[name=executionSlots]')).toBeNull();
    f.field('decision').value='agy';
    f.field('decision').form!.dispatchEvent(new Event('submit',{cancelable:true}));
    await vi.waitFor(()=>expect(f.service.execute).toHaveBeenCalledWith('board',{
        operationId:expect.any(String),expectedRevision:7,
        command:{type:'configure-board-settings',settings:{'harness-decision':'agy','harness-coordination':'','harness-execution':'agy'}},
    }));
    expect(f.global.saveKanbanHarnessDefaults).not.toHaveBeenCalled();
    await f.editor.destroy();
});
