// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {getLogger} from '@nestos/common';
import {FlowCommand, type FlowRunSummary} from '@nestos/llm-flow/contracts';
import {openRunPicker} from '../../llm-ui-adapter/src/components/dag/RunPicker';

const run: FlowRunSummary = {taskId: 'task', sessionId: 'session/<tag>', name: '<saved run>', status: 'succeeded', createdAt: 1700000000000,
    inputPreview: {text: '<img src=x onerror=alert(1)>', truncated: false}, outputPreview: {text: 'result '.repeat(80), truncated: true}};
beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value() {this.open = true;}});
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value() {this.dispatchEvent(new Event('close'));}});
});
afterEach(() => {document.querySelectorAll('dialog').forEach(dialog => dialog.remove()); vi.restoreAllMocks();});

it('renders linked sessions, semantic creation times and escaped input/output previews in one list query', async () => {
    const execute = vi.fn().mockResolvedValue([run]), select = vi.fn().mockResolvedValue(undefined);
    openRunPicker({execute} as never, select);
    await vi.waitFor(() => expect(document.querySelector('.dag-run-list__item')).not.toBeNull());
    expect(execute).toHaveBeenCalledExactlyOnceWith(FlowCommand.RunList, {});
    expect(document.querySelector('time')?.dateTime).toBe(new Date(run.createdAt).toISOString());
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.dag-run-list__previews')?.textContent).toContain(run.inputPreview!.text);
    expect(document.querySelector('.dag-run-list__previews')?.textContent).toContain('摘要已截断');
    const link = document.querySelector<HTMLAnchorElement>('[data-run-session]')!;
    expect(link.getAttribute('href')).toBe('#/chat/session%2F%3Ctag%3E');
    link.dispatchEvent(new MouseEvent('click', {bubbles: true, ctrlKey: true}));
    expect(document.querySelector('dialog')).not.toBeNull();
    link.click(); expect(document.querySelector('dialog')).toBeNull(); expect(select).not.toHaveBeenCalled();
});

it('keeps a failed details action retryable without leaking preview contents into diagnostics', async () => {
    const select = vi.fn().mockRejectedValueOnce(new Error('Run storage unavailable')).mockResolvedValue(undefined);
    openRunPicker({execute: vi.fn().mockResolvedValue([run])} as never, select);
    await vi.waitFor(() => expect(document.querySelector('[data-run-index]')).not.toBeNull());
    const button = document.querySelector<HTMLButtonElement>('[data-run-index]')!;
    button.click(); button.click();
    await vi.waitFor(() => expect(document.querySelector('[data-run-error]')?.textContent).toContain('Run storage unavailable'));
    expect(select).toHaveBeenCalledOnce(); expect(button.disabled).toBe(false);
    const entries = getLogger().query({modules: ['flow-run-picker']});
    expect(entries.some(entry => (entry.data as {code?: string})?.code === 'FLOW_RUN_OPEN_FAILED')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(run.inputPreview!.text);
    button.click(); await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    expect(select).toHaveBeenLastCalledWith(run);
});

it('shows empty fields and ignores a list result that arrives after closing', async () => {
    const legacy = {...run, inputPreview: undefined, outputPreview: undefined};
    openRunPicker({execute: vi.fn().mockResolvedValue([legacy])} as never, vi.fn());
    await vi.waitFor(() => expect(document.querySelector('.dag-run-list__previews')?.textContent).toContain('暂无输入参数'));
    expect(document.querySelector('.dag-run-list__previews')?.textContent).toContain('暂无输出');
    document.querySelector('dialog')!.close();
    let finish!: (runs: FlowRunSummary[]) => void;
    const pending = new Promise<FlowRunSummary[]>(resolve => {finish = resolve;});
    openRunPicker({execute: vi.fn().mockReturnValue(pending)} as never, vi.fn());
    document.querySelector('dialog')!.close(); finish([run]); await pending;
    expect(document.querySelector('dialog')).toBeNull();
});
