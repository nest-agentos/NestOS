import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runCommand, respondCommand, resumeCommand, type CommandOptions } from '../src/commands';
import { RunStore } from '../src/run-store';

const examples = path.resolve('examples/harness-validation');
const roots: string[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(name: string) {
    const temporary = await mkdtemp(path.join(tmpdir(), 'harness-examples-')); roots.push(temporary);
    const root = path.join(temporary, 'fixture');
    await promisify(execFile)(process.execPath, [path.join(examples, 'prepare.mjs'), root]);
    const profile = path.join(root, 'profile');
    const save = async (file: string, value: unknown) => {
        const target = path.join(profile, file); await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify(value));
    };
    await save('etc/llm/.providers/fixture.json', { id: 'fixture', name: 'Fixture', implementation: 'openai-compatible', apiKey: 'fixture',
        baseURL: 'http://harness-fixture.invalid', defaultPath: '/v1/chat/completions', enabled: true, models: [{ id: 'fixture' }] });
    await save('etc/llm/.connections/default.json', { id: 'default', name: 'Default', providerId: 'fixture', protocol: 'openai-chat', enabled: true, tiers: { standard: 'fixture' } });
    const options: CommandOptions = { file: path.join(profile, 'home/admin/flows', `${name}.flow`), profile,
        setHome: path.join(root, 'workspace'), headless: true, json: true };
    return { root, options, store: new RunStore(path.join(profile, 'var/lib/cli-runs')) };
}

interface Action { name: string; arguments: Record<string, unknown> }
function scriptedModel(actions: Action[]) {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const request = JSON.parse(options.body); requests.push(request);
        const results = request.messages.filter((message: any) => message.role === 'tool');
        const next = actions[results.length];
        const skill = request.messages.some((message: any) => message.role === 'system' && String(message.content).includes('HARNESS_SKILL_READY'));
        const message = next ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${results.length}`, type: 'function',
            function: { name: next.name, arguments: JSON.stringify(next.arguments) } }] }
            : { role: 'assistant', content: [skill ? 'HARNESS_SKILL_READY' : '', ...results.map((result: any) => result.content)].join('\n') };
        return new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { total_tokens: 2 } }),
            { headers: { 'content-type': 'application/json' } });
    }));
    return requests;
}

const read: Action = { name: 'Read', arguments: { file_path: './notes.txt' } };
const lookup: Action = { name: 'mcp__validation__lookup', arguments: { topic: 'release' } };
const scenarios = [
    { name: 'harness-tools', skill: false, mcp: false, actions: [{ name: 'Grep', arguments: { pattern: 'HARNESS_CHECK', path: '.' } }, read] },
    { name: 'harness-skill', skill: true, mcp: false, actions: [read] },
    { name: 'harness-mcp', skill: false, mcp: true, actions: [lookup] },
    { name: 'harness-combined', skill: true, mcp: true, actions: [read, lookup] },
];

it.each(scenarios)('executes the shipped $name example with real tools and persisted results', async scenario => {
    const f = await fixture(scenario.name), requests = scriptedModel(scenario.actions);
    const code = await runCommand(f.options);
    const [initial] = await f.store.list();
    expect(code, initial.error).toBe(scenario.mcp ? 3 : 0);
    if (scenario.mcp) {
        expect(initial.status).toBe('waiting'); expect(initial.pendingInteractions).toHaveLength(1);
        await expect(access(path.join(f.root, 'mcp-calls.jsonl'))).rejects.toThrow();
        expect(await respondCommand(initial.id, initial.pendingInteractions[0].interactionId, { ...f.options, approve: true })).toBe(0);
        expect(await resumeCommand(initial.id, f.options)).toBe(0);
        expect((await readFile(path.join(f.root, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
            .toEqual([{ name: 'lookup', topic: 'release' }]);
    }
    const finished = await f.store.load(initial.id);
    expect(finished.status).toBe('succeeded'); expect(finished.nodeTaskIds.__flow_return).toBeTruthy();
    const result = await readFile(path.join(f.store.runDir(initial.id), finished.resultPath!), 'utf8');
    expect(requests).toHaveLength(scenario.actions.length + 1);
    const exposed = requests[0].tools.map((tool: any) => tool.function.name);
    expect(exposed).toEqual(expect.arrayContaining(scenario.actions.map(action => action.name)));
    expect(exposed).not.toContain('Write'); expect(exposed).not.toContain('Bash');
    if (scenario.name !== 'harness-mcp') { expect(result).toContain('HARNESS_CHECK'); expect(result).toContain('Lin'); }
    if (scenario.skill) {
        expect(JSON.stringify(requests[0].messages)).toContain('HARNESS_SKILL_READY');
        expect(result).toContain('HARNESS_SKILL_READY');
    }
    if (scenario.mcp) expect(result).toContain('MCP_VALIDATION_OK');
    const events = await readFile(path.join(f.store.runDir(initial.id), 'events.jsonl'), 'utf8');
    expect(events).toContain('tool:success');
}, 30000);

it('does not execute MCP when approval is denied', async () => {
    const f = await fixture('harness-mcp'); scriptedModel([lookup]);
    expect(await runCommand(f.options)).toBe(3);
    const [run] = await f.store.list();
    expect(await respondCommand(run.id, run.pendingInteractions[0].interactionId, { ...f.options, deny: true })).toBe(0);
    await resumeCommand(run.id, f.options);
    await expect(access(path.join(f.root, 'mcp-calls.jsonl'))).rejects.toThrow();
    const events = await readFile(path.join(f.store.runDir(run.id), 'events.jsonl'), 'utf8');
    expect(events).not.toContain('MCP_VALIDATION_OK');
}, 30000);

it('blocks a model-requested write outside the declared read-only tool list', async () => {
    const f = await fixture('harness-tools');
    const requests = scriptedModel([{ name: 'Write', arguments: { file_path: './unexpected.txt', content: 'must not be written' } }]);
    await runCommand(f.options);
    await expect(access(path.join(f.root, 'workspace/unexpected.txt'))).rejects.toThrow();
    expect(requests[0].tools.map((tool: any) => tool.function.name)).not.toContain('Write');
    const [run] = await f.store.list();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Tool is not authorized for this task: Write');
}, 30000);
