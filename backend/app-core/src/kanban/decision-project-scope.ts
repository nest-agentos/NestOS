import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import {requireValue} from './validation';

/** Cell identity and project revisions come from registered grants, never from model text. */
export function decisionProjectScope(remote:Pick<ProjectRemoteMountService,'list'>,primaryProjectId:string,projectIds:string[]) {
    requireValue(projectIds.length>0&&projectIds.length<=16&&new Set(projectIds).size===projectIds.length&&projectIds.includes(primaryProjectId),'DECISION_PROJECTS_REQUIRED');
    const roots=projectIds.map(id=>remote.list(id).find(mount=>mount.at==='/'));
    const primary=roots[projectIds.indexOf(primaryProjectId)];
    requireValue(primary?.serverId&&primary.serverProjectId&&primary.authorization,'DECISION_PROJECT_BINDING_REQUIRED');
    requireValue(roots.every(root=>root?.serverId===primary.serverId),'DECISION_PROJECT_CELL_MISMATCH');
    requireValue(roots.every(root=>root?.authorization?.principalId===primary.authorization!.principalId&&root?.authorization?.revision===primary.authorization!.revision),'DECISION_PROJECT_AUTHORIZATION_MISMATCH');
    return roots.map(root=>{
        requireValue(root?.serverProjectId&&Number.isSafeInteger(root.serverProjectRevision)&&root.serverProjectRevision!>0,'DECISION_PROJECT_BINDING_REQUIRED');
        return {projectId:root.serverProjectId,revision:root.serverProjectRevision!};
    });
}
export function requireDecisionProjectContext(receipt:unknown,projects:Array<{projectId:string;revision:number}>):void {
    const value=receipt as {projectContext?:{projects?:Array<{projectId:string;revision:number;directory:string}>}};
    const actual=value?.projectContext?.projects;
    requireValue(Array.isArray(actual)&&actual.length===projects.length&&projects.every(project=>actual.some(row=>row.projectId===project.projectId&&row.revision===project.revision&&typeof row.directory==='string'&&row.directory.startsWith('/'))),'CELL_PROJECT_CONTEXT_REQUIRED');
}
