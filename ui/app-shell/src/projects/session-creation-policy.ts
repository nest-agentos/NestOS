import type { ProjectService } from '@nestos/app-contracts/services';
import { t } from '@nestos/common';

/** The same project policy drives page, sidebar and menu creation commands. */
export function sessionCreationReason(projects: ProjectService, projectId: string): string | undefined {
    const remote = projects.remoteMounts;
    if (remote?.projectOffline(projectId)) return t('remote.projectOffline');
    if (remote?.list(projectId).some(mount => mount.at === '/' && mount.access === 'ro')) return t('project.creationReadOnly');
    return;
}
