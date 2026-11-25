import type {Kernel} from '@nestos/durable-kernel';
import type {KernelAdaptersRuntimeOptions} from '@nestos/kernel-adapters';
import type {DreamHost} from './host';

/** Tool requests use the Kernel's persisted task identity and its Dream capability. */
export function dreamSearchTools(kernel: () => Kernel, host: () => DreamHost | undefined): NonNullable<KernelAdaptersRuntimeOptions['effectTools']> {
    return ['dream_search', 'dream_read'].map(id => {
        const search = id === 'dream_search';
        const description = search ? 'Search current authorized project memories.' : 'Read a current authorized project memory by reference.';
        const properties = search ? {query: {type: 'string', maxLength: 500}}
            : {namespaceId: {type: 'string'}, entryId: {type: 'string'}};
        return {meta: {id, name: id, description, sideEffect: 'none', timeoutMs: 30000, type: 'builtin', enabled: true},
            definition: {type: 'function', function: {name: id, description, parameters: {type: 'object', properties,
                additionalProperties: false, required: search ? ['query'] : ['namespaceId', 'entryId']}}},
            invoke: async (args, context) => {
                context.abortSignal.throwIfAborted();
                const task = await kernel().task(context.sessionId, context.taskId);
                const input = task.input as {memoryPolicy?: {readScopes: string[]}; allowedToolIds?: string[]};
                if (task.program.kind !== 'llm.agent' || !input.memoryPolicy?.readScopes.includes('dream')
                    || !input.allowedToolIds?.includes(id) || ['succeeded', 'failed', 'cancelled'].includes(task.status))
                    throw new Error('DREAM_AUTHORIZATION_DENIED');
                const dream = host(); if (!dream) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
                if (search && typeof args.query !== 'string' || !search && (typeof args.entryId !== 'string' || typeof args.namespaceId !== 'string'))
                    throw new Error('DREAM_SEARCH_INVALID');
                const items = await dream.searchSessionMemory(context.sessionId, search ? args.query as string : '',
                    search ? undefined : args.entryId as string, search ? undefined : args.namespaceId as string);
                context.abortSignal.throwIfAborted();
                return JSON.stringify(search ? items.map(({entryId, namespaceId}) => ({entryId, namespaceId})) : items[0] ?? null);
            }};
    });
}
