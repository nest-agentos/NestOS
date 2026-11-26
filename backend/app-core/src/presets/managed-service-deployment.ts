import type {IFileSystem} from '@nestos/vfs-core';
import type {ProjectRemoteMountPort,RuntimeServiceControl,RuntimeServiceProject} from '@nestos/app-contracts/services';
import type {ReviewAdapter} from '@nestos/kanban-development';
import {readPrompt} from '../run/prompt-bundle';
import {requireValue} from '../kanban/validation';
import {createModuleLogger,randomUUID,sha256HexSync} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
const log=createModuleLogger('kanban.deployment');
export function serviceDeploymentView(view:{fs:IFileSystem;dispose():Promise<void>},remote:Pick<ProjectRemoteMountPort,'list'|'projectRemountOptions'>|undefined,projectId:string){
    return {fs:view.fs,dispose:()=>view.dispose(),project:()=>resolveServiceProject(remote,projectId)};
}
export async function resolveServiceProject(remote:Pick<ProjectRemoteMountPort,'list'|'projectRemountOptions'>|undefined,projectId:string):Promise<RuntimeServiceProject|undefined>{
    const root=remote?.list(projectId).find(mount=>mount.at==='/');
    if(!remote||!root?.serverId||!root.serverProjectId||!root.authorization?.principalId)return;
    const binding=await remote.projectRemountOptions(projectId,{timeoutMs:3000});
    requireValue(binding.alias===root.alias&&('/'+binding.path).replace(/\/$/,'')===(root.root.replace(/\/$/,''))&&
        remote.list(projectId).find(mount=>mount.at==='/')?.mountId===root.mountId,'SERVICE_PROJECT_BINDING_CHANGED');
    return {serverId:root.serverId,serverProjectId:root.serverProjectId,principalId:root.authorization.principalId,alias:root.alias,root:root.root};
}
/** Project declarations select a controller; only a trusted host port grants execution authority. */
export function managedServiceDeployment(control:RuntimeServiceControl|undefined,open:(item:import('@nestos/kanban/contracts').KanbanItem)=>Promise<{fs:IFileSystem;dispose():Promise<void>;project?():Promise<RuntimeServiceProject|undefined>}>,verify:(job:import('@nestos/kanban-development').ReviewJob)=>Promise<void>):ReviewAdapter['managed'] {
    if(!control)return;
    const describe=async(item:import('@nestos/kanban/contracts').KanbanItem)=>{
        const view=await open(item);
        const started=Date.now(),operationId=randomUUID();
        try{const file='/workspace/_nestos/etc/deployment.json';if(!await view.fs.driver.exists(file))return;
            const config=JSON.parse(await readPrompt(view.fs,file));requireValue(config?.schema===1||config?.schema===2,'DEPLOYMENT_CONFIGURATION_INVALID');
            const serviceId=config.schema===1?config.serviceId:config.bindings?.[item.id]??config.defaultServiceId;
            requireValue(typeof serviceId==='string'&&/^[\w.-]{1,128}$/.test(serviceId),'DEPLOYMENT_CONFIGURATION_INVALID');
            const project=control.describeForProject?await view.project?.():undefined;
            requireValue(!control.describeForProject||project,'SERVICE_PROJECT_BINDING_REQUIRED');
            const target=control.describeForProject&&project?await control.describeForProject(serviceId,project):await control.describe(serviceId);
            if(control.describeForProject)requireValue(target.artifact?.store?.base==='source-checkout'&&target.build?.base==='source-checkout','SERVICE_SOURCE_BUILD_REQUIRED');
            log.info('Managed service selection',{operationId,stage:'project.bind',result:'success',durationMs:Date.now()-started});
            return control.describeForProject||serviceId===target.id?target:undefined;
        }catch(error){
            log.warn('Managed service selection',{operationId,stage:'project.bind',result:'failure',code:safeCode(error,'SERVICE_PROJECT_BINDING_REQUIRED'),durationMs:Date.now()-started});throw error;
        }finally{await view.dispose();}
    };
    return {describe,reuseBuild:async(job,item)=>{
        if(!control.runningArtifact&&!control.preparedArtifact)return;
        const target=await describe(item),store=target?.artifact?.store;
        if(!target?.project||!target.artifact||!store)return;
        const request={serviceId:target.id,sourceVersion:job.snapshot.targetVersion,project:target.project};
        const running=await control.runningArtifact?.(request);
        const candidate=running?.version===target.version?running:await control.preparedArtifact?.(request);
        if(!candidate)return;
        const result={schema:'nestos.kanban.operation-result/1',operationId:job.id,sourceVersion:job.snapshot.sourceVersion,
            targetVersion:job.snapshot.targetVersion,status:'succeeded',version:candidate.version,summary:'Host verified the release artifact for the integrated commit.',
            evidence:{path:`${store.path}/${candidate.version}/${target.artifact.manifest}`,sha256:candidate.sha256},
            deployment:{serviceId:target.id,projectDigest:deploymentProjectDigest(target.project)}};
        await verifyManagedBuildArtifact(control,target,result,job.snapshot.targetVersion);
        await verify(job);
        return result;
    },prepare:async input=>{
        const target=await describe(input.item);
        const frozen=(input.context as {deployment?:{serviceId?:string;projectDigest?:string}})?.deployment;
        requireValue(!frozen?.serviceId||frozen.serviceId===target?.id,'SERVICE_TARGET_CHANGED_REBUILD');if(!target)return;
        requireValue(!target.project||frozen?.projectDigest===deploymentProjectDigest(target.project),'SERVICE_PROJECT_CHANGED_REBUILD');
        const version=(input.context as {version?:string})?.version;requireValue(version,'OPERATION_RESULT_VERSION_REQUIRED');
        return {operationId:input.id,serviceId:target.id,expectedVersion:target.version,targetVersion:version,...(target.project?{project:target.project}:{})};
    },submit:async(request,item)=>{
        requireValue(!control.describeForProject||request.project,'SERVICE_PROJECT_CHANGED_REBUILD');
        if(request.project){
            requireValue(item,'SERVICE_PROJECT_BINDING_REQUIRED');
            const target=await describe(item);
            requireValue(target?.id===request.serviceId&&target.project&&deploymentProjectDigest(target.project)===deploymentProjectDigest(request.project),'SERVICE_PROJECT_CHANGED_REBUILD');
        }
        await control.submit(request);
    },inspect:async job=>{
        const observed=await control.inspect(job.managed!);if(observed.state!=='succeeded')return observed;
        await verify(job);
        return {...observed,output:{schema:'nestos.kanban.operation-result/1',operationId:job.id,sourceVersion:job.snapshot.sourceVersion,targetVersion:job.snapshot.targetVersion,status:'succeeded',version:observed.version,summary:'Service controller verified the selected release and health.'}};
    }};
}

