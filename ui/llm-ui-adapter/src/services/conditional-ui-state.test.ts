import {expect, it, vi} from 'vitest';
import type {ConversationManifest, ConversationUIState} from '@nestos/llm-session/contracts';
import {SessionUIStateWriter} from './conditional-ui-state';

function fixture() {
    let current = {revision: 1, uiState: {scrollPosition: 0} as ConversationUIState};
    const snapshot = () => structuredClone(current);
    const repository = {
        getManifest: vi.fn(async () => snapshot() as ConversationManifest),
        compareAndSetUIState: vi.fn(async (_id: string, expected: number, patch: Partial<ConversationUIState>) => {
            if (expected !== current.revision) throw Object.assign(new Error('Version conflict'), {code: 'SESSION_UI_STATE_CONFLICT'});
            current = {revision: expected + 1, uiState: {...current.uiState, ...patch}};
            return snapshot();
        }),
    };
    const writer = new SessionUIStateWriter(repository, 'session');
    writer.seed(snapshot());
    const options = {unavailable: () => Error('Unavailable'), conflict: () => Error('Conflict'), report: vi.fn()};
    const save = (position: number) => writer.write(state => ({value: position,
        patch: state?.scrollPosition === position ? undefined : {scrollPosition: position}}), options);
    return {repository, save, snapshot};
}

it('serializes overlapping changes using the revisions returned by committed writes', async () => {
    const {repository, save, snapshot} = fixture();
    await Promise.all([save(10), save(20)]);
    expect(repository.getManifest).not.toHaveBeenCalled();
    expect(repository.compareAndSetUIState.mock.calls.map(([, revision]) => revision)).toEqual([1, 2]);
    expect(snapshot()).toEqual({revision: 3, uiState: {scrollPosition: 20}});
});

it('rereads on a stale revision, preserves sibling fields and verifies a cached no-op', async () => {
    const {repository, save, snapshot} = fixture();
    await repository.compareAndSetUIState('session', 1, {operationRecords: [{id: 'other-tab'}]});
    await save(10);
    expect(repository.getManifest).toHaveBeenCalledOnce();
    expect(snapshot().uiState).toEqual({scrollPosition: 10, operationRecords: [{id: 'other-tab'}]});
    await repository.compareAndSetUIState('session', 3, {scrollPosition: 20});
    await save(10);
    expect(repository.getManifest).toHaveBeenCalledTimes(2);
    expect(snapshot().uiState.scrollPosition).toBe(10);
});

it('confirms a lost write response by reading without sending the mutation again', async () => {
    const {repository, save} = fixture(), commit = repository.compareAndSetUIState.getMockImplementation()!;
    repository.compareAndSetUIState.mockImplementationOnce(async (...args) => {await commit(...args); throw Error('Reply lost');});
    await expect(save(10)).resolves.toBe(10);
    expect(repository.getManifest).toHaveBeenCalledOnce();
    expect(repository.compareAndSetUIState).toHaveBeenCalledOnce();
});
