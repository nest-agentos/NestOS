import type { IFileSystem, FSNode } from '@nestos/vfs-core';
import type { SessionRepository } from '@nestos/llm-session';
import type { ProjectService, ProjectFolder } from '@nestos/app-contracts/services';
import type { TwinDiscoveredSource, TwinSourceCatalog } from './domain';
import { discoverHarness } from './harness-reader';

export const documentPath = (path: string) => !path.split('/').some(part => part.startsWith('.') || part === 'node_modules')
    && /\.(md|markdown|txt|mind|email|project|rst|adoc|html|csv|ya?ml|json|[cm]?[jt]sx?|py|go|rs|java|c|cpp|h|css|sh|sql)$/i.test(path);
export const projectTarget = (id: string, path: string) => `project://${encodeURIComponent(id)}/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
export const scopeOf = (resource: TwinDiscoveredSource) => `${resource.projectId}/${resource.kind}`;
export const nodeVersion = (node: FSNode) => JSON.stringify([node.createdAt, node.modifiedAt, node.version, node.type === 'file' ? node.size : 0]);

export class TwinProjectCatalog {
    constructor(private readonly projects: ProjectService, private readonly sessions: SessionRepository) {}
    async discover(active: () => boolean = () => true): Promise<TwinSourceCatalog> {
        const projects = active() ? await this.projects.list() : [];
        const catalog: TwinSourceCatalog = { resources: [], projects: [...projects.map(item => item.project.id), '@unassigned'], completeScopes: [], errors: [] };
        for (const project of projects) {
            if (!active()) return catalog;
            await this.files(project, catalog, active);
            if (!active()) return catalog;
            await discoverHarness(this.projects, project, catalog, active);
        }
        if (!active()) return catalog;
        await this.sessionSources(projects, catalog, active);
        if (active()) catalog.completeScopes.push(...catalog.projects.map(id => `${id}/session`));
        if (catalog.resources.length > 10000) throw new Error('TWIN_SOURCE_COUNT_LIMIT');
        return catalog;
    }
    private async sessionSources(projects: ProjectFolder[], catalog: TwinSourceCatalog, active: () => boolean): Promise<void> {
        let visited = 0;
        await this.sessions.walkSummaries(async session => {
            if (visited++ % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
            if (!active()) return false;
            if (/^twin-(analysis|collection)-/.test(session.id)) return;
            const project = projects.filter(item => session.folder && (session.folder === item.path || session.folder.startsWith(item.path + '/')))
                .sort((a, b) => b.path.length - a.path.length)[0];
            catalog.resources.push({ kind: 'session', location: 'local', target: session.id, sessionId: session.id, label: session.title,
                projectId: project?.project.id ?? '@unassigned', projectName: project?.name, version: String(session.updatedAt) });
            if (catalog.resources.length > 10000) throw new Error('TWIN_SOURCE_COUNT_LIMIT');
        });
    }
    private async files(project: ProjectFolder, catalog: TwinSourceCatalog, active: () => boolean): Promise<void> {
        let source: Awaited<ReturnType<ProjectService['openFiles']>> | undefined;
        try {
            source = await this.projects.openFiles(project.path);
            const resources = await this.walk(source.fs, project, active);
            if (!active()) return;
            catalog.resources.push(...resources); catalog.completeScopes.push(`${project.project.id}/file`);
        } catch { catalog.errors.push(`${project.project.id}/file`); }
        finally { await source?.dispose(); }
    }
    private location(project: ProjectFolder, path: string): Pick<TwinDiscoveredSource, 'location' | 'directoryPath'> {
        const mount = this.projects.remoteMounts?.list(project.project.id).filter(item => item.at === '/' || path === item.at || path.startsWith(item.at + '/'))
            .sort((a, b) => b.at.length - a.at.length)[0];
        const location = mount || project.project.source?.kind === 'remote' ? 'remote' : 'local';
        const root = mount?.root ?? project.project.directory;
        const relative = mount && mount.at !== '/' ? path.slice(mount.at.length) : path;
        return { location, ...(root?.startsWith('/') ? { directoryPath: root.replace(/\/$/, '') + '/' + relative.replace(/^\//, '') } : {}) };
    }
    private async walk(fs: IFileSystem, project: ProjectFolder, active: () => boolean): Promise<TwinDiscoveredSource[]> {
        if (!active()) return [];
        const root = await fs.driver.getNode('/');
        if (root?.metadata.isProtected || root?.tags.includes('private')) return [];
        const queue = ['/'], resources: TwinDiscoveredSource[] = []; let visited = 0;
        while (queue.length && active()) {
            const path = queue.shift()!;
            for (const node of await fs.driver.getChildren(path)) {
                if (visited % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
                if (!active()) return resources;
                if (++visited > 100000 || resources.length >= 10000) throw new Error('TWIN_SOURCE_COUNT_LIMIT');
                if (node.metadata.isProtected || node.tags.includes('private') || excluded(node.path)) continue;
                if (node.type === 'directory') queue.push(node.path);
                else if (node.type === 'file' && documentPath(node.path)) resources.push({ kind: 'file',
                    projectId: project.project.id, projectName: project.name, ...this.location(project, node.path),
                    path: node.path.replace(/^\//, ''), target: projectTarget(project.project.id, node.path), label: node.path, version: nodeVersion(node) });
            }
        }
        return resources;
    }
}
const excluded = (path: string) => path.split('/').some(part => part.startsWith('.') || part === 'node_modules');
