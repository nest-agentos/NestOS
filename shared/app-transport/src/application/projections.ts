import { createFile } from '@nestos/vfs-core';
import { favoriteKey, projectNavigation, projectFileSource, projectWorkspaceAccess, toolGrant } from '@nestos/app-contracts';
import type { ProjectFavoriteTarget,RemoteSessionStatus } from '@nestos/app-contracts/services';
import {readSessionHistory} from './session-history';
import {shareFileObservers,shareChangeObservers} from './file-observers';

/** Synchronous UI reads project already loaded snapshots; writes always cross the port. */
export function installViewProjections(kind: string, proxy: any): void {
    if (['IFileSystem', 'FileSystemView', 'IFSDriver'].includes(kind)) shareFileObservers(proxy);
    if(kind==='ProjectRemoteMountService')shareChangeObservers(proxy);
    if (kind === 'SessionManagementPort') {
        const read = proxy.getSnapshot;
        proxy.getSnapshot = () => readSessionHistory(read());
        proxy.getSessions = () => proxy.getSnapshot().sessions ?? [];
        proxy.getStatus = () => proxy.getSnapshot().status;
        proxy.isGenerating = () => proxy.getSnapshot().isRunning;
    }
    if (kind === 'ApplicationViewObservation') {
        const read = proxy.getSessionBaseline;
        proxy.getSessionBaseline = () => {const baseline = read(); return {...baseline, snapshot: readSessionHistory(baseline.snapshot)};};
    }
    if (kind === 'IFileSystem' || kind === 'FileSystemView') proxy.openFile = (path: string) => createFile(proxy, path);
    if (kind === 'IAgentManagementService' || kind === 'IConnectionService') {
        proxy.findAgent = (id: string) => proxy.listAgents?.().find((item: any) => item.id === id);
        proxy.findConnection = (id: string) => proxy.listConnections().find((item: any) => item.id === id);
        proxy.getProvider = (id: string) => proxy.getProviders().find((item: any) => item.id === id);
    }
    if (kind === 'ProjectService') {
        proxy.listNavigation = (folders: Parameters<typeof projectNavigation>[0]) => projectNavigation(folders, proxy.remoteMounts);
        proxy.fileSource = (project: Parameters<typeof projectFileSource>[0]) => projectFileSource(project, proxy.remoteMounts);
        proxy.workspaceAccess = (project: Parameters<typeof projectWorkspaceAccess>[0], access?: 'ro' | 'rw') => projectWorkspaceAccess(project, proxy.remoteMounts, access);
    }
    if (kind === 'ToolboxResources') proxy.toolGrant = toolGrant;
    if(kind==='RemoteSessionStatus'&&typeof proxy.records==='function')installRemoteStatus(proxy);
    if (kind === 'ToolboxDrawers') {
        proxy.get = (id: string) => proxy.snapshot().find((drawer: any) => drawer.id === id);
        proxy.list = (kind: string) => proxy.snapshot().filter((drawer: any) => drawer.kind === kind);
        proxy.forPath = (path: string) => proxy.snapshot().find((drawer: any) => drawer.paths.includes(path));
    }
    if (kind === 'ProjectFavorites') installFavorites(proxy);
}
function installRemoteStatus(proxy:any):void {
    proxy.record=(projectId:string,profileId:string,sessionId:string)=>(proxy.records(projectId)??[])
        .find((row:NonNullable<ReturnType<RemoteSessionStatus['record']>>)=>row.profileId===profileId&&row.sessionId===sessionId);
    proxy.get=(projectId:string,profileId:string,sessionId:string)=>proxy.record(projectId,profileId,sessionId)?.observation;
}
function installFavorites(proxy: any): void {
    proxy.hasSession = (id: string) => Object.values(proxy.snapshot() as Record<string, Array<{ target: ProjectFavoriteTarget }>>)
        .some(items => items.some(item => item.target.kind === 'session' && item.target.sessionId === id));
    proxy.has = (id: string, target: ProjectFavoriteTarget) => (proxy.snapshot()[id] ?? [])
        .some((item: { target: ProjectFavoriteTarget }) => favoriteKey(item.target) === favoriteKey(target));
}
