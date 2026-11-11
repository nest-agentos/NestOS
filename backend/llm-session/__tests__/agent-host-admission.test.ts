import {expect, it, vi} from 'vitest';
import {AgentResolver} from '../src/session/agent-resolver';
import {SessionRunCoordinator} from '../src/session/session-run-coordinator';
import {bindStandaloneFlowNode} from '../src/session/flow-node-binder';
import {captureFlowIdentities, frozenFlowIdentities} from '../src/session/flow-identity-snapshot';

function fixture() {
    const denied = Object.assign(new Error('Choose another Agent'), {code: 'AGENT_PROJECT_SCOPE_DENIED'});
    const admitAgent = vi.fn(async () => {throw denied;});
    const resolver = new AgentResolver({} as never, undefined, undefined, undefined, {admitAgent});
    return {resolver, admitAgent, denied};
}
it('rejects direct and frozen queued execution before credentials, model or history reads', async () => {
    const {resolver, admitAgent, denied} = fixture();
    const runs = new SessionRunCoordinator({} as never, {} as never, resolver, {} as never,
        {} as never, {} as never, {} as never, {} as never);
    const input = {sessionId: 's', agentId: 'a'};
    await expect((runs as any).resolveSelectedIdentity(input)).rejects.toBe(denied);
    await expect((runs as any).resolveConfig({...input, instructionConnectionBinding: {agent: {id: 'a'}}})).rejects.toBe(denied);
    expect(admitAgent).toHaveBeenNthCalledWith(1, 'a', 's');
    expect(admitAgent).toHaveBeenNthCalledWith(2, 'a', 's');
});
it('rejects Flow and isolated child Agent references through the same host admission', async () => {
    const {resolver, admitAgent, denied} = fixture();
    for (const invocationContext of [undefined, 'isolated']) {
        await expect(bindStandaloneFlowNode({id: 'node', name: 'Node', plugin: 'builtin.agent',
            config: {agentId: 'a', instruction: 'private input', invocationContext}, inputs: {}} as never,
        {}, 's', resolver)).rejects.toBe(denied);
    }
    expect(admitAgent).toHaveBeenCalledTimes(2);
});
it('preserves live admission when capturing and binding immutable Flow identities', async () => {
    const {resolver, admitAgent, denied} = fixture();
    const captured = captureFlowIdentities(resolver, 's');
    await expect(captured.resolver.assertAdmission!('a', 's')).rejects.toBe(denied);
    const frozen = frozenFlowIdentities(captured.snapshot(), undefined, resolver);
    await expect(frozen.assertAdmission!('a', 's')).rejects.toBe(denied);
    expect(admitAgent).toHaveBeenCalledTimes(2);
});
