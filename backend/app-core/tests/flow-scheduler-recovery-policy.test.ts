import {afterEach, expect, it, vi} from 'vitest';
import {FlowCommand} from '@nestos/llm-flow/contracts';
import {recoverFlowSchedulers} from '../src/runtime/flow-scheduler-recovery';

afterEach(() => vi.useRealTimers());
function fixture() {
    const root = {id: 'root', sessionPaused: false, program: {kind: 'flow.aggregate'}, labels: {kind: 'flow-root'}, status: 'waiting', state: {awaitingSchedule: true}};
    const kernel = {listRecoveryTasks: vi.fn(async () => [{sessionId: 's', taskId: 'root'}]), task: vi.fn(async () => root)};
    return {root, kernel};
}
it('waits out an existing scheduler lease and retries the same root without replaying input', async () => {
    vi.useFakeTimers(); const f = fixture();
    const execute = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Owned'), {code: 'FLOW_SCHEDULER_BUSY'})).mockResolvedValue({taskId: 'root'});
    const close = await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => true);
    expect(execute).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([command, input]) => command === FlowCommand.RunResume && input.taskId === 'root' && input.sessionId === 's')).toBe(true);
    close(); expect(vi.getTimerCount()).toBe(0);
});
it('does not take read-only Sessions, resume completed roots, or retry after host disposal', async () => {
    vi.useFakeTimers(); const f = fixture(), execute = vi.fn().mockRejectedValue(Object.assign(new Error('Owned'), {code: 'FLOW_SCHEDULER_BUSY'}));
    (await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => false))(); expect(execute).not.toHaveBeenCalled();
    f.root.status = 'succeeded'; (await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => true))(); expect(execute).not.toHaveBeenCalled();
    f.root.status = 'waiting'; const close = await recoverFlowSchedulers(f.kernel as never, {execute} as never, async () => true);
    close(); await vi.advanceTimersByTimeAsync(60000); expect(execute).toHaveBeenCalledTimes(1);
});
it('waits for the Session writer lease before reattaching its original Flow root', async () => {
    vi.useFakeTimers(); const f = fixture(), execute = vi.fn(async () => ({taskId: 'root'}));
    const writable = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const close = await recoverFlowSchedulers(f.kernel as never, {execute} as never, writable);
    expect(execute).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledWith(FlowCommand.RunResume, {sessionId: 's', taskId: 'root'});
    close(); expect(vi.getTimerCount()).toBe(0);
});

it('does not resume a paused Session or inspect historical tasks for an empty recovery index', async () => {
    const f = fixture(), execute = vi.fn(), writable = vi.fn(async () => true);
    f.root.sessionPaused = true;
    (await recoverFlowSchedulers(f.kernel as never, {execute} as never, writable))();
    expect(execute).not.toHaveBeenCalled(); expect(writable).not.toHaveBeenCalled();
    Object.assign(f.root, {sessionPaused: false, status: 'created', ownedBy: {sessionId: 'caller', taskId: 'caller'}});
    (await recoverFlowSchedulers(f.kernel as never, {execute} as never, writable))();
    expect(execute).not.toHaveBeenCalled(); expect(writable).not.toHaveBeenCalled();
    f.kernel.listRecoveryTasks.mockResolvedValueOnce([]); f.kernel.task.mockClear();
    (await recoverFlowSchedulers(f.kernel as never, {execute} as never, writable))();
    expect(f.kernel.task).not.toHaveBeenCalled();
});

it('bounds cold scans and waits for every accepted scan before returning the cleanup', async () => {
    let active = 0, peak = 0, completed = 0;
    const execute = vi.fn(), releases: Array<() => void> = [];
    const kernel = {listRecoveryTasks: vi.fn(async () => Array.from({length: 19}, (_, i) => ({sessionId: String(i), taskId: 'done'}))), task: vi.fn(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise<void>(resolve => releases.push(resolve));
        active--; completed++; return {status: 'succeeded', program: {kind: 'flow.aggregate'}, labels: {kind: 'flow-root'}};
    })};
    let settled = false;
    const ready = recoverFlowSchedulers(kernel as never, {execute} as never, async () => true).then(close => {settled = true; return close;});
    for (const expected of [8, 8, 3]) {
        await vi.waitFor(() => expect(releases).toHaveLength(expected));
        expect(settled).toBe(false); releases.splice(0).forEach(resolve => resolve());
    }
    (await ready)(); expect(completed).toBe(19); expect(peak).toBe(8); expect(execute).not.toHaveBeenCalled();
});

it('reports a failed scan separately and continues restoring other Sessions', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {}), execute = vi.fn(async () => ({}));
    const f = fixture();
    const kernel = {listRecoveryTasks: vi.fn(async () => [{sessionId: 'bad', taskId: 'root'}, {sessionId: 'good', taskId: 'root'}]),
        task: vi.fn(async (id: string) => {
            if (id === 'bad') throw Object.assign(new Error('private storage detail'), {code: 'STORAGE_CORRUPT'});
            return f.root;
        })};
    try {
        (await recoverFlowSchedulers(kernel as never, {execute} as never, async () => true))();
        expect(execute).toHaveBeenCalledWith(FlowCommand.RunResume, {sessionId: 'good', taskId: 'root'});
        expect(info).toHaveBeenCalledWith('[FlowRecovery]', expect.objectContaining({result: 'partial', failureCount: 1, candidateCount: 2}));
        expect(JSON.stringify(info.mock.calls)).not.toContain('private storage detail');
    } finally {info.mockRestore();}
});
