import type {IFileSystem} from '@nestos/vfs-core';
import type {RuntimeServiceControl} from '@nestos/app-contracts/services';
import type {ReviewAdapter} from '@nestos/kanban-development';
import {readPrompt} from '../run/prompt-bundle';
import {requireValue} from '../kanban/validation';
/** Project declarations select a controller; only a trusted host port grants execution authority. */
export function managedServiceDeployment(control:RuntimeServiceControl|undefined,open:(item:import('@nestos/kanban/contracts').KanbanItem)=>Promise<{fs:IFileSystem;dispose():Promise<void>}>,verify:(job:import('@nestos/kanban-development').ReviewJob)=>Promise<void>):ReviewAdapter['managed'] {
    if(!control)return;
    const describe=async(item:import('@nestos/kanban/contracts').KanbanItem)=>{
        const view=await open(item);
        try{const file='/workspace/_nestos/etc/deployment.json';if(!await view.fs.driver.exists(file))return;
            const config=JSON.parse(await readPrompt(view.fs,file));requireValue(config?.schema===1&&typeof config.serviceId==='string','DEPLOYMENT_CONFIGURATION_INVALID');
            const target=await control.describe();return config.serviceId===target.id?target:undefined;
        }finally{await view.dispose();}
    };
    return {describe,prepare:async input=>{
        const target=await describe(input.item);if(!target)return;
        const version=(input.context as {version?:string})?.version;requireValue(version,'OPERATION_RESULT_VERSION_REQUIRED');
        return {operationId:input.id,serviceId:target.id,expectedVersion:target.version,targetVersion:version};
    },submit:request=>control.submit(request),inspect:async job=>{
        const observed=await control.inspect(job.managed!);if(observed.state!=='succeeded')return observed;
        await verify(job);
        return {...observed,output:{schema:'nestos.kanban.operation-result/1',operationId:job.id,sourceVersion:job.snapshot.sourceVersion,targetVersion:job.snapshot.targetVersion,status:'succeeded',version:observed.version,summary:'Service controller verified the selected release and health.'}};
    }};
}

/** Resolve only the artifact location frozen by the trusted deployment descriptor. */
export async function verifyManagedBuildArtifact(control:RuntimeServiceControl|undefined,deployment:import('@nestos/app-contracts/services').RuntimeServiceDescriptor|undefined,result:unknown):Promise<boolean> {
    const artifact=deployment?.artifact;if(artifact?.store?.base!=='source-checkout')return false;
    const value=result as {operationId?:string;version?:string;artifact?:unknown;evidence?:{path?:string;sha256?:string}};
    requireValue(typeof value.version==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value.version),'OPERATION_RESULT_VERSION_REQUIRED');
    requireValue(value.evidence?.path===artifact.store.path+'/'+value.version+'/'+artifact.manifest&&typeof value.evidence.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.evidence.sha256),'OPERATION_RESULT_ARTIFACT_UNVERIFIED');
    requireValue(typeof value.operationId==='string'&&!!control?.verifyArtifact,'SERVICE_ARTIFACT_VERIFICATION_UNAVAILABLE');
    await control!.verifyArtifact!({operationId:value.operationId!,serviceId:deployment!.id,version:value.version!,sha256:value.evidence!.sha256!});return true;
}
