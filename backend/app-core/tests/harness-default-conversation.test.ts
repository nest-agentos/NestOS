import {expect, it, vi} from 'vitest';
import {sha256HexSync} from '@nestos/common';
import {canonical} from '../src/projects/harness-connection-policy';
import {createDefaultHarnessConversationResolver} from '../src/projects/harness-default-conversation';
import {context} from './harness-context-fixture';
import {request} from './harness-execution-fixture';
const catalog = vi.hoisted(() => ({bindings: {} as Record<string, unknown>}));
vi.mock('../src/projects/harness-context-catalog', () => ({readContextCatalog: async () => ({value: {bindings: catalog.bindings}})}));
function fixture() {
    const binding = {...context, id: 'original', branchId: 'main', connectionId: request.connection.id,
        connectionRef: sha256HexSync(canonical(request.connection)), revision: 7, generation: 1, validity: 'valid', nativeRef: {sessionId: 'native'}, activeOperation: undefined};
    const bindings: Record<string, unknown> = {original: binding};
    catalog.bindings = bindings;
    const kernel = {task: async () => {throw Error('Unexpected retained task read');}, inspectSession: async () => ({getShared: async () => ({version: 1, value: {version: 1, sessionId: 's', bindings}})})};
    return {binding, bindings, kernel, run: () => createDefaultHarnessConversationResolver(kernel as never)('s', context, request.connection)};
}
it('resumes the exact compatible branch context with its current revision', async () => {
    const f = fixture(); expect(await f.run()).toMatchObject({selection: {mode: 'resume', bindingId: 'original', expectedBindingRevision: 7, expectedGeneration: 1}});
});
it('never creates another Session when existing context is busy or incompatible', async () => {
    const f = fixture(); f.binding.activeOperation = {} as never;
    await expect(f.run()).rejects.toMatchObject({code: 'CONTEXT_NATIVE_BUSY'});
    f.binding.activeOperation = undefined; f.binding.policyRef = 'changed';
    await expect(f.run()).rejects.toMatchObject({code: 'CONTEXT_SELECTION_REQUIRED'});
});
it('does not choose the first of multiple compatible contexts', async () => {
    const f = fixture(); f.bindings.other = {...f.binding, id: 'other'};
    await expect(f.run()).rejects.toMatchObject({code: 'CONTEXT_SELECTION_REQUIRED'});
});
it('ignores failed creations without native identity and keeps unrelated branches separate', async () => {
    const f = fixture(); f.bindings.failed = {...f.binding, id: 'failed', validity: 'invalid', nativeRef: undefined};
    expect(await f.run()).toMatchObject({selection: {bindingId: 'original'}});
    f.binding.branchId = 'other'; expect(await f.run()).toBeUndefined();
});

it('retains the admitted connection after mapping metadata changes, and rejects a different directory', async () => {
    const f = fixture(), frozen = {...request.connection, revision: 9, name: 'Original snapshot'};
    Object.assign(f.binding, {connectionRef: sha256HexSync(canonical(frozen)), lastOperation: {executionRef: {taskId: 'old', effectId: 'harness'}}});
    f.kernel.task = async () => ({sessionId: 's', effects: {harness: {request: {request: {connection: frozen, context}}}}}) as never;
    expect(await f.run()).toMatchObject({connection: frozen, selection: {bindingId: 'original'}});
    frozen.directory = 'different'; f.binding.connectionRef = sha256HexSync(canonical(frozen));
    await expect(f.run()).rejects.toMatchObject({code: 'CONTEXT_SELECTION_REQUIRED'});
});
