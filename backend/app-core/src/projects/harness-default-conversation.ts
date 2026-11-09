import {sha256HexSync} from '@nestos/common';
import type {Kernel} from '@nestos/durable-kernel';
import type {ContextBinding, HarnessConnectionSnapshot, HarnessContextRequest} from '@nestos/kernel-adapters/contracts';
import {readContextCatalog} from './harness-context-catalog';
import {canonical} from './harness-connection-policy';
import {executionError} from './harness-execution-journal';

/** Continue this Session's retained context and frozen connection policy, never pick another branch. */
export function createDefaultHarnessConversationResolver(kernel: Pick<Kernel, 'inspectSession' | 'task'>) {
    return async (sessionId: string, context: HarnessContextRequest, connection: HarnessConnectionSnapshot) => {
        const {value} = await readContextCatalog(kernel, sessionId);
        const retained = Object.values(value.bindings).filter(row => row.branchId === context.branchId && row.connectionId === connection.id && row.nativeRef);
        if (!retained.length) return;
        const fields = ['targetRef', 'scopeRef', 'policyRef', 'memoryPolicyRef'] as const;
        const candidates = retained.filter(row => fields.every(key => row[key] === context[key]));
        if (candidates.length !== 1 || candidates[0].validity !== 'valid') throw executionError('CONTEXT_SELECTION_REQUIRED');
        const binding = candidates[0];
        if (binding.activeOperation) throw executionError('CONTEXT_NATIVE_BUSY');
        const frozen = await retainedConnection(kernel, sessionId, binding, connection);
        return {selection: {mode: 'resume' as const, bindingId: binding.id, expectedBindingRevision: binding.revision, expectedGeneration: binding.generation}, connection: frozen};
    };
}
async function retainedConnection(kernel: Pick<Kernel, 'task'>, sessionId: string, binding: ContextBinding, current: HarnessConnectionSnapshot): Promise<HarnessConnectionSnapshot> {
    if (binding.connectionRef === sha256HexSync(canonical(current))) return current;
    const previous = binding.lastOperation?.executionRef;
    if (!previous) throw executionError('CONTEXT_SELECTION_REQUIRED');
    const task = await kernel.task(sessionId, previous.taskId);
    const request = task.effects[previous.effectId]?.request.request as {connection?: HarnessConnectionSnapshot; context?: HarnessContextRequest} | undefined;
    const frozen = request?.connection;
    if (task.sessionId !== sessionId || !frozen || binding.connectionRef !== sha256HexSync(canonical(frozen))
        || binding.workspaceRef !== request?.context?.workspaceRef || frozen.id !== current.id || frozen.projectId !== current.projectId
        || frozen.nodeConnectionId !== current.nodeConnectionId || frozen.profileId !== current.profileId || frozen.directory !== current.directory)
        throw executionError('CONTEXT_SELECTION_REQUIRED');
    return frozen;
}
