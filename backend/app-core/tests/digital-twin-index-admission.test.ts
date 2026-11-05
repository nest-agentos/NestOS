import {expect, it, vi} from 'vitest';
import {TwinSourceIndex} from '../src/digital-twin/source-index';
it('does not discover remote content when no configured plan or retained managed source needs it', async () => {
    const list = vi.fn(async () => []), discover = vi.fn(async () => {throw Error('UNNECESSARY_DISCOVERY');});
    const index = new TwinSourceIndex({list} as never, {reader: {discover}} as never);
    await index.sync(); expect(discover).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledTimes(2);
});
it('does not read or start discovery after the owner stops', async () => {
    const list = vi.fn(), discover = vi.fn(), index = new TwinSourceIndex({list} as never, {reader: {discover}} as never, () => false);
    await index.sync(); expect(list).not.toHaveBeenCalled(); expect(discover).not.toHaveBeenCalled();
});
it('discards interrupted discovery before missing-source or state updates', async () => {
    let active = true;
    const source = {id: 'retained', data: {managed: true, resource: {projectId: 'p', kind: 'file'}}};
    const list = vi.fn(async family => family === 'source' ? [source] : []), get = vi.fn(), save = vi.fn();
    const discover = vi.fn(async predicate => {
        expect(predicate()).toBe(true); active = false;
        return {resources: [], projects: [], completeScopes: [], errors: []};
    });
    await new TwinSourceIndex({list, get, save} as never, {reader: {discover}} as never, () => active).sync();
    expect(discover).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
