import {expect, it, vi} from 'vitest';
import {conversationLifetime} from '../src/projects/conversation-lifetime';

it('shares release across failed editor initialization and outer cleanup, preserving the read error', async () => {
    const failure = Object.assign(new Error('History read failed'), {code: 'EIO'});
    let retired = false;
    const close = vi.fn(async () => {if (retired) throw new Error('Capability was released'); retired = true;});
    const source = {value: 7, close, read() {expect(this).toBe(source); throw failure;}};
    const controls = conversationLifetime(source);
    const initialize = async () => {try {controls.read();} catch (error) {await controls.close(); throw error;}};
    const open = async () => {try {await initialize();} catch (error) {await controls.close(); throw error;}};
    await expect(open()).rejects.toBe(failure);
    await controls.close(); expect(close).toHaveBeenCalledTimes(1);
    expect(controls.value).toBe(7);
});
it('retains a failed release result without sending another request', async () => {
    const failure = new Error('Transport closed');
    const close = vi.fn(async () => {throw failure;});
    const controls = conversationLifetime({close});
    const first = controls.close(), second = controls.close();
    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(controls.close()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
});
