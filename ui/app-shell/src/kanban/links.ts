import {folderBrowserPath,folderPathFromBrowserPath,remoteSessionPath} from '@nestos/app-contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {KanbanExternalReference,KanbanRecordResource} from '@nestos/kanban/contracts';
import {KANBAN_EXECUTION_SESSION} from '@nestos/app-contracts';
import {t} from '@nestos/common';
import {decisionListPath} from '@nestos/kanban-ui';

export const projectDecisionsPath=(projectId:string):string=>decisionListPath('',{system:'nestos-remote-project',id:projectId});

export const sessionUrl = (id: string): string => workbenchUrl(id);
export const kanbanEntityPath = (board: string, id: string, kind: 'task' | 'decision'): string =>
    `/board/${encodeURIComponent(board)}/${kind === 'decision' ? '@record/' : ''}${encodeURIComponent(id)}`;

function dreamSourceLink(reference: KanbanExternalReference) {
    try {
        const value: unknown = JSON.parse(reference.id);
        if (!Array.isArray(value) || value.length !== 2 || !value.every(id => typeof id === 'string' && id.length)) return;
        const decision = reference.system === 'nestos-dream-source-decision';
        const path = kanbanEntityPath(value[0], value[1], decision ? 'decision' : 'task');
        return {href: `${location.href.split('#')[0]}#/kanban/${encodeURIComponent(path)}`,
            label: t(decision ? 'dream.sourceDecision' : 'dream.sourceTask')};
    } catch {return;}
}
export function kanbanReferenceLink(projects: Pick<ProjectService, 'get'>) {
    return async (reference: KanbanExternalReference, resources?:readonly KanbanRecordResource[]) => {
        if (reference.system === 'nestos-dream-source-task' || reference.system === 'nestos-dream-source-decision')
            return dreamSourceLink(reference);
        if(reference.system==='nestos-primary-project'||reference.system==='nestos-work-directory'||reference.system==='nestos-worktree'){
            const scope=reference.system==='nestos-primary-project'?{projectId:reference.id,directory:''}:directoryScope(reference.revision);
            if(!scope)return;
            const project=projectLinkResource(scope.projectId,resources)??await projects.get(scope.projectId);
            const directory=scope.directory.split('/').filter(Boolean).map(encodeURIComponent).join('/');
            const path=folderBrowserPath(project.path)+'/@files'+(directory?'/'+directory:'');
            return {href:workbenchUrl(path),label:(project.displayName??project.name)+' · /workspace'+(scope.directory?'/'+scope.directory:'')};
        }
        if (reference.system === KANBAN_EXECUTION_SESSION) return {href: sessionUrl(reference.id), label: t('kanban.enterSession'), sessionId: reference.id};
        if (reference.system !== 'nestos-native-session' && reference.system !== 'nestos-decision-source-session') return;
        let scope: {projectId?: string; profileId?: string};
        try {scope = JSON.parse(reference.revision ?? '{}');} catch {return;}
        if (typeof scope.projectId !== 'string' || typeof scope.profileId !== 'string') return;
        const project = projectLinkResource(scope.projectId,resources)??await projects.get(scope.projectId);
        const resource = remoteSessionPath(project.path, scope.profileId, reference.id);
        return {href: workbenchUrl(resource), label: `${t(reference.system === 'nestos-decision-source-session' ? 'kanban.loopSourceSession' : 'kanban.nativeSession')} · ${scope.profileId} · ${reference.id}`, sessionId: resource};
    };
}
function projectLinkResource(id:string,resources?:readonly KanbanRecordResource[]):{path:string;name:string;displayName?:string}|undefined {
    const row=resources?.find(resource=>resource.reference.system==='nestos-remote-project'&&resource.reference.id===id);
    if(!row?.resourceId)return;
    try{
        const path=folderPathFromBrowserPath(row.resourceId);
        if(path&&folderBrowserPath(path)===row.resourceId)return {path,name:row.label};
    }catch{/* Older or invalid projections use the authorized project lookup. */}
}
function workbenchUrl(resource: string): string {return `${location.href.split('#')[0]}#/workbench/${encodeURIComponent(resource)}`;}

function directoryScope(revision:string|undefined):{projectId:string;directory:string}|undefined {
    try {
        const scope=JSON.parse(revision??'null');
        if(typeof scope?.projectId!=='string'||typeof scope.directory!=='string')return;
        const directory=scope.directory.replace(/^\/workspace\//,'');
        if(directory.startsWith('/')||directory.split('/').some((segment:string)=>!segment||segment==='.'||segment==='..'))return;
        return {projectId:scope.projectId,directory};
    }catch{return;}
}
