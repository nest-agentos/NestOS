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
