interface Memory {entryId: string; namespaceId: string; content: string; contentHash: string}
interface Policy {readScopes: string[]; retrievalLimit?: number}

/** A session binding and the agent's explicit Dream read scope are both required. */
export async function includeDreamMemory(ordinary: Memory[], twin: Memory[], policy: Policy | undefined, sessionId: string,
    retrieve?: (sessionId: string, limit: number, tokenBudget?: number) => Promise<Memory[]>, tokenBudget?: number): Promise<Memory[]> {
    const limit = policy?.readScopes.includes('dream') ? Math.max(0, (policy.retrievalLimit ?? 20) - ordinary.length - twin.length) : 0;
    const used = tokenBudget === undefined ? 0 : [...ordinary, ...twin].reduce((sum, entry) => sum
        + new TextEncoder().encode(`Memory (${entry.namespaceId}/${entry.entryId}):\n${entry.content}`).byteLength, 0);
    const remaining = tokenBudget === undefined ? undefined : Math.max(0, tokenBudget - used);
    const dream = limit ? await (remaining === undefined ? retrieve?.(sessionId, limit) : retrieve?.(sessionId, limit, remaining)) ?? [] : [];
    return [...ordinary, ...twin, ...dream];
}
