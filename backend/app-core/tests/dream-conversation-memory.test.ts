import {expect, it, vi} from 'vitest';
import {includeDreamMemory} from '../src/dream/conversation-memory';

it('requires the agent Dream scope and leaves only the remaining memory budget', async () => {
    const entry = {entryId: 'ordinary', namespaceId: 'agent', content: 'fact', contentHash: 'hash'};
    const dream = {...entry, entryId: 'dream'}, retrieve = vi.fn(async () => [dream]);
    expect(await includeDreamMemory([entry], [], undefined, 'session', retrieve)).toEqual([entry]);
    expect(await includeDreamMemory([entry], [], {readScopes: ['project'], retrievalLimit: 10}, 'session', retrieve)).toEqual([entry]);
    expect(await includeDreamMemory([entry], [], {readScopes: ['dream'], retrievalLimit: 1}, 'session', retrieve)).toEqual([entry]);
    expect(retrieve).not.toHaveBeenCalled();
    expect(await includeDreamMemory([entry], [], {readScopes: ['dream'], retrievalLimit: 2}, 'session', retrieve)).toEqual([entry, dream]);
    expect(retrieve).toHaveBeenCalledWith('session', 1);
});
