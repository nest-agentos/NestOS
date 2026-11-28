import {sha256HexSync} from '@nestos/common';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import {initializeResourceIndex,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import {prepareWorktree} from '@nestos/git-delivery/worktrees';
import {availableWorktreeModules} from '@nestos/git-delivery/repositories';
import type {RemoteFileSourceProvider} from '../projects/remote-mounts';
import {requireValue} from '../kanban/validation';
import {publishNativeWork,requireNativeWorkspaceHarness,resolveNativeWork,type NativeWorkspaceOptions,type NativeWorkInput} from './kanban-native-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentWorkspace} from './kanban-development-workspace';
import {registerWorkResource} from './kanban-work-resource-catalog';

export interface IntegrationWorkspacePorts extends NativeWorkspaceOptions {
    provider:RemoteFileSourceProvider;
    ensureSession(id:string,title:string):Promise<void>;
}

export async function prepareIntegrationWorkspace(options:IntegrationWorkspacePorts,journal:KanbanAutomationJournal,
    scope:{board:KanbanBoard;item:KanbanItem;sourceId:string;record:DevelopmentWorkspaceRecord;target:NativeWorkInput['target']}) {
    const id='integration-'+sha256HexSync(JSON.stringify([scope.board.id,scope.item.id,scope.sourceId])).slice(0,48);
    const input=workInput(scope,id),binding=await resolveNativeWork(options,journal,input);
    requireValue(binding.projectId===scope.record.projectId,'OPERATION_WORKSPACE_SCOPE_MISMATCH');
    await requireNativeWorkspaceHarness(options,binding.projectId,binding.profileId);
    const directory='_nestos/worktrees/'+id;
    await initializeResourceIndex(journal,id);
    await registerWorkResource(journal,id,{projectId:binding.projectId,context:scope.record.context});
    const {tree,record}=await developmentWorkspace(options.remote,options.provider,binding.projectId,async process=>{
        const tree=await prepareWorktree(journal,id,'/workspace/'+directory,process);
        const record=await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+id);
        if(record)return {tree,record};
        const availableRepositories=await availableWorktreeModules(process,tree);
        const saved=await journal.update<DevelopmentWorkspaceRecord>('development-workspace:'+id,old=>old??{
            channelId:id,projectId:binding.projectId,directory:tree.directory,context:scope.record.context,
            policy:{...scope.record.policy,commit:'changes',modules:[]},gitIdentity:scope.record.gitIdentity,
            repositories:[{path:'.',branch:tree.branch,baseCommit:tree.baseCommit}],availableRepositories});
        return {tree,record:saved};
    });
    const target=await publishNativeWork(options,journal,input,binding,directory,'Coordinate integration using the frozen operation and its instructions.');
    await options.ensureSession(id,scope.item.title);
    return {id,tree,record,target};
}

function workInput({board,item,target,record}:Parameters<typeof prepareIntegrationWorkspace>[2],id:string):NativeWorkInput {
    const preparation=board.automation?.preparation,principal=board.automation?.coordinator;
    requireValue(preparation&&principal,'OPERATION_ORIGINAL_SESSION_UNAVAILABLE');
    return {board,item,target,preparation,stage:'decision',context:{primaryProjectId:record.projectId},
        dispatch:{id,itemId:item.id,itemRevision:item.revision,planId:id,planRevision:1,principal,
            definitionDigest:target.digest,attempt:1,fence:id,preparedAt:Date.now(),outcome:'prepared',inputs:{}}};
}
