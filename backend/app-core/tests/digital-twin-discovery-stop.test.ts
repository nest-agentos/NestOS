import {expect, it, vi} from 'vitest';
import {TwinProjectCatalog} from '../src/digital-twin/project-catalog';
import {discoverWorkspaces} from '../src/digital-twin/workspace-catalog';
import {discoverHarness} from '../src/digital-twin/harness-reader';
import {scannerInputReader} from '../src/digital-twin/scanner-input';

const project = {path: '/p', name: 'P', project: {id: 'p'}};
const catalog = () => ({resources: [], projects: [], completeScopes: [], errors: []});
const directory = {type: 'directory', path: '/', name: '', metadata: {}, tags: []};

it('stops within directory discovery, releases the source, and can discover again', async () => {
    let active = true, stopping = true;
    const file = {type: 'file', path: '/a.md', name: 'a.md', metadata: {}, tags: [], version: 1};
    const getChildren = vi.fn(async () => {if (stopping) active = false; return [file];});
    const dispose = vi.fn(async () => {}), walkSummaries = vi.fn(async () => {});
    const fs = {driver: {getNode: async () => directory, getChildren}};
    const projects = {list: async () => [project, {...project, path: '/q'}], openFiles: vi.fn(async () => ({fs, dispose}))};
    const discovery = new TwinProjectCatalog(projects as never, {walkSummaries} as never);
    const interrupted = await discovery.discover(() => active);
    expect(interrupted.completeScopes).toEqual([]); expect(interrupted.resources).toEqual([]);
    expect(projects.openFiles).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
    expect(walkSummaries).not.toHaveBeenCalled();
    active = true; stopping = false;
    const resumed = await discovery.discover(() => active);
    expect(resumed.completeScopes).toContain('p/file'); expect(resumed.resources).toHaveLength(2);
});

it('yields to stop signals even when directory reads only resolve microtasks', async () => {
    let active = true;
    const getChildren = vi.fn(async () => {
        setTimeout(() => {active = false;}, 0);
        return Array.from({length: 1000}, (_, i) => ({...directory, name: `d${i}`, path: `/d${i}`}));
    });
    const dispose = vi.fn(async () => {});
    const projects = {list: async () => [project], openFiles: async () => ({fs: {driver: {getNode: async () => directory, getChildren}}, dispose})};
    const result = await new TwinProjectCatalog(projects as never, {} as never).discover(() => active);
    expect(getChildren).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledOnce();
    expect(result.completeScopes).toEqual([]);
});

it('does not mark a workspace complete or inspect later workspaces after stopping', async () => {
    let active = true;
    const getNode = vi.fn(async () => directory), getChildren = vi.fn(async () => {active = false; return [];});
    const result = catalog();
    await discoverWorkspaces({driver: {getNode, getChildren}} as never, result, () => active);
    expect(getNode).toHaveBeenCalledTimes(1); expect(result.completeScopes).toEqual([]);
});

it('stops remote pagination at the current page and closes its client', async () => {
    let active = true;
    const list = vi.fn(async () => {active = false; return {sessions: [], nextCursor: 'next'};});
    const close = vi.fn(async () => {});
    const client = {profiles: async () => ({profiles: [{id: 'codex', capabilities: {history: true}, projectRuntime: {}}]}), list, close};
    const projects = {remoteMounts: {list: () => [{at: '/', connectionId: 'c', serverProjectId: 'p'}], projectHarness: async () => client}};
    const result = catalog();
    await discoverHarness(projects as never, project as never, result, () => active);
    expect(list).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]).toEqual(['codex', {archived: false, cursor: undefined, limit: 100}, {timeoutMs: 5000}]);
    expect(result.completeScopes).toEqual([]);
});

it('forwards the stopping predicate through the scanner reader adapter', async () => {
    const active = () => false, discover = vi.fn(async () => catalog());
    const reader = scannerInputReader({} as never, {discover, sessions: async () => [], read: vi.fn()} as never);
    await reader.discover!(active); expect(discover).toHaveBeenCalledWith(active);
});
