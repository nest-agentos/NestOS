import {expect, it, vi} from 'vitest';
import {FSError} from '@nestos/vfs-core';
import type {NativeSessionRecoveryPort, ProjectConversationPort, ProjectConversationSnapshot} from '@nestos/app-contracts/services';
import {bindRecovery} from '../src/client/session-recovery';
const edit = {action: 'recover' as const, id: 'old', expectedRevision: 7};
function fixture(pending = new Map<string, string>()) {
    let expired = false;
    const before = {sessionId: 'native', active: true, instructionQueue: {revision: 7, items: [{id: 'old'}]}, messages: []} as unknown as ProjectConversationSnapshot;
    const source = {snapshot: vi.fn(() => {if (expired) throw new FSError('ECAPABILITY', 'VIEW_NOT_FOUND'); return before;}),
        read: vi.fn(async () => before), editInstructionQueue: vi.fn(async () => before)} as unknown as ProjectConversationPort;
    const state = {sessionId: 'native', active: false, instructionQueue: {revision: 8, items: []}};
    const recover = vi.fn(async (request: any) => ({operationId: request.operationId, outcome: 'recovered', duplicate: false, state}));
    const service = {recover} as unknown as NativeSessionRecoveryPort;
    const port = bindRecovery(source, 'p', 'codex', service, pending);
    return {source, service, recover, port, expire: () => {expired = true;}};
}
it('recovers through the business API when the cached browser view has expired', async () => {
    const f = fixture(); f.port.snapshot(); f.expire();
    expect(await f.port.editInstructionQueue!(edit)).toMatchObject({instructionQueue: {revision: 8}});
    expect(f.source.editInstructionQueue).not.toHaveBeenCalled(); expect(f.source.read).not.toHaveBeenCalled();
    expect(f.port.snapshot().instructionQueue?.revision).toBe(8);
});
it('retains one operation ID through unknown failures and browser view reconstruction', async () => {
    const pending = new Map<string, string>(), f = fixture(pending); f.port.snapshot();
    f.recover.mockRejectedValueOnce(Object.assign(new FSError('EIO', 'connection lost'), {outcome: 'unknown'}));
    await expect(f.port.editInstructionQueue!(edit)).rejects.toMatchObject({outcome: 'unknown'});
    const recreated = bindRecovery(f.source, 'p', 'codex', f.service, pending); recreated.snapshot();
    await recreated.editInstructionQueue!(edit);
    expect(f.recover.mock.calls[0]![0].operationId).toBe(f.recover.mock.calls[1]![0].operationId); expect(pending.size).toBe(0);
});
it('keeps late view snapshots from rolling back recovered queue state', async () => {
    const f = fixture(); f.port.snapshot(); await f.port.editInstructionQueue!(edit);
    expect((await f.port.read()).instructionQueue?.revision).toBe(8); expect(f.port.snapshot().active).toBe(false); expect(f.port.snapshot().instructionQueue?.revision).toBe(8);
});
it('preserves the receiver of existing conversation methods', async () => {
    class Source {#value = 42; snapshot() {return {sessionId: 'native'};} value() {return this.#value;}}
    const source = new Source(), f = fixture();
    const bound = bindRecovery(source as unknown as ProjectConversationPort, 'p', 'codex', f.service) as unknown as Source;
    expect(bound.value()).toBe(42);
});
