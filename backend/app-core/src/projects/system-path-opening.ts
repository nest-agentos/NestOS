import {FSError} from '@nestos/vfs-core';
import type {ProjectFolder, ProjectRemoteMountService} from '@nestos/app-contracts/services';

/** A single read scope chooses a uniquely authorized current project binding. */
export async function chooseSystemPath(projects: readonly ProjectFolder[], remote: ProjectRemoteMountService | undefined,
    projectId: string, path: string, operationId: string): Promise<{project: ProjectFolder; path: string}> {
    if (!path.startsWith('/') || path.length > 4096 || path.split('/').some(part => part === '.' || part === '..')) throw new FSError('EINVAL', 'PATH_INVALID');
    const root = remote?.list(projectId).find(mount => mount.at === '/');
    if (!remote || !root?.connectionId) throw new FSError('ECAPABILITY', 'PATH_RESOLUTION_UNAVAILABLE');
    const scoped = projects.filter(project => remote.list(project.project.id).some(mount => mount.at === '/' && mount.connectionId === root.connectionId)
        && (!(path === '/workspace' || path.startsWith('/workspace/')) || project.project.id === projectId));
    const results = await Promise.all(scoped.map(async project => {
        try {const result = await remote.resolvePath(project.project.id, path, undefined, operationId); return {project, path: result.path, specificity: result.specificity};}
        catch (error) {if ((error as {remoteCode?: string}).remoteCode === 'PATH_UNMAPPED') return undefined; throw error;}
    }));
    const matches = results.filter((value): value is NonNullable<typeof value> => !!value);
    if (!matches.length) throw Object.assign(new FSError('ENOENT', 'PATH_UNMAPPED'), {remoteCode:'PATH_UNMAPPED'});
    const most = Math.max(...matches.map(match => match.specificity));
    const best = matches.filter(match => match.specificity === most);
    if (best.length !== 1) throw Object.assign(new FSError('ECONFLICT', 'PATH_AMBIGUOUS'), {remoteCode:'PATH_AMBIGUOUS'});
    return {project:best[0].project, path:best[0].path};
}
