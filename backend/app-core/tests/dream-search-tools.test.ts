import {expect, it, vi} from 'vitest';
import {dreamSearchTools} from '../src/dream/search-tools';

it('uses the persisted agent task capability and forwards its session identity', async () => {
    const searchSessionMemory = vi.fn(async () => [{namespaceId: 'dream:p:d', entryId: 'm', content: 'private', contentHash: 'hash'}]);
    const task = vi.fn(async () => ({program: {kind: 'llm.agent'}, status: 'running', input: {
        allowedToolIds: ['dream_search', 'dream_read'], memoryPolicy: {readScopes: ['dream']}}}));
    const tools = dreamSearchTools(() => ({task}) as never, () => ({searchSessionMemory}) as never);
    const context = {sessionId: 's', taskId: 't', abortSignal: new AbortController().signal} as never;
    expect(JSON.parse(await tools[0].invoke({query: 'rule'}, context))).toEqual([{namespaceId: 'dream:p:d', entryId: 'm'}]);
    expect(searchSessionMemory).toHaveBeenCalledWith('s', 'rule', undefined, undefined);
    expect(JSON.parse(await tools[1].invoke({namespaceId: 'dream:p:d', entryId: 'm'}, context))).toMatchObject({content: 'private'});
    task.mockResolvedValueOnce({program: {kind: 'llm.agent'}, status: 'running', input: {allowedToolIds: ['dream_search'], memoryPolicy: {readScopes: []}}});
    await expect(tools[0].invoke({query: 'rule'}, context)).rejects.toThrow('DREAM_AUTHORIZATION_DENIED');
    expect(searchSessionMemory).toHaveBeenCalledTimes(2);
});
