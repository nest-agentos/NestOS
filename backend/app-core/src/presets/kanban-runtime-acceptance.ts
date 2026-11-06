import {createModuleLogger} from '@nestos/common';
import {gitWorkspace} from '../projects/worktree-modules';
import type {RemoteProcessHandle} from '../projects/remote-mounts';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
const log=createModuleLogger('kanban-runtime-acceptance');
interface Provenance {serviceId:string;version:string;sourceCommit:string;dependencies?:Record<string,{current:string;previous:string}>}
/** Skipped functional verification still needs trusted, unchanged delivery provenance. */
export async function compatibleRuntimeDelivery(process:RemoteProcessHandle,record:DevelopmentWorkspaceRecord,proof:Provenance,previousVersion:string) {
    const choice=(record.context as {decision?:{snapshot?:{verificationLevel?:string;deliveryMode?:string}}})?.decision?.snapshot;
    if(choice?.verificationLevel!=='none'||choice.deliveryMode!=='release'||!/^[a-f0-9]{40,64}$/.test(proof.sourceCommit))return;
    const started=Date.now(),directory=record.directory;
    const source=(await gitWorkspace(process,directory,['rev-parse','--verify','HEAD^{commit}'])).stdout.trim();
    if((await gitWorkspace(process,directory,['merge-base','--is-ancestor',source,proof.sourceCommit],true)).code!==0)return;
    const base=record.repositories.find(row=>row.path==='.')?.baseCommit;if(!base)return;
    const paths=(await gitWorkspace(process,directory,['diff','--name-only','-z',base,source,'--'])).stdout.split('\0').filter(Boolean);
    if(!paths.length||paths.length>256)return;
    const changed=(await gitWorkspace(process,directory,['--literal-pathspecs','diff','--name-only','-z',source,proof.sourceCommit,'--',...paths])).stdout;
    const accepted=!changed&&await unchangedModules(process,directory,source,paths,proof);
    log.info('Runtime delivery provenance inspected',{operation:'kanban.delivery.compatibility',operationId:record.channelId,stage:'task-paths',result:accepted?'success':'failure',code:accepted?undefined:'RUNTIME_DELIVERY_PATHS_CHANGED',pathCount:paths.length,durationMs:Date.now()-started});
    if(!accepted)return;
    return {version:proof.version,receipt:{schema:'nestos.runtime-delivery/1',...proof,previousVersion,sourceCommit:source,runtimeCommit:proof.sourceCommit,verification:'not-requested',taskPathCount:paths.length}};
}

async function unchangedModules(process:RemoteProcessHandle,directory:string,source:string,paths:string[],proof:Provenance):Promise<boolean> {
    const rows=(await gitWorkspace(process,directory,['--literal-pathspecs','ls-tree','-z',source,'--',...paths])).stdout.split('\0');
    for(const row of rows){
        const match=/^160000 commit [a-f0-9]{40,64}\t(.+)$/.exec(row);if(!match)continue;
        const pkg=JSON.parse((await gitWorkspace(process,directory+'/'+match[1],['show','HEAD:package.json'])).stdout) as {name?:string};
        const digest=typeof pkg.name==='string'?proof.dependencies?.[pkg.name]:undefined;
        if(!digest||!/^[a-f0-9]{64}$/.test(digest.current)||digest.current!==digest.previous)return false;
    }
    return true;
}
