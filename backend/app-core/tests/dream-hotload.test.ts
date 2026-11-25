import {expect, it} from 'vitest';
import {assembleDreamHotload} from '../src/dream/hotload';
import {includeDreamMemory} from '../src/dream/conversation-memory';
import {createContextAssembler, type ContextPlan} from '@nestos/llm-context';

const namespaceId = 'dream:owner:dream';
const items = [
    {namespaceId, budget: 5000, topic: {id: 'topic', title: 'Architecture', content: 'Long topic body', kind: 'topic' as const, priority: 100, updatedAt: 300}},
    {namespaceId, budget: 5000, topic: {id: 'legacy', content: 'Legacy rule'}},
    {namespaceId, budget: 5000, topic: {id: 'newer', title: 'Deployment', content: 'Use blue-green.', kind: 'constraint' as const, priority: 5, updatedAt: 200}},
    {namespaceId, budget: 5000, topic: {id: 'older', content: 'Use tests.', kind: 'constraint' as const, priority: 5, updatedAt: 100}},
    {namespaceId, budget: 5000, topic: {id: 'higher', content: 'Never expose secrets.', kind: 'constraint' as const, priority: 10, updatedAt: 1}},
];
const bytes = (rows: ReturnType<typeof assembleDreamHotload>) => rows.reduce((total, row) => total
    + new TextEncoder().encode(`Memory (${row.namespaceId}/${row.entryId}):\n${row.content}`).byteLength, 0);

it('orders constraints by explicit priority, recency and ID before topic pointers, with stable legacy defaults', () => {
    const result = assembleDreamHotload('owner', items, 20, 1500);
    expect(result.map(row => row.entryId)).toEqual(['higher', 'newer', 'older', 'legacy', 'topic']);
    expect(result[1].content).toBe('Deployment\nUse blue-green.');
    expect(result[4].content).toContain('Architecture'); expect(result[4].content).toContain('dream_read');
    expect(result[4].content).not.toContain('Long topic body');
    expect(assembleDreamHotload('owner', [...items].reverse(), 20, 1500)).toEqual(result);
    expect(bytes(result)).toBeLessThanOrEqual(1500);
    const tied = ['z', 'a'].map(id => ({namespaceId, budget: 1500,
        topic: {id, content: id, kind: 'constraint' as const, priority: 4, updatedAt: 10}}));
    expect(assembleDreamHotload('owner', tied, 20, 1500).map(item => item.entryId)).toEqual(['a', 'z']);
});

it('honors low, high and project limits on the final full injected text and reserves a search hint', () => {
    const low = assembleDreamHotload('owner', items, 20, 150);
    expect(bytes(low)).toBeLessThanOrEqual(150); expect(low.at(-1)?.entryId).toBe('retrieval-hint');
    expect(assembleDreamHotload('owner', items, 20, 1)).toEqual([]);
    const capped = assembleDreamHotload('owner', items.map(item => ({...item, budget: 120})), 20, 5000);
    expect(bytes(capped)).toBeLessThanOrEqual(5000); expect(capped.at(-1)?.entryId).toBe('retrieval-hint');
    const high = assembleDreamHotload('owner', items, 20, 5000);
    expect(high).toHaveLength(5); expect(bytes(high)).toBeGreaterThan(bytes(low));
    expect(assembleDreamHotload('owner', items, 20, 5000)).toEqual(high);
});

it('subtracts already-selected memory from the remaining context before Dream retrieval', async () => {
    const ordinary = [{entryId: 'one', namespaceId: 'agent', content: 'ordinary', contentHash: 'hash'}];
    let supplied = -1;
    await includeDreamMemory(ordinary, [], {readScopes: ['dream'], retrievalLimit: 2}, 'session', async (_id, _limit, budget) => {
        supplied = budget ?? -1; return [];
    }, 100);
    expect(supplied).toBe(100 - new TextEncoder().encode('Memory (agent/one):\nordinary').byteLength);
});

it('limits the final injected messages by the context left after current user and ordinary memory', async () => {
    const ordinary = [{entryId: 'one', namespaceId: 'agent', content: 'ordinary', contentHash: 'hash'}];
    const assembler = createContextAssembler({profileStore: {getProfile: async () => null}, readRound: async () => null,
        retrieveMemory: async plan => includeDreamMemory(ordinary, [], {readScopes: ['dream'], retrievalLimit: 20}, 'session',
            async (_session, limit, budget) => assembleDreamHotload('owner', items, limit, budget ?? 1500), plan.tokenBudget)});
    const plan: ContextPlan = {branchRef: 'main', branchHead: null, profile: {id: '', revision: 1}, tokenBudget: 500,
        explicitInputs: [], pendingUserMessage: {role: 'user', content: 'Current user request'}};
    const first = await assembler.assemble(plan, 'run1', {id: 'agent', version: '1'}, 'System policy', undefined, {persist: false});
    const second = await assembler.assemble(plan, 'run2', {id: 'agent', version: '1'}, 'System policy', undefined, {persist: false});
    const count = first.messages.reduce((sum, message) => sum + new TextEncoder().encode(String(message.content)).byteLength, 0);
    expect(count).toBeLessThanOrEqual(500);
    expect(first.messages).toEqual(second.messages);
    expect(first.messages.some(message => String(message.content).includes('Never expose secrets.'))).toBe(true);
    expect(first.messages.at(-1)?.content).toBe('Current user request');
});
