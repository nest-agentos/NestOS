import {prerequisiteProbe,workspacePrerequisites,workspacePrerequisitesFile} from '@nestos/kanban-development';
import type {KanbanDecisionModule,KanbanProjectRecord} from '@nestos/kanban/contracts';
import type {TaskRecoveryOptions} from '../kanban/task-recovery-ports';
import {hasDecisionModule} from '../kanban/decision-modules';
import {requireValue} from '../kanban/validation';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import type {ProjectRemoteMountService,RemoteFileSourceProvider} from '../projects/remote-mounts';

export function developmentTaskRecheck(remote:ProjectRemoteMountService,provider:RemoteFileSourceProvider,module:KanbanDecisionModule):NonNullable<TaskRecoveryOptions['recheck']> {
    const declared=(record:DevelopmentWorkspaceRecord)=>{
        const decision=(record.context as {decision?:{snapshot?:KanbanProjectRecord}}|undefined)?.decision;
        if(!hasDecisionModule(decision?.snapshot?.externalRefs,module))return;
        return record.policy?.prompts?.files?.find(file=>file.name===workspacePrerequisitesFile);
    };
    return {supports:record=>!!declared(record),run:async record=>{
        const file=declared(record);
        requireValue(file,'WORKSPACE_PREREQUISITES_UNAVAILABLE');
        requireValue(/^\/workspace\/_nestos\/worktrees\/[\w-]{1,128}$/.test(record.directory),'WORKTREE_SCOPE_INVALID');
        const probe=prerequisiteProbe(workspacePrerequisites(file.content));
        return developmentWorkspace(remote,provider,record.projectId,async process=>{
            const result=await process.nativeShell.exec(probe.command,probe.args,{cwd:record.directory,timeoutMs:10000});
            requireValue(result.code===0,'WORKSPACE_PREREQUISITES_UNCONFIRMED');
            const missing=result.stdout.trim().split('\n').filter(Boolean);
            requireValue(missing.every(entry=>probe.checks.includes(entry)),'WORKSPACE_PREREQUISITES_UNCONFIRMED');
            return missing;
        });
    }};
}