export function deploymentProjectDigest(project:RuntimeServiceProject):string{
    return sha256HexSync(JSON.stringify([project.serverId,project.serverProjectId,project.principalId,project.alias,project.root]));
}

/** Resolve only the artifact location frozen by the trusted deployment descriptor. */
export async function verifyManagedBuildArtifact(control:RuntimeServiceControl|undefined,deployment:import('@nestos/app-contracts/services').RuntimeServiceDescriptor|undefined,result:unknown,sourceVersion?:string):Promise<boolean> {
    const artifact=deployment?.artifact;if(artifact?.store?.base!=='source-checkout')return false;
    const value=result as {operationId?:string;version?:string;artifact?:unknown;evidence?:{path?:string;sha256?:string}};
    requireValue(typeof value.version==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value.version),'OPERATION_RESULT_VERSION_REQUIRED');
    requireValue(value.evidence?.path===artifact.store.path+'/'+value.version+'/'+artifact.manifest&&typeof value.evidence.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.evidence.sha256),'OPERATION_RESULT_ARTIFACT_UNVERIFIED');
    requireValue(!deployment?.project||typeof sourceVersion==='string'&&/^[a-f0-9]{40,64}$/.test(sourceVersion),'SERVICE_SOURCE_COMMIT_REQUIRED');
    requireValue(typeof value.operationId==='string'&&!!control?.verifyArtifact,'SERVICE_ARTIFACT_VERIFICATION_UNAVAILABLE');
    await control!.verifyArtifact!({operationId:value.operationId!,serviceId:deployment!.id,version:value.version!,sha256:value.evidence!.sha256!,...(sourceVersion?{sourceVersion}:{}),...(deployment?.project?{project:deployment.project}:{})});return true;
}
