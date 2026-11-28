import {createModuleLogger, randomUUID, t} from '@nestos/common';
import './model-defaults-tabs.css';

export type MountSettingsSection = (container: HTMLElement) => Promise<{destroy(): void}>;
const log=createModuleLogger('model-defaults');

export function modelDefaultsTabs(container: HTMLElement, mount: MountSettingsSection) {
    const nav=document.createElement('div'), models=document.createElement('div'), kanban=document.createElement('div');
    const lifetime=new AbortController(), id=randomUUID(), panels=[models,kanban];
    models.dataset.modelDefaultsGeneral='';
    nav.className='model-defaults-tabs'; nav.setAttribute('role','tablist'); nav.setAttribute('aria-label',t('modelDefaults.title'));
    const tabs=[t('modelDefaults.modelsTab'),t('modelDefaults.kanbanTab')].map((label,index)=>tab(id,label,index,panels[index]));
    const section=lazySection(kanban,mount,lifetime.signal);
    const activate=(index:number)=>{
        tabs.forEach((button,i)=>{
            button.setAttribute('aria-selected',String(index===i));
            button.tabIndex=index===i?0:-1; panels[i].hidden=index!==i;
        });
        if(index===1)section.open();
    };
    tabs.forEach((button,index)=>button.addEventListener('click',()=>activate(index),{signal:lifetime.signal}));
    nav.addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();
        const next=event.key==='Home'?0:event.key==='End'?1:event.target===tabs[0]?1:0;
        tabs[next].focus();
    },{signal:lifetime.signal});
    nav.append(...tabs); container.replaceChildren(nav,models,kanban); activate(0);
    return {models,destroy:()=>{lifetime.abort();section.destroy();nav.remove();models.remove();kanban.remove();}};
}

function tab(scope: string, label: string, index: number, panel: HTMLElement): HTMLButtonElement {
    const button=document.createElement('button');
    button.type='button'; button.textContent=label; button.id=`settings-tab-${scope}-${index}`;
    button.setAttribute('role','tab');
    panel.id=`settings-panel-${scope}-${index}`;
    panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',button.id);
    button.setAttribute('aria-controls',panel.id);
    return button;
}

function lazySection(panel: HTMLElement, mount: MountSettingsSection, signal: AbortSignal) {
    let pending=false, section:Awaited<ReturnType<MountSettingsSection>>|undefined;
    async function open() {
        if(pending||section||signal.aborted)return;
        pending=true;
        const status=document.createElement('p'); status.setAttribute('role','status');
        status.textContent=t('kanban.boardControl.loading'); panel.replaceChildren(status);
        const operationId=randomUUID(),started=performance.now();
        try {
            const mounted=await mount(panel);
            if(signal.aborted){mounted.destroy();return;}
            section=mounted;status.remove();
        } catch(error) {
            if(signal.aborted)return;
            const code=(error as {code?:unknown})?.code;
            const safeCode=typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'KANBAN_SETTINGS_LOAD_FAILED';
            log.warn('kanban.settings.tab',{operationId,stage:'load',result:'failure',code:safeCode,durationMs:Math.round(performance.now()-started)});
            status.setAttribute('role','alert');status.textContent=t('modelDefaults.harnessTabFailed');
            const retry=document.createElement('button');retry.type='button';retry.textContent=t('kanban.refresh');
            retry.addEventListener('click',()=>{void open();},{signal}); panel.append(retry);
        } finally{pending=false;}
    }
    return {open:()=>{void open();},destroy:()=>section?.destroy()};
}
