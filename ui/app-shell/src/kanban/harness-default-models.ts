import {createModuleLogger,randomUUID,t} from '@nestos/common';
import type {KanbanHarnessModel,KanbanHarnessModelSelection} from '@nestos/kanban/contracts';

type Lookup=(profileId:string)=>Promise<KanbanHarnessModel[]>;
type Saved=KanbanHarnessModelSelection&{profileId:string};
const log=createModuleLogger('kanban-harness-default-models');
const selectClass='settings-form__select';

export function harnessDefaultModels(profile:HTMLSelectElement,key:string,raw:string|undefined,lookup:Lookup):HTMLElement {
    const area=document.createElement('div'), value=document.createElement('input'), status=document.createElement('p');
    const model=document.createElement('select'), effort=document.createElement('select'), retry=document.createElement('button');
    const modelLabel=control(t('kanban.harnessModel'),model),effortLabel=control(t('kanban.harnessEffort'),effort);
    let generation=0,models:KanbanHarnessModel[]=[];
    value.type='hidden';value.name='setting-'+key;value.value=raw??'';
    status.setAttribute('role','status');
    retry.type='button';retry.textContent=t('kanban.refresh');retry.hidden=true;
    area.append(value,modelLabel,effortLabel,status,retry);
    const render=(saved?:Saved)=>{
        choices(model,models,saved?.modelId);
        const levels=models.find(row=>row.id===model.value)?.reasoningEfforts??[];
        choices(effort,levels,saved?.reasoningEffort);
        modelLabel.hidden=!models.length&&!saved;
        effortLabel.hidden=!levels.length&&!saved?.reasoningEffort;
    };
    const load=()=>void refresh();
    model.onchange=()=>{render({profileId:profile.value,modelId:model.value});store();};
    effort.onchange=store;
    profile.addEventListener('change',()=>{value.value='';load();});
    retry.onclick=load;
    queueMicrotask(load);
    return area;

    function store() {
        value.value=model.value?JSON.stringify({profileId:profile.value,modelId:model.value,
            ...(effort.value?{reasoningEffort:effort.value}:{})}):'';
    }

    async function refresh() {
        const token=++generation, profileId=profile.value, saved=readSaved(value.value,profileId);
        area.hidden=!profileId; retry.hidden=true;status.textContent='';models=[];
        render(saved);
        if(!profileId)return;
        const operationId=randomUUID(),started=performance.now();
        status.textContent=t('kanban.boardControl.loading');
        try{
            const available=await lookup(profileId);
            if(token!==generation)return;
            models=available;render(readSaved(value.value,profileId));
            status.textContent=models.length?'':t('modelDefaults.harnessNoModels');
            log.debug('settings.models',{operationId,stage:'read',result:'success',count:models.length,durationMs:Math.round(performance.now()-started)});
        }catch(error){
            if(token!==generation)return;
            const code=(error as {code?:unknown})?.code;
            const safeCode=typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'KANBAN_HARNESS_MODEL_UNAVAILABLE';
            status.textContent=t('modelDefaults.harnessModelsFailed',{code:safeCode});retry.hidden=false;
            log.warn('settings.models',{operationId,stage:'read',result:'failure',code:safeCode,durationMs:Math.round(performance.now()-started)});
        }
    }
}

function choices(select:HTMLSelectElement,options:{id:string;label:string}[],selected?:string):void {
    select.replaceChildren(new Option(t('modelDefaults.harnessNativeDefault'),''),...options.map(option=>new Option(option.label,option.id)));
    if(selected&&!options.some(option=>option.id===selected))select.add(new Option(selected,selected));
    select.value=selected??'';
}

function control(name:string,select:HTMLSelectElement):HTMLLabelElement {
    const label=document.createElement('label');label.textContent=name;select.className=selectClass;label.append(select);return label;
}

function readSaved(raw:string,profileId:string):Saved|undefined {
    try{
        const saved=JSON.parse(raw) as Saved|null;
        if(saved?.profileId===profileId&&typeof saved.modelId==='string')return saved;
    }catch{return;}
}
