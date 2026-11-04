import { Kernel } from '@itookit/durable-kernel';
import { SessionMemoryProvider, SharedMemoryStore } from '@itookit/llm-session';
import { openProfileInspectionFs } from '../../src/runtime';

const [root, incarnation, sessionId, revision] = process.argv.slice(2);
const host = await openProfileInspectionFs(root);
const kernel = new Kernel({ catalog: { fs: host.fs } }); await kernel.initialize();
const store = new SharedMemoryStore(host.fs); await store.init();
const memory = new SessionMemoryProvider(kernel, store);
const policy = { namespaceId: 'notes', sharedMemory: { id: 'team', incarnation }, readScopes: ['project'], writeScopes: ['project'] };
const start = new Promise(resolve => process.once('message', resolve));
process.send?.({ phase: 'ready' }); await start;
try {
    await memory.upsert(sessionId, policy, { scope: 'project', entryId: 'contended', content: sessionId }, { expectedRevision: revision });
    process.send?.({ phase: 'written' });
} catch (error) {
    if (!(error instanceof Error) || !error.message.includes('changed')) throw error;
    process.send?.({ phase: 'conflict' });
} finally { await kernel.dispose(); await host.dispose(); process.disconnect?.(); }
