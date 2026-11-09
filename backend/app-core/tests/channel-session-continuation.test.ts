import {afterEach, expect, it, vi} from 'vitest';
import {prepareChannelContinuation} from '../src/run/channel-session-continuation';
const state = vi.hoisted(() => ({generation: 2, valid: true, native: true, active: false, extra:false, extraActive:false}));
vi.mock('../src/projects/harness-context-catalog', () => ({readContextCatalog: async () => ({value: {bindings: {...(state.extra?{failed:{id:'failed',branchId:'main',connectionId:'work-original',validity:'invalid',activeOperation:state.extraActive?{}:undefined}}:{}),binding: {id: 'binding', generation: state.generation, revision: 9, branchId: 'main', connectionId: 'work-original', validity: state.valid ? 'valid' : 'invalid', activeOperation: state.active ? {} : undefined, nativeRef: state.native ? {profileId: 'codex', sessionId: 'native-original'} : undefined}}}})}));
afterEach(() => {state.generation = 2; state.valid = state.native = true; state.active = state.extra = state.extraActive = false;});
function fixture() {
    const base = {expectedSessionId: 'original', expectedBranch: 'main', expectedTarget: {kind: 'agent', id: 'managed', version: '1', digest: 'digest'},
        source: {kind: 'composer', text: JSON.stringify({instruction: 'Read-only merge analysis', dependencies: {lifecycle: {stage: 'postload.succeeded'}}}), values: {}, attachments: []},
        overrides: {harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 2}}};
    const options = {kernel: {sessionActivity: async () => ({counts: {running: 0}})}, base, sessionId: 'original', connectionId: 'work-original', id: 'next-round', replies: [{id: 'request', requestDigest: 'b'.repeat(64), sha256: 'a'.repeat(64)}]} as never;
    return {base, options};
}
it('continues the same logical/native identity with the current revision and concise response references', async () => {
    const f = fixture(), before = JSON.stringify(f.base), request = await prepareChannelContinuation(f.options);
    expect(request).toMatchObject({expectedSessionId: 'original', expectedTarget: f.base.expectedTarget, submission: {id: 'next-round'}, overrides: {branchMode: 'continue', harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 9, expectedGeneration: 2}}});
    const text=(request.source as {text:string}).text;
    expect(text).toContain('`session_response`');expect(text).toContain('`request`');expect(text).toContain('Do not rerun');
    expect(text).not.toContain('postload.succeeded');expect(text).not.toContain('b'.repeat(64));expect(text.length).toBeLessThan(240);expect(JSON.stringify(f.base)).toBe(before);
});
it('refuses a changed generation, missing native context, active operation or invalid binding', async () => {
    const f = fixture(); state.generation = 3; await expect(prepareChannelContinuation(f.options)).rejects.toMatchObject({code: 'CHANNEL_CONTEXT_CHANGED'});
    state.generation = 2; state.native = false; await expect(prepareChannelContinuation(f.options)).rejects.toMatchObject({code: 'CHANNEL_CONTEXT_UNAVAILABLE'});
    state.native = true; state.active = true; await expect(prepareChannelContinuation(f.options)).rejects.toMatchObject({code: 'CHANNEL_CONTEXT_UNAVAILABLE'});
    state.active = false; state.valid = false; await expect(prepareChannelContinuation(f.options)).rejects.toMatchObject({code: 'CHANNEL_CONTEXT_UNAVAILABLE'});
});

it('ignores a settled failed creation but keeps an unconfirmed active creation blocking',async()=>{
 state.extra=true;await expect(prepareChannelContinuation(fixture().options)).resolves.toMatchObject({expectedSessionId:'original'});
 state.extraActive=true;await expect(prepareChannelContinuation(fixture().options)).rejects.toMatchObject({code:'CHANNEL_CONTEXT_UNAVAILABLE'});
});
