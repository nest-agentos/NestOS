import type {ProjectService} from '@nestos/app-contracts/services';
import type {KanbanProjectRecord} from '@nestos/kanban/contracts';
import {validateResourceReferences, type KanbanResourceCatalog} from '@nestos/kanban/integration';
import {requireValue} from './validation';

export const REMOTE_PROJECT_REFERENCE = 'nestos-remote-project';
export function projectResourceCatalog(projects: Pick<ProjectService, 'get'> & Partial<Pick<ProjectService, 'list'>>): KanbanResourceCatalog {
    return {system: REMOTE_PROJECT_REFERENCE, decisionSystem: 'nestos-decision-run',
        list: async () => (await projects.list?.() ?? []).filter(row => row.project?.source?.kind === 'remote')
            .map(row => ({reference: {system: REMOTE_PROJECT_REFERENCE, id: row.project.id}, label: row.displayName ?? row.name})),
        validate: async references => {
            for (const ref of references) requireValue((await projects.get(ref.id)).project?.source?.kind === 'remote', 'REMOTE_PROJECT_REQUIRED');
        },
    };
}
export function validateRemoteReferences(projects: Pick<ProjectService,'get'>, record: Pick<KanbanProjectRecord,'externalRefs'>): Promise<void> {
    return validateResourceReferences(projectResourceCatalog(projects),record);
}
