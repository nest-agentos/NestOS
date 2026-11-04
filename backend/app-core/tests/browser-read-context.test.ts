import {expect, it, vi} from 'vitest';
import type {ISessionRepository} from '@nestos/llm-session/contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {BrowserReadContext} from '../src/session/browser-read-context';

function fixture() {
    const project = {path: '/x1', name: 'x1', parentPath: null, updatedAt: 1, project: {id: 'x1', directory: 'project:x1'}};
    const listFolders = vi.fn(async () => [project]);
    const dispose = vi.fn(async () => {}), navigation = vi.fn(async () => ({path: '/folder:x1', projects: [project]}));
    const openWorkspace = vi.fn(async () => ({fs: {}, dispose})), list = vi.fn(async () => []);
    const repository = {listFolders} as unknown as ISessionRepository;
    const projects = {navigation, openWorkspace, list: vi.fn(async () => [project]), favorites: {list}} as unknown as ProjectService;
    return {repository, projects, dispose, navigation, openWorkspace, list, listFolders};
}
it('shares display facts and a workspace only within one query', async () => {
    const f = fixture(), query = new BrowserReadContext(f.repository, f.projects, '/folder:x1');
    await Promise.all([query.navigation(), query.catalog(), query.folders(), query.folders(), query.project('/x1'), query.loadFavorites('x1'), query.loadFavorites('x1')]);
    const [first, second] = await Promise.all([query.workspace('/x1'), query.workspace('/x1')]);
    expect(first).toBe(second); expect(f.openWorkspace).toHaveBeenCalledOnce(); expect(f.navigation).toHaveBeenCalledOnce();
    expect(f.listFolders).toHaveBeenCalledOnce(); expect(f.list).toHaveBeenCalledOnce();
    await query.close(); expect(f.dispose).toHaveBeenCalledOnce();
    const next = new BrowserReadContext(f.repository, f.projects, '/folder:x1');
    await next.navigation(); expect(f.navigation).toHaveBeenCalledTimes(2); await next.close();
});
it('waits for acquired workspaces and releases all of them when another acquisition fails', async () => {
    const f = fixture(), query = new BrowserReadContext(f.repository, f.projects, '/folder:x1');
    f.openWorkspace.mockRejectedValueOnce(new Error('offline'));
    await expect(query.workspace('/offline')).rejects.toThrow('offline');
    await query.workspace('/x1'); await query.close(); expect(f.dispose).toHaveBeenCalledOnce();
    await expect(query.workspace('/late')).rejects.toMatchObject({code: 'EACCES'});
});
it('reports cleanup errors after attempting every release', async () => {
    const f = fixture(), query = new BrowserReadContext(f.repository, f.projects, '/folder:x1');
    await query.workspace('/one'); await query.workspace('/two'); f.dispose.mockRejectedValueOnce(new Error('release failed'));
    await expect(query.close()).rejects.toThrow('Browser query workspace cleanup failed'); expect(f.dispose).toHaveBeenCalledTimes(2);
});
