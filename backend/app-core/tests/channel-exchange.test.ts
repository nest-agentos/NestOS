import {kanbanJournalOptions} from '../src/kanban/host-policy';
import canonicalFixture from '../../../tools/cells/src/plugin/projects/tests/channel-canonical.json';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import type {SubmissionRequest} from '@nestos/llm-session/contracts';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {advanceChannelExchange, type ChannelExchangeOptions} from '../src/run/channel-exchange';
import {channelDigest, channelRequests, type ChannelRequest} from '../src/run/channel-protocol';
import {memoryChannels} from './helpers/session-channels';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    const journal = new KanbanAutomationJournal(fs, kanbanJournalOptions); await journal.open(); const directory = '/work/_nestos/kanban';
    const channels = memoryChannels();
    const request: ChannelRequest = {id: 'question', scopeId: 'operation', method: 'kanban.context.resolve', params: {repository: '.', commits: ['a'.repeat(40)]}};
    const publish = async (value = request) => channels.request(value.scopeId, value.id, value.method, value.params);
    const responses = () => channels.ensure('operation').requests;
    const publishResponse = vi.fn(async (response: import('../src/run/channel-protocol').ChannelResponse) => channels.channel('project','respond',response));
    const readRequests = async () => channelRequests(await channels.channel('project','requests',{scopeId:'operation'}),'operation');
    let outcome: 'running' | 'succeeded' | 'cancelled' = 'running';
    const submission = {start: vi.fn(async (_request: SubmissionRequest) => ({sessionId: 'original', outcome})), inspect: vi.fn(async (_request: SubmissionRequest) => ({sessionId: 'original', outcome}))};
    const prepare = vi.fn(async (id: string) => ({expectedSessionId: 'original', expectedBranch: 'main', submission: {id, source: {kind: 'conversation', ownerId: 'original', id}}}) as SubmissionRequest);
    const resolve = vi.fn(async () => ({contexts: [{task: 'prior-task', revision: 1}]})); const report = vi.fn(async () => {});
    const options = {id: 'operation', scopeId: 'operation', readRequests, publishResponse, journal, submission, prepare, resolve, report} as ChannelExchangeOptions;
    const initial = {sessionId: 'original', outcome: 'succeeded' as const};
    return {fs, journal, directory, channels, responses, publishResponse, request, options, publish, submission, prepare, resolve, report, initial, complete: () => {outcome = 'succeeded';}, cancel: () => {outcome = 'cancelled';}};
}
it('waits for the native turn to end, publishes a response and resumes only the original Session', async () => {
    const f = await fixture(); await f.publish();
    expect(await advanceChannelExchange(f.options, {...f.initial, outcome: 'running'})).toMatchObject({outcome: 'running'});
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submission.start).not.toHaveBeenCalled(); expect(f.responses()[0].response).toBeNull();
    expect(await advanceChannelExchange(f.options, f.initial)).toMatchObject({outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'});
    const response = f.responses()[0].response;
    expect(response).toMatchObject({id: 'question', scopeId: 'operation', requestDigest: channelDigest(f.request), status: 'ok'});
    expect(f.prepare).toHaveBeenCalledWith(expect.any(String), [{id: 'question', requestDigest: channelDigest(f.request), sha256: expect.stringMatching(/^[a-f0-9]{64}$/)}]);
    expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId: 'original'}));
    f.complete(); expect(await advanceChannelExchange(f.options, f.initial)).toMatchObject({outcome: 'succeeded'});
    await advanceChannelExchange(f.options, f.initial); expect(f.submission.start).toHaveBeenCalledOnce(); expect(f.resolve).toHaveBeenCalledOnce();
});
it('survives a lost submission reply and a new coordinator instance without replaying the turn', async () => {
    const f = await fixture(); await f.publish();
    f.submission.start.mockRejectedValueOnce(Object.assign(new Error('Lost reply'), {code: 'TRANSPORT_DISCONNECTED'}));
    expect(await advanceChannelExchange(f.options, f.initial)).toMatchObject({outcome: 'unknown'});
    const restored = {...f.options, journal: new KanbanAutomationJournal(f.fs, kanbanJournalOptions)};
    expect(await advanceChannelExchange(restored, f.initial)).toMatchObject({outcome: 'running'});
    f.complete(); await advanceChannelExchange(restored, f.initial);
    expect(f.submission.start).toHaveBeenCalledOnce(); expect(f.resolve).toHaveBeenCalledOnce();
});
it('keeps the frozen response when Cells disconnects during publication and resumes after reconnect', async () => {
    const f = await fixture(); await f.publish(); f.publishResponse.mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'ECONNRESET'}));
    await expect(advanceChannelExchange(f.options, f.initial)).rejects.toMatchObject({code: 'ECONNRESET'});
    expect(f.submission.start).not.toHaveBeenCalled(); 
    await advanceChannelExchange({...f.options, journal: new KanbanAutomationJournal(f.fs, kanbanJournalOptions)}, f.initial);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('rejects changed requests, wrong scopes and changed channel responses', async () => {
    const f = await fixture(); await f.publish(); await advanceChannelExchange(f.options, f.initial);
    const row=f.responses()[0]; row.request={...f.request, params:{commits:[]}}; row.requestDigest=channelDigest(row.request);row.response={...(row.response as object),requestDigest:row.requestDigest};
    await expect(advanceChannelExchange(f.options, f.initial)).rejects.toMatchObject({code:'CHANNEL_REQUEST_CHANGED'});
    row.request={...f.request,scopeId:'other'};row.requestDigest=channelDigest(row.request);
    await expect(advanceChannelExchange(f.options, f.initial)).rejects.toMatchObject({code:'CHANNEL_REQUEST_INVALID'});
    row.request=f.request;row.requestDigest=channelDigest(f.request);row.response={...(row.response as object),requestDigest:row.requestDigest,payload:{tampered:true}};
    await expect(advanceChannelExchange(f.options, f.initial)).rejects.toMatchObject({code:'CHANNEL_RESPONSE_CHANGED'});
    expect(f.submission.start).toHaveBeenCalledOnce();
});
it('returns explicit application errors in immutable channel responses and never converts transport errors to answers', async () => {
    const f = await fixture(); await f.publish(); f.resolve.mockRejectedValueOnce(Object.assign(new Error('unsupported'), {code: 'CHANNEL_METHOD_UNSUPPORTED', channelResponse: true}));
    await advanceChannelExchange(f.options, f.initial);
    expect(f.responses()[0].response).toMatchObject({status: 'error', error: {code: 'CHANNEL_METHOD_UNSUPPORTED'}});
    f.complete(); await advanceChannelExchange(f.options, f.initial); await f.publish({...f.request, id: 'second'});
    f.resolve.mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'ECONNRESET'}));
    await expect(advanceChannelExchange(f.options, f.initial)).rejects.toMatchObject({code: 'ECONNRESET'});
    expect(f.responses()[1].response).toBeNull(); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('supports batches and a second question using new rounds in the same Session', async () => {
    const f = await fixture(); await f.publish(); await f.publish({...f.request, id: 'parallel'});
    await advanceChannelExchange(f.options, f.initial); expect(f.prepare.mock.calls[0][1]).toHaveLength(2);
    f.complete(); await advanceChannelExchange(f.options, f.initial); await f.publish({...f.request, id: 'later'}); await advanceChannelExchange(f.options, f.initial);
    expect(f.submission.start).toHaveBeenCalledTimes(2); expect(new Set(f.submission.start.mock.calls.map(([row]) => row.expectedSessionId))).toEqual(new Set(['original']));
    expect(f.submission.start.mock.calls[0][0].submission!.id).not.toBe(f.submission.start.mock.calls[1][0].submission!.id);
});
it.each(['cancelled','failed'] as const)('does not resume a %s native turn', async outcome => {
    const f=await fixture();await f.publish();expect(await advanceChannelExchange(f.options,{...f.initial,outcome})).toMatchObject({outcome});
    expect(f.resolve).not.toHaveBeenCalled();expect(f.submission.start).not.toHaveBeenCalled();
});
it('only retries a proved pre-admission ownership rejection, retaining the frozen identity', async () => {
    const f = await fixture(); await f.publish(); f.submission.start.mockRejectedValueOnce(Object.assign(new Error('Read only'), {executionOutcome: 'not-started', retryable: true, code: 'SESSION_WRITER_UNAVAILABLE'}));
    await advanceChannelExchange(f.options, f.initial); await advanceChannelExchange(f.options, f.initial);
    expect(f.submission.start).toHaveBeenCalledTimes(2); expect(f.submission.start.mock.calls[0][0]).toEqual(f.submission.start.mock.calls[1][0]);
});
it('refuses to resume when a final result and a new request are published together', async () => {
    const f = await fixture(); await f.publish();
    await expect(advanceChannelExchange({...f.options, finalPublished: true}, f.initial)).rejects.toMatchObject({code: 'CHANNEL_RESULT_CONFLICT'});
    expect(f.submission.start).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
});
it('recovers a prepared continuation after the coordinator stops before submission', async () => {
    const f = await fixture(); await f.publish();
    f.report.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {throw new Error('Coordinator stopped');});
    await expect(advanceChannelExchange(f.options, f.initial)).rejects.toThrow('Coordinator stopped');
    const saved = await f.journal.get<{phase: string; request: SubmissionRequest}>('channel-exchange:operation');
    expect(saved!.phase).toBe('prepared'); expect(f.submission.start).not.toHaveBeenCalled();
    await advanceChannelExchange({...f.options, journal: new KanbanAutomationJournal(f.fs, kanbanJournalOptions)}, f.initial);
    expect(f.submission.start).toHaveBeenCalledWith(saved!.request); expect(f.resolve).toHaveBeenCalledOnce();
});
it('publishes a bounded error response for oversized answers without leaking arbitrary error text', async () => {
    const f = await fixture(); await f.publish(); f.resolve.mockResolvedValueOnce({contexts: ['x'.repeat(70000)]} as never);
    await advanceChannelExchange(f.options, f.initial);
    expect(f.responses()[0].response).toMatchObject({status: 'error', error: {code: 'CHANNEL_RESPONSE_LIMIT'}});
    f.complete(); await advanceChannelExchange(f.options, f.initial); await f.publish({...f.request, id: 'next'});
    f.resolve.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {channelResponse: true, code: 'PRIVATE_BODY token=secret'}));
    await advanceChannelExchange(f.options, f.initial);
    const text = JSON.stringify(f.responses()[1].response); expect(text).not.toContain('PRIVATE_BODY'); expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toMatchObject({error: {code: 'CHANNEL_RESOLUTION_FAILED'}});
});
it('rechecks the channel before reporting success even when the continuation finishes immediately', async () => {
    const f = await fixture(); await f.publish(); f.complete();
    expect(await advanceChannelExchange(f.options, f.initial)).toMatchObject({outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'});
    expect(await advanceChannelExchange(f.options, f.initial)).toMatchObject({outcome: 'succeeded'}); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('rereads the channel after settlement and catches a final result published alongside a late request', async () => {
    const f = await fixture(); await f.publish(); await advanceChannelExchange(f.options, f.initial); let final = false;
    f.submission.inspect.mockImplementationOnce(async () => {await f.publish({...f.request, id: 'late'}); final = true; return {sessionId: 'original', outcome: 'succeeded'};});
    await expect(advanceChannelExchange({...f.options, finalPublished: async () => final}, f.initial)).rejects.toMatchObject({code: 'CHANNEL_RESULT_CONFLICT'});
    expect(f.submission.start).toHaveBeenCalledOnce(); expect(f.resolve).toHaveBeenCalledOnce();
});

it('matches the node canonical digest for numbers, numeric keys and non-BMP keys',()=>{
    expect(channelDigest(canonicalFixture.value)).toBe(canonicalFixture.sha256);
});
