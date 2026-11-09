import {t} from '@nestos/common';
import type {ProjectRemoteMount, ProjectRemoteMountPort} from '@nestos/app-contracts/services';

export async function projectRemountFields(remote:ProjectRemoteMountPort,id:string,root:ProjectRemoteMount,signal:AbortSignal) {
    const panel=document.createElement('div'),access=document.createElement('select');
    for(const mode of ['ro','rw'] as const){const option=document.createElement('option');option.value=mode;option.textContent=t(`remote.access.${mode}`);access.append(option);}
    access.value=root.access;field(panel,t('remote.remountAccess'),access);
    const current=document.createElement('p');current.textContent=t('remote.remountCurrent',{path:'/'+root.alias+(root.root==='/'?'':root.root)});panel.append(current);
    const alias=document.createElement('select'),path=document.createElement('input');
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=t('remote.remountChooseExport');placeholder.disabled=true;alias.append(placeholder);
    field(panel,t('remote.remountExport'),alias);field(panel,t('remote.remountPath'),path);
    let supported=false;
    try {
        const options=await remote.projectRemountOptions(id,{signal,timeoutMs:10000});
        if(signal.aborted)throw signal.reason;
        for(const item of options.roots){const option=document.createElement('option');option.value=item.alias;option.textContent=item.alias+' · '+t(`remote.access.${item.access}`);alias.append(option);}
        alias.value=options.alias;path.value=options.path;supported=true;
    } catch(error){
        if((error as {code?:string}).code!=='ECAPABILITY')throw error;
        alias.disabled=true;path.disabled=true;
        const note=document.createElement('p');note.textContent=t('remote.remountUpgrade');panel.append(note);
    }
    const note=document.createElement('p');note.textContent=t('remote.remountEffect');panel.append(note);
    return {panel,access:()=>access.value as 'ro'|'rw',directory:()=>{if(!supported)return undefined;if(!alias.value)throw new Error(t('remote.remountChooseExport'));return {alias:alias.value,path:path.value.trim().replace(/^\/+|\/+$/g,'')};}};
}
function field(panel:HTMLElement,text:string,input:HTMLInputElement|HTMLSelectElement):void {
    const label=document.createElement('label');label.textContent=text;input.setAttribute('aria-label',text);label.append(input);panel.append(label);
}

export function remountFailure(error:unknown):unknown {
    const failure=(error??{}) as {code?:string;remoteCode?:string};
    const code=failure.remoteCode??failure.code;
    const key=code==='PROJECT_DIRECTORY_ALREADY_REGISTERED'?'remote.remountDuplicate':code==='PROJECT_DIRECTORY_CHANGED'?'remote.remountDirectoryMismatch':code==='PROJECT_REVISION_CHANGED'?'remote.remountStale':code==='EBUSY'?'remote.remountBusy':undefined;
    return key?Object.assign(new Error(t(key),{cause:error}),{code:failure.code,remoteCode:failure.remoteCode}):error;
}
