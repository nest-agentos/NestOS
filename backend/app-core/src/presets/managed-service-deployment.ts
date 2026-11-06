import type {IFileSystem} from '@nestos/vfs-core';
import type {RuntimeServiceControl} from '../runtime/service-control';
import type {ReviewAdapter} from '../kanban/item-operation-types';
import {readPrompt} from '../run/prompt-bundle';
import {requireValue} from '../kanban/validation';
/** Project declarations select a controller; only a trusted host port grants execution authority. */
export function managedServiceDeployment(control:RuntimeServiceControl|undefined,open:(item:import('@nestos/kanban/contracts').KanbanItem)=>Promise<{fs:IFileSystem;dispose():Promise<void>}>,verify:(job:import('../kanban/item-operation-types').ReviewJob)=>Promise<void>):ReviewAdapter['managed'] {
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
