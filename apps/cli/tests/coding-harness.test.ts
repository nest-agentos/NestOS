import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DurableAgentProgram } from '@itookit/llm-tasks';
import { ToolCallEffectAdapter, type ToolCallEffectRequest } from '@itookit/kernel-adapters';
import { BUILTIN_TOOLS, ToolDeviceDriver } from '@itookit/tools';
import type { EffectExecutionContext, TaskInputEvent } from '@itookit/durable-kernel';
import { NodeNativeShell } from '../src/shell';

type Step = ReturnType<DurableAgentProgram['init']>;

// Each transition starts from serialized state in a new Program instance.
function advance(step: Step, event: TaskInputEvent): Step {
    return new DurableAgentProgram().reduce(JSON.parse(JSON.stringify(step.state)), event);
}

function call(step: Step, name: string, args: Record<string, unknown>): Step {
    const id = `call-${step.state.exchanges}`;
    return advance(step, { type: 'effect-completed', effectId: `llm-exchange-${step.state.exchanges}`,
        result: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ] }, finish_reason: 'tool_calls' }] } });
}

function effectContext(effectId: string): EffectExecutionContext {
    return { sessionId: 'coding', taskId: 'agent', effectId, abortSignal: new AbortController().signal,
        grants: [{ handleId: 'tool', right: 'execute', resource: {
            id: 'tools', sessionId: 'coding', kind: 'tool', uri: 'tool://runtime', generation: 1, createdAt: 0,
        } }] };
}

async function approveAndExecute(step: Step, adapter: ToolCallEffectAdapter): Promise<Step> {
    expect(step.state.phase).toBe('approval');
    expect(step.actions?.some(action => action.type === 'effect')).toBe(false);
    const approved = advance(step, { type: 'interaction-resolved',
        interactionId: step.state.pendingApprovalInteractionId!, value: { approved: true } });
    const action = approved.actions?.find(action => action.type === 'effect');
    if (!action || action.type !== 'effect' || !action.effect.id) throw new Error('Expected a named tool Effect');
    const result = await adapter.execute(action.effect.request as unknown as ToolCallEffectRequest, effectContext(action.effect.id));
    return advance(approved, { type: 'effect-completed', effectId: action.effect.id, result: JSON.parse(JSON.stringify(result)) });
}

async function fixture(directory: string) {
    const path = join(directory, 'code.cjs');
    await writeFile(path, 'module.exports = () => 1;\n');
    await writeFile(join(directory, 'check.cjs'), "require('node:assert/strict').equal(require('./code.cjs')(), 2);\n");
    const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
    driver.setFileContext({ readFile: path => readFile(path, 'utf8'), writeFile: (path, text) => writeFile(path, text),
        listFiles: async () => [path] }, directory);
    driver.setNativeShell(new NodeNativeShell());
    await driver.init();
    const initial = new DurableAgentProgram().init({ sessionId: 'coding', roundId: 'round', connectionId: 'scripted',
        approval: 'all', workingDirectory: directory, maxExchanges: 5,
        tools: driver.getToolDefinitions(), messages: [{ role: 'user', content: 'Make the function return 2 and verify it' }] });
    const step = advance(initial, { type: 'signal', sequence: 1,
        signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tool' } } });
    return { path, driver, step, adapter: new ToolCallEffectAdapter(driver) };
}

it('corrects an Edit failure, obtains fresh approvals, and verifies the real file after restoring state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coding-harness-'));
    const test = await fixture(directory);
    try {
        let step = await approveAndExecute(call(test.step, 'Edit', {
            file_path: test.path, old_string: '=> 0', new_string: '=> 2',
        }), test.adapter);
        expect(step.state.messages.at(-1)?.content).toContain('old_string not found');
        expect(await readFile(test.path, 'utf8')).toContain('=> 1');
        step = await approveAndExecute(call(step, 'Read', { file_path: test.path }), test.adapter);
        expect(step.state.messages.at(-1)?.content).toContain('=> 1');
        step = await approveAndExecute(call(step, 'Edit', {
            file_path: test.path, old_string: '=> 1', new_string: '=> 2',
        }), test.adapter);
        step = await approveAndExecute(call(step, 'Bash', { command: 'node check.cjs' }), test.adapter);
        expect(step.state.messages.at(-1)?.content).toContain('[exit 0]');
        const done = advance(step, { type: 'effect-completed', effectId: 'llm-exchange-5',
            result: { choices: [{ message: { role: 'assistant', content: 'Fixed and verified' }, finish_reason: 'stop' }] } });
        expect(done.next.type).toBe('complete');
        expect(await readFile(test.path, 'utf8')).toBe('module.exports = () => 2;\n');
    } finally {
        await test.driver.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});
