import {randomUUID, t} from '@nestos/common';
import type {ProjectDiagnosticAccess, ServiceDiagnosticSource} from '@nestos/app-contracts/services';
import {showNameDialog} from '../files/project-dialog';

export async function showProjectDiagnosticSettings(access:ProjectDiagnosticAccess, id:string, signal:AbortSignal):Promise<void>{
    if(signal.aborted)return;
    const current=await access.readDiagnosticAccess(id).catch(error=>{
        if(['SERVICE_PROJECT_BINDING_REQUIRED','SERVICE_PROJECT_UNAUTHORIZED','SERVICE_PROJECT_SOURCE_CHECKOUT_MISMATCH'].includes(diagnosticErrorCode(error)))
            throw new Error(t('project.diagnosticAccess.bindingRequired'),{cause:error});
        throw error;
    });
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
            if(diagnosticErrorCode(error)==='SERVICE_DIAGNOSTICS_ACCESS_CONFLICT')
                throw new Error(t('project.diagnosticAccess.conflict'),{cause:error});
            throw error;
        }
    },fields,{hideName:true,confirmLabel:t('action.save')});
}

function diagnosticErrorCode(error:unknown):string{
    const failure=error as {code?:string;remoteCode?:string}|undefined;
    return failure?.remoteCode??failure?.code??'';
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
