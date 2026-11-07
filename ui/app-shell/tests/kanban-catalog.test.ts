import {expect, it, vi} from 'vitest';
import type {KanbanClient} from '@nestos/kanban/contracts';
import {shareKanbanCatalog} from '../src/kanban/catalog';

it('shares only concurrent catalog reads and retries after failures', async () => {
    let finish!: (boards: []) => void;
    const catalog = vi.fn(() => new Promise<[]>(resolve => {finish = resolve;}));
    const client = shareKanbanCatalog({catalog} as unknown as KanbanClient)!;
    const first = client.catalog(), second = client.catalog();
    expect(first).toBe(second); await Promise.resolve(); expect(catalog).toHaveBeenCalledTimes(1);
    finish([]); await first;
    catalog.mockRejectedValueOnce(Object.assign(new Error('denied'), {code:'FORBIDDEN'}));
    await expect(client.catalog()).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(catalog).toHaveBeenCalledTimes(2);
    catalog.mockResolvedValueOnce([]); await expect(client.catalog()).resolves.toEqual([]);
    expect(catalog).toHaveBeenCalledTimes(3);
});

it('preserves the original receiver for client methods and getters', async () => {
    class Client {
        #actor = {kind:'human' as const,id:'owner'};
        async catalog() {return [];}
        async currentPrincipal() {return this.#actor;}
        get owner() {return this.#actor.id;}
    }
    const client = shareKanbanCatalog(new Client() as unknown as KanbanClient)!;
    expect(await client.currentPrincipal()).toEqual({kind:'human',id:'owner'});
    expect(Reflect.get(client,'owner')).toBe('owner');
    expect(shareKanbanCatalog()).toBeUndefined();
});
