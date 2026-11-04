import type {ProjectFolder} from '@nestos/app-contracts/services';
import type {SessionFolder} from '@nestos/llm-session/contracts';

/** Combine a prepared project catalog with organization records without more storage reads. */
export function navigationFolders(projects: readonly ProjectFolder[], folders: readonly SessionFolder[]): SessionFolder[] {
    const children = folders.filter(folder => !folder.project && projects.some(project =>
        folder.path.startsWith(project.path + '/') || project.path.startsWith(folder.path + '/')));
    const sections = projects.filter(project => !children.some(folder => folder.path === project.path + '/@sessions'))
        .map(project => ({path: project.path + '/@sessions', name: '@sessions', parentPath: project.path, updatedAt: project.updatedAt}));
    return [...projects, ...children, ...sections];
}
