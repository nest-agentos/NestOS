import {createModuleLogger} from '@nestos/common';
import {harnessArchiveAllowed} from '@nestos/cells-driver';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {ProjectRemoteMountService} from './remote-mounts';
import {readContextCatalog,type ContextInspector} from './harness-context-catalog';
import type {PromptJournal} from '../run/prompt-bundle';
import {failure} from '../run/prompt-bundle';
interface Archive {phase:'prepared'|'submitting'|'done';nodeConnectionId:string;workspaceId:string;projectId:string;profileId:string;sessionId:string;epoch:string}

/** Archive the confirmed native binding without resuming it or deleting its history. */
export function nativeSessionArchive(kernel:ContextInspector,projects:Pick<ProjectService,'list'>,remote:ProjectRemoteMountService,journal:PromptJournal) {
    return async(sessionId:string,operationId:string):Promise<void>=>{
        const started=Date.now(),key='session-archive:'+operationId;let saved=await journal.get<Archive>(key);
        if(saved?.phase==='done')return;
        if(!saved){
            const catalog=await readContextCatalog(kernel,sessionId),bindings=Object.values(catalog.value.bindings).filter(row=>row.validity==='valid'&&row.nativeRef);
            if(!bindings.length)return;
            const native=bindings[0].nativeRef!;if(bindings.some(row=>JSON.stringify(row.nativeRef)!==JSON.stringify(native)))throw failure('SESSION_ARCHIVE_BINDING_AMBIGUOUS');
            const folders=(await projects.list()).filter(row=>row.project&&remote.list(row.project.id).some(m=>m.at==='/'&&m.connectionId===native.nodeConnectionId&&m.serverProjectId===native.workspaceId));
            if(folders.length!==1)throw bindingFailure(folders.length?'SESSION_ARCHIVE_BINDING_AMBIGUOUS':'SESSION_ARCHIVE_PROJECT_UNAVAILABLE',sessionId,operationId,'binding.resolve',{matchingProjects:folders.length,nodeConnectionId:native.nodeConnectionId,workspaceId:native.workspaceId,profileId:native.profileId},started);
            const projectId=folders[0].project!.id,client=await remote.projectHarness(projectId);
            try{const profiles=await client.profiles();saved=await journal.update<Archive>(key,old=>old??{phase:'prepared',nodeConnectionId:native.nodeConnectionId,workspaceId:native.workspaceId,projectId,profileId:native.profileId,sessionId:native.sessionId,epoch:profiles.epoch});}
            finally{await client.close();}
        }
        await archive(remote,journal,key,saved,operationId);
    };
}
async function archive(remote:ProjectRemoteMountService,journal:PromptJournal,key:string,saved:Archive,id:string):Promise<void> {
    const started=Date.now();
    if(!remote.list(saved.projectId).some(root=>root.at==='/'&&root.connectionId===saved.nodeConnectionId&&root.serverProjectId===saved.workspaceId))throw bindingFailure('SESSION_ARCHIVE_BINDING_CHANGED',saved.sessionId,id,'binding.revalidate',{projectId:saved.projectId,nodeConnectionId:saved.nodeConnectionId,workspaceId:saved.workspaceId},started);
    const client=await remote.projectHarness(saved.projectId),options={requestId:id,epoch:saved.epoch};
    try{
        if(saved.phase==='submitting'){
            const receipt=await client.operation(saved.profileId,id,options);
            if(receipt.outcome==='unknown')throw failure('SESSION_ARCHIVE_OUTCOME_UNKNOWN');
            if(receipt.outcome==='committed'){await journal.update<Archive>(key,old=>({...old!,phase:'done'}));return;}
        }
        if(!client.archive||!client.inspect)throw failure('SESSION_ARCHIVE_UNSUPPORTED');
        const {session}=await client.inspect(saved.profileId,saved.sessionId);
        if(!session.archived){
            if(!harnessArchiveAllowed(session))throw failure('SESSION_ARCHIVE_STILL_RUNNING');
            await journal.update<Archive>(key,old=>({...old!,phase:'submitting'}));
            const result=await client.archive(saved.profileId,saved.sessionId,true,options);
            if(!result.session.archived)throw failure('SESSION_ARCHIVE_UNCONFIRMED');
        }
        await journal.update<Archive>(key,old=>({...old!,phase:'done'}));
    }finally{await client.close();}
}

function bindingFailure(code:string,sessionId:string,operationId:string,stage:string,metadata:Record<string,string|number>,started:number) {
    createModuleLogger('SessionArchive').warn('Native archive binding unavailable',{operation:'session.archive',operationId,sessionId,
        stage,result:'failure',code,durationMs:Date.now()-started,...metadata});
    return failure(code);
}
