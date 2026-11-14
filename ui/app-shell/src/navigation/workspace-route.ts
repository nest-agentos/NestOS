import { folderBrowserPath } from '@nestos/app-contracts';
import type { ProjectService } from '@nestos/app-contracts/services';
import { t } from '@nestos/common';

export {parseWorkspaceHash} from './workspace-hash';

/** Old .prj files stay in their original filesystem and are exposed as project files. */
export async function resolveLegacyProjectResource(resource: string, projects: ProjectService): Promise<string> {
    const project = await projects.ensureDirectory('/home/admin/projects', t('project.legacyDocuments'));
    return `${folderBrowserPath(project.path)}/@files${resource.startsWith('/') ? resource : '/' + resource}`;
}
