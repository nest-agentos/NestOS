interface Memory {entryId: string; namespaceId: string; content: string; contentHash: string}
interface Policy {readScopes: string[]; retrievalLimit?: number}

/** A session binding and the agent's explicit Dream read scope are both required. */
export async function includeDreamMemory(ordinary: Memory[], twin: Memory[], policy: Policy | undefined, sessionId: string,
    retrieve?: (sessionId: string, limit: number) => Promise<Memory[]>): Promise<Memory[]> {
    const limit = policy?.readScopes.includes('dream') ? Math.max(0, (policy.retrievalLimit ?? 20) - ordinary.length - twin.length) : 0;
    const dream = limit ? await retrieve?.(sessionId, limit) ?? [] : [];
    return [...ordinary, ...twin, ...dream];
}
