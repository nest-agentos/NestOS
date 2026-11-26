import {createModuleLogger,randomUUID} from '@nestos/common';
import type {LocalApplicationServices,ProjectDiagnosticAccess,ServiceDiagnosticAccess} from '@nestos/app-contracts/services';
import {resolveServiceProject} from '../presets/managed-service-deployment';
import {requireValue} from '../kanban/validation';
import {safeCode} from '@nestos/kanban/integration';

const log=createModuleLogger('service-diagnostics-settings');

export function projectDiagnosticAccess(services:LocalApplicationServices):ProjectDiagnosticAccess|undefined{
    const control=services.serviceControl;
    if(!control?.diagnosticAccess||!control.saveDiagnosticAccess)return;
    const binding=async(id:string)=>{
        requireValue(typeof id==='string'&&id.length>0&&id.length<=128,'SERVICE_PROJECT_BINDING_REQUIRED');
        const project=await resolveServiceProject(services.projects.remoteMounts,id);
        requireValue(project,'SERVICE_PROJECT_BINDING_REQUIRED');
        return project;
    };
    return {
        readDiagnosticAccess:id=>trackAccess('read',undefined,async()=>control.diagnosticAccess!(await binding(id))),
        saveDiagnosticAccess:(id,change)=>trackAccess('save',change?.operationId,async()=>control.saveDiagnosticAccess!(await binding(id),change)),
    };
}

async function trackAccess(stage:'read'|'save',supplied:unknown,work:()=>Promise<ServiceDiagnosticAccess>):Promise<ServiceDiagnosticAccess>{
    const operationId=typeof supplied==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(supplied)?supplied:randomUUID();
    const metadata={operationId,operation:'service.diagnostics.access',stage},started=Date.now();
    try{
        const result=await work();
        log.info('Diagnostic access checked',{...metadata,result:'success',count:result.sources.length,durationMs:Date.now()-started});
        return result;
    }catch(error){
        log.warn('Diagnostic access rejected',{...metadata,result:'failure',code:safeCode(error,'SERVICE_DIAGNOSTICS_ACCESS_FAILED'),durationMs:Date.now()-started});
        throw error;
    }
}
