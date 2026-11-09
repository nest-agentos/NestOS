import {expect, it, vi} from 'vitest';
import {inspectQueuedExecution} from '../src/session/instruction-execution-control';

function fixture() {
    const item = {id: 'original', createdAt: 10, invocation: {invocationId: 'invocation'}};
    const round = {id: item.id, sessionId: 's', executions: [{role: 'primary', taskId: 'task', invocation: item.invocation}]};
    const task = {id: 'task', sessionId: 's', status: 'waiting', control: {epoch: 4}, labels: {roundId: item.id, invocationId: 'invocation'},
        effects: {harness: {status: 'indeterminate', error: {code: 'CONTEXT_OPERATION_CONFLICT'}}}};
    let frozen: unknown, receipt: unknown;
    const kernel = {task: vi.fn(async () => task), sessionActivity: vi.fn(async () => ({lastActivityAt: 20})),
        inspectSession: async () => ({getShared: async () => frozen}),
        openSession: async () => ({setShared: vi.fn(async (_key, value) => frozen = {value})}),
        readTaskCancellationReceipt: vi.fn(async () => receipt),
        readTaskTreeCancellationReceipt: vi.fn(async () => undefined),
        cancelRemainingTaskTree: vi.fn(async () => {}),
        listSessionTasks: vi.fn(async () => []),
        cancel: vi.fn(async () => {receipt = {requestId: 'queue-stop-original'};}),
    };
    const repository = {readDocument: vi.fn(async () => JSON.stringify(round))};
    return {task, kernel, run: (stop = false) => inspectQueuedExecution(kernel as never, repository as never, 's', item as never, stop)};
}
it('reports exact blocked evidence without submitting, cancelling, or altering history', async () => {
    const f = fixture(); expect(await f.run()).toEqual({lastProgressAt: 20, code: 'CONTEXT_OPERATION_CONFLICT'});
    expect(f.kernel.cancel).not.toHaveBeenCalled();
});
it('uses one durable cancellation identity and keeps unconfirmed cleanup blocked', async () => {
    const f = fixture(); expect(await f.run(true)).toMatchObject({stopping: true});
    expect(f.kernel.cancel).toHaveBeenCalledWith('s', 'task', expect.any(String), {requestId: 'queue-stop-original', expectedEpoch: 4});
    f.task.control.epoch = 5; await f.run(true); expect(f.kernel.cancel).toHaveBeenCalledOnce();
});
it('preserves the original control fence when the cancellation response is lost', async () => {
    const f = fixture(); f.kernel.cancel.mockRejectedValueOnce(new Error('Response lost'));
    await expect(f.run(true)).rejects.toThrow('Response lost'); f.task.control.epoch = 7;
    await f.run(true); expect(f.kernel.cancel.mock.calls[1][3]).toMatchObject({expectedEpoch: 4});
});
it('rejects changed execution ownership before cancellation', async () => {
    const f = fixture(); f.task.labels.invocationId = 'other';
    await expect(f.run(true)).rejects.toMatchObject({code: 'QUEUE_HISTORY_EXECUTION_CONFLICT'});
    expect(f.kernel.cancel).not.toHaveBeenCalled();
});

it('can stop remaining children of a terminal original without changing its successful result', async () => {
    const f = fixture(); Object.assign(f.task, {exit: {status: 'succeeded'}, effects: {}});
    await f.run(true);
    expect(f.kernel.cancelRemainingTaskTree).toHaveBeenCalledWith('s', 'task', expect.objectContaining({requestId: 'queue-stop-original', expectedEpoch: 4}));
    expect(f.kernel.cancel).not.toHaveBeenCalled(); expect(f.task).toMatchObject({exit: {status: 'succeeded'}});
});
