import {randomUUID, t} from '@nestos/common';
import type {ProjectDiagnosticAccess, ProjectRemoteMount, ServiceDiagnosticSource} from '@nestos/app-contracts/services';
import {showNameDialog} from '../files/project-dialog';

export function diagnosticAccessForProject(access:ProjectDiagnosticAccess|undefined,mounts:ProjectRemoteMount[]):ProjectDiagnosticAccess|undefined{
    const mount=mounts.find(item=>item.at==='/');
    if(mount&&access?.projects?.some(project=>project.serverId===mount.serverId&&project.serverProjectId===mount.serverProjectId
        &&project.principalId===mount.authorization?.principalId&&project.alias===mount.alias&&project.root===mount.root))return access;
}

export async function showProjectDiagnosticSettings(access:ProjectDiagnosticAccess, id:string, signal:AbortSignal):Promise<void>{
    if(signal.aborted)return;
    const current=await access.readDiagnosticAccess(id).catch(async error=>{
        const note=document.createElement('p');
        note.setAttribute('role','alert'); note.textContent=diagnosticErrorMessage(error);
        await showNameDialog(t('project.diagnosticAccess.title'),'',signal,undefined,note,{hideName:true});
    });
    if(!current)return;
    if(signal.aborted)return;
    const fields=document.createElement('div');
    const note=document.createElement('p');
    note.textContent=t('project.diagnosticAccess.description');
    fields.append(note);
    const sources=['httpd','cells'] as const;
    const inputs=sources.map(source=>diagnosticSourceField(fields,source,current.sources.includes(source)));
    let intent:{key:string;operationId:string}|undefined;
    await showNameDialog(t('project.diagnosticAccess.title'),'',signal,async()=>{
        const selected=sources.filter((_,index)=>inputs[index]?.checked);
        const key=selected.join();
        if(key===current.sources.join())return;
        if(intent?.key!==key)intent={key,operationId:randomUUID()};
        try{
            await access.saveDiagnosticAccess(id,{sources:selected,expectedRevision:current.revision,operationId:intent.operationId});
        }catch(error){
            throw new Error(diagnosticErrorMessage(error),{cause:error});
        }
    },fields,{hideName:true,confirmLabel:t('action.save')});
}

function diagnosticErrorMessage(error:unknown):string{
    const failure=error as {code?:string;remoteCode?:string}|undefined;
    const code=failure?.remoteCode??failure?.code??'';
    if(code==='SERVICE_DIAGNOSTICS_ACCESS_CONFLICT')return t('project.diagnosticAccess.conflict');
    if(['SERVICE_PROJECT_BINDING_REQUIRED','SERVICE_PROJECT_BINDING_CHANGED','SERVICE_PROJECT_UNAUTHORIZED','SERVICE_PROJECT_SOURCE_CHECKOUT_MISMATCH'].includes(code))
        return t('project.diagnosticAccess.bindingRequired');
    return error instanceof Error ? error.message : String(error);
}

function diagnosticSourceField(fields:HTMLElement,source:ServiceDiagnosticSource,checked:boolean):HTMLInputElement{
    const label=document.createElement('label');
    label.className='project-diagnostic-settings__source';
    const input=document.createElement('input');
    input.type='checkbox';
    input.name=source;
    input.checked=checked;
    label.append(input,t(source==='httpd'?'project.diagnosticAccess.httpd':'project.diagnosticAccess.cells'));
    fields.append(label);
    return input;
}
