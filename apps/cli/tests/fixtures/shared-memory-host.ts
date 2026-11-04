import { Kernel } from '@itookit/durable-kernel';
import { SessionMemoryProvider, SharedMemoryStore } from '@itookit/llm-session';
import { openProfileInspectionFs } from '../../src/runtime';

const [root, incarnation, phase, action] = process.argv.slice(2);
const host = await openProfileInspectionFs(root);
const base = host.fs.meta.seq!;
const seq = { transaction: base.transaction!.bind(base) };
const fs = Object.create(host.fs) as typeof host.fs;
Object.defineProperty(fs, 'meta', { value: { ...host.fs.meta, seq } });
const store = new SharedMemoryStore(fs); await store.init();
const kernel = new Kernel({ catalog: { fs: host.fs } }); await kernel.initialize();
const memory = new SessionMemoryProvider(kernel, store);
const policy = { namespaceId: 'notes', sharedMemory: { id: 'team', incarnation }, readScopes: ['project'], writeScopes: ['project'] };
const transaction = seq.transaction;
seq.transaction = operation => transaction(async tx => operation(new Proxy(tx, {
    get(target, property) {
        if (property !== 'setEntry') {
            const method = Reflect.get(target, property);
            return typeof method === 'function' ? method.bind(target) : method;
        }
        return async (path: string, key: string, value: string) => {
        await tx.setEntry(path, key, value);
        if ((phase === 'data' && key.startsWith('entries/')) || (phase === 'receipt' && key.startsWith('receipt/'))) {
            process.send?.({ phase }); await new Promise(() => {});
        }
        };
    },
})));
const options = { origin: { operationId: action, taskId: 'task', effectId: action } };
if (action === 'write') await memory.upsert('one', policy, { scope: 'project', entryId: 'note', content: 'written' }, options);
else if (action === 'remove') await memory.remove('one', policy, 'project', 'note', options);
else if (action === 'compact') {
    const source = (await memory.list('one', policy))[0];
    await memory.compact('one', policy, { scope: 'project', entryId: 'summary', content: 'short' },
        [{ entryId: source.entryId, revision: source.revision }], { ...options, model: 'test-model' });
}
else await memory.prune('one', policy, Number.MAX_SAFE_INTEGER);
process.send?.({ phase: 'committed' });
await new Promise(() => {});
