import {remoteSessionPath} from '@nestos/app-contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {KanbanExternalReference} from '@nestos/kanban/contracts';
import {KANBAN_EXECUTION_SESSION} from '@nestos/app-contracts';
import {t} from '@nestos/common';

export const sessionUrl = (id: string): string => workbenchUrl(id);
export function kanbanReferenceLink(projects: Pick<ProjectService, 'get'>) {
    return async (reference: KanbanExternalReference) => {
        if (reference.system === KANBAN_EXECUTION_SESSION) return {href: sessionUrl(reference.id), label: t('kanban.executionSession'), sessionId: reference.id};
        if (reference.system !== 'nestos-native-session') return;
        let scope: {projectId?: string; profileId?: string};
        try {scope = JSON.parse(reference.revision ?? '{}');} catch {return;}
        if (typeof scope.projectId !== 'string' || typeof scope.profileId !== 'string') return;
        const project = await projects.get(scope.projectId);
        const resource = remoteSessionPath(project.path, scope.profileId, reference.id);
        return {href: workbenchUrl(resource), label: `${t('kanban.nativeSession')} · ${scope.profileId} · ${reference.id}`, sessionId: resource};
    };
}
function workbenchUrl(resource: string): string {return `${location.href.split('#')[0]}#/workbench/${encodeURIComponent(resource)}`;}
