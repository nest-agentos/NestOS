// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import type {ProjectService} from '@nestos/app-contracts/services';
import {sessionUrl, kanbanReferenceLink} from '../src/kanban/links';
it('uses stable execution and native Session routes and resolves the bound project instead of the current selection', async () => {
    const get = vi.fn(async () => ({path: '/x1'})), resolve = kanbanReferenceLink({get} as unknown as Pick<ProjectService, 'get'>);
    expect(sessionUrl('execution')).toContain('#/workbench/execution');
    expect(await resolve({system: 'nestos-execution-session', id: 'execution', revision: 'attempt'})).toMatchObject({href: sessionUrl('execution'), sessionId: 'execution'});
    const native = await resolve({system: 'nestos-native-session', id: 'native', revision: JSON.stringify({projectId: 'x1', profileId: 'codex', dispatchId: 'attempt'})});
    expect(get).toHaveBeenCalledWith('x1');
    expect(decodeURIComponent(native!.href.split('#/workbench/')[1])).toBe('/folder:x1/@harness/codex/native');
    expect(native!.sessionId).toBe('/folder:x1/@harness/codex/native');
    expect(await resolve({system: 'other', id: 'opaque'})).toBeUndefined();
    expect(await resolve({system: 'nestos-native-session', id: 'native', revision: 'INVALID'})).toBeUndefined();
});

it('links Dream decision evidence to the source task or decision on its own board', async () => {
    const get = vi.fn(), resolve = kanbanReferenceLink({get});
    const id = JSON.stringify(['source-board', 'original']);
    for (const kind of ['task', 'decision']) {
        const link = await resolve({system: 'nestos-dream-source-' + kind, id});
        const path = kind === 'task' ? '/board/source-board/original' : '/board/source-board/@record/original';
        expect(link?.href).toContain('#/kanban/' + encodeURIComponent(path));
    }
    expect(await resolve({system: 'nestos-dream-source-decision', id: 'invalid'})).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
});

it('builds all three task references from the authorized project projection', async () => {
    const get = vi.fn(), resolve = kanbanReferenceLink({get});
    const resources=[{reference:{system:'nestos-remote-project',id:'cx1'},label:'Cell Project',resourceId:'/folder:parent/folder:cx1'}];
    const scope={projectId:'cx1',directory:'work/tree',profileId:'codex'};
    const links=await Promise.all([
        resolve({system:'nestos-primary-project',id:'cx1'},resources),
        resolve({system:'nestos-work-directory',id:'work',revision:JSON.stringify(scope)},resources),
        resolve({system:'nestos-native-session',id:'native',revision:JSON.stringify(scope)},resources),
    ]);
    expect(links.map(link=>decodeURIComponent(link!.href.split('#/workbench/')[1]))).toEqual([
        '/folder:parent/folder:cx1/@files','/folder:parent/folder:cx1/@files/work/tree','/folder:parent/folder:cx1/@harness/codex/native',
    ]);
    expect(links[1]?.label).toBe('Cell Project · /workspace/work/tree');
    expect(get).not.toHaveBeenCalled();
});
