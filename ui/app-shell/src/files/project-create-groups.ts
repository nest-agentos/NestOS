import {createModuleLogger,randomUUID,t} from '@nestos/common';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {SessionFolder} from '@nestos/llm-session/contracts';
const log=createModuleLogger('project-create');

/** The create dialog reads organization metadata, never session contents/history. */
export function projectCreateGroups(projects:ProjectService,parent:string|null,fields:HTMLElement,signal:AbortSignal) {
    const label=document.createElement('label');label.textContent=t('project.group');
    const select=document.createElement('select');select.setAttribute('aria-label',t('project.group'));label.append(select);
    const root=document.createElement('option');root.value='';root.textContent=t('project.root');select.append(root);select.disabled=true;
    const status=document.createElement('p');status.setAttribute('role','status');
    const retry=document.createElement('button');retry.type='button';retry.textContent=t('project.groupsRetry');retry.hidden=true;
    fields.append(label,status,retry);let ready=false,loading=false;
    const load=async()=>{
        if(loading||signal.aborted)return;loading=true;status.textContent=t('project.groupsLoading');retry.hidden=true;
        const started=performance.now(),operationId=randomUUID();
        try {
            const folders=await projects.navigationFolders();if(signal.aborted)return;
            for(const folder of organizationGroups(folders)){const option=document.createElement('option');option.value=folder.path;option.textContent=folder.path;select.append(option);}
            select.value=parent??'';select.disabled=false;ready=true;status.textContent='';
            log.info('project.create.groups',{operationId,operation:'project.create',stage:'groups',result:'success',folderCount:folders.length,durationMs:Math.round(performance.now()-started)});
        }catch(error){
            if(signal.aborted)return;
            const raw=(error as {code?:string})?.code,code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'PROJECT_GROUPS_FAILED';status.textContent=t('project.groupsFailed',{code});retry.hidden=false;
            log.warn('project.create.groups',{operationId,operation:'project.create',stage:'groups',result:'failure',code,durationMs:Math.round(performance.now()-started)});
        }finally{loading=false;}
    };
    retry.addEventListener('click',()=>{void load();},{signal});void load();
    return {select,assertReady(){if(!ready)throw new Error(t(loading?'project.groupsLoading':'project.groupsUnavailable'));}};
}
function organizationGroups(folders:readonly SessionFolder[]):readonly SessionFolder[] {
    const roots=folders.filter(folder=>folder.project).map(folder=>folder.path);
    return folders.filter(folder=>!folder.project&&!roots.some(root=>folder.path===root||folder.path.startsWith(root+'/')));
}
