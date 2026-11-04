import type { Binding, Coordinator, StateStore, SyncState } from '@itookit/vfs-sync';
export const binding: Binding = { bindingId: 'b', bindingRevision: '1', locatorRevision: '1', policyRevision: '1', scopeRevision: '1',
    state: 'active', authorityId: 'a', namespaceId: 'personal', historyEpoch: 'e', projectId: 'p', localProjectId: 'local',
    replicaId: 'r', sourceId: 'idb', root: '/workspace', datasetId: 'files', direction: 'both' };
export function initialState(): SyncState { return { schemaVersion: 1, binding: { ...binding }, nextSeq: '1', baseline: [], history: [] }; }
export class MemoryState implements StateStore {
    constructor(public state = initialState()) {}
    async read() { return structuredClone(this.state); }
    async update(change: (s: SyncState) => SyncState) { this.state = change(await this.read()); return this.read(); }
}
export class SerialCoordinator implements Coordinator {
    private readonly tails = new Map<string, Promise<unknown>>();
    async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
        const prior = this.tails.get(key) ?? Promise.resolve();
        const result = prior.catch(() => {}).then(action); this.tails.set(key, result);
        try { return await result; } finally { if (this.tails.get(key) === result) this.tails.delete(key); }
    }
}
