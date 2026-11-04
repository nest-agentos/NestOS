import type { SharedMemoryStore } from '@itookit/llm-session';
import type { MemoryPolicy } from '@itookit/llm-tasks/contracts';
import type { AgentConfig } from './types';

/** Translate CLI field names without sharing mutable policy arrays with the workflow. */
export function memoryPolicyForAgent(agent: AgentConfig): MemoryPolicy | undefined {
    const policy = agent.memory_policy;
    if (!policy) return undefined;
    return {
        ...(policy.shared_memory ? { sharedMemory: { ...policy.shared_memory } } : {}),
        namespaceId: policy.namespace_id, readScopes: [...policy.read_scopes], writeScopes: [...policy.write_scopes],
        ...(policy.retrieval_limit !== undefined ? { retrievalLimit: policy.retrieval_limit } : {}),
        ...(policy.retention ? { retention: {
            ...(policy.retention.max_entries_per_scope !== undefined ? { maxEntriesPerScope: policy.retention.max_entries_per_scope } : {}),
            ...(policy.retention.before !== undefined ? { before: policy.retention.before } : {}),
        } } : {}),
    };
}

export async function grantRunMemory(store: SharedMemoryStore, agents: AgentConfig[], sessionId: string, ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
        const policies = agents.flatMap(agent => agent.memory_policy?.shared_memory?.id === id ? [agent.memory_policy] : []);
        if (!policies.length) throw new Error(`Shared Memory is not referenced by this run: ${id}`);
        const ref = policies[0].shared_memory!;
        const resource = await store.inspect(ref);
        if (policies.some(policy => policy.shared_memory!.incarnation !== ref.incarnation || policy.namespace_id !== resource.namespaceId)) {
            throw new Error('Shared Memory policies disagree about resource identity');
        }
        await store.grant(ref, sessionId, { readScopes: [...new Set(policies.flatMap(policy => policy.read_scopes))],
            writeScopes: [...new Set(policies.flatMap(policy => policy.write_scopes))] }, resource.revision);
    }
}
