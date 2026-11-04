import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { bindCapabilities, type DurableTaskProgram } from '@itookit/durable-kernel';
import { loadWorkflow } from '../src/config';
import { createCliRuntime, cliStorage } from '../src/runtime';
import type { RunManifest } from '../src/types';

it('loads a workspace Skill through the real CLI runtime and durable Skill effect', async () => {
    const root = await mkdtemp(`${tmpdir()}/cli-skill-`);
    await mkdir(`${root}/_agent/skills/review`, { recursive: true });
    await writeFile(`${root}/_agent/skills/review/SKILL.md`, '---\nname: Review\ndescription: Review changes\n---\nCheck every changed interface.');
    const source = await readFile(fileURLToPath(new URL('../examples/minimal-dag.yml', import.meta.url)), 'utf8');
    await writeFile(`${root}/workflow.yml`, source);
    const { workflow } = await loadWorkflow(`${root}/workflow.yml`, false);
    const manifest: RunManifest = { version: 1, id: 'skill-test', sessionId: 'skill-test', name: 'skill-test', goal: 'Load Skill',
        workspaceRoot: root, configPath: `${root}/workflow.yml`, configHash: '', status: 'created',
        nodeTaskIds: {}, taskStatuses: {}, taskStartedAt: {}, pendingInteractions: [], grants: [], lastEventSequence: 0,
        createdAt: Date.now(), updatedAt: Date.now() };
    const runtime = await createCliRuntime(workflow, manifest, async () => {});
    try {
        runtime.kernel.registerProgram(program);
        const session = await runtime.kernel.createSession({ id: manifest.id, storage: cliStorage(manifest.id) });
        const task = await session.submit({ program: program.manifest, input: null, deferStart: true });
        await bindCapabilities(task, [{ kind: 'skill', uri: 'skill://session', rights: ['execute'], signalKey: 'skillHandleId' }]);
        const exit = await task.wait({ timeoutMs: 3000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(JSON.stringify(exit.output)).toContain('Check every changed interface.');
        expect(JSON.stringify((await session.getShared('kernel-adapters.skills.loaded'))?.value)).toContain('review');
    } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

const program: DurableTaskProgram = {
    manifest: { kind: 'test.cli-skill', version: '1' },
    init: () => ({ state: null, next: { type: 'wait', on: { type: 'signal' } } }),
    reduce(state, event) {
        if (event.type === 'signal') {
            const handle = (event.signal.payload as { skillHandleId: string }).skillHandleId;
            return { state, actions: [{ type: 'effect', effect: { id: 'load', kind: 'skill.load', version: '1',
                idempotencyKey: 'load-review', grants: [{ handleId: handle, right: 'execute' }],
                request: { resourceHandleId: handle, skillId: 'review' } } }], next: { type: 'wait', on: { type: 'effect', id: 'load' } } };
        }
        return event.type === 'effect-completed' ? { state, next: { type: 'complete', output: event.result } }
            : { state, next: { type: 'fail', error: { message: JSON.stringify(event) } } };
    },
};

it('retains a changed Session workspace when the CLI runtime is reopened without an override', async () => {
    const root = await mkdtemp(`${tmpdir()}/cli-workspace-`);
    const changed = `${root}/changed`; await mkdir(changed);
    const source = await readFile(fileURLToPath(new URL('../examples/minimal-dag.yml', import.meta.url)), 'utf8');
    await writeFile(`${root}/workflow.yml`, source);
    const { workflow } = await loadWorkflow(`${root}/workflow.yml`, false);
    const manifest: RunManifest = { version: 1, id: 'workspace-test', sessionId: 'workspace-test', name: 'workspace-test', goal: 'Workspace',
        workspaceRoot: root, configPath: `${root}/workflow.yml`, configHash: '', status: 'created',
        nodeTaskIds: {}, taskStatuses: {}, taskStartedAt: {}, pendingInteractions: [], grants: [], lastEventSequence: 0,
        createdAt: Date.now(), updatedAt: Date.now() };
    try {
        const first = await createCliRuntime(workflow, manifest, async () => {});
        try {
            expect(first.workspaceRoot).toBe(root);
            expect(await first.grants.grant(changed, 'read')).toMatchObject({ path: changed, mountAt: '/changed', access: 'read' });
        } finally { await first.dispose(); }
        const configured = await createCliRuntime(workflow, manifest, async () => {}, undefined, 'execute', { setHome: changed });
        try { expect(configured.workspaceRoot).toBe(changed); } finally { await configured.dispose(); }
        const reopened = await createCliRuntime(workflow, manifest, async () => {});
        try { expect(reopened.workspaceRoot).toBe(changed); } finally { await reopened.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
});
