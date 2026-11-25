import {strict as assert} from 'node:assert';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {openLocalFSBackend} from '@nestos/vfsdriver-local';
import {NodeSqliteSidecarDb} from '@nestos/node-host/storage';
import {FlowLibraryCommand} from '@nestos/app-contracts';
import {MemoryCommitStore} from '../../../../libraries/dream/src/vfs';
import {createApplicationRuntime} from '../../../../backend/app-core/src/runtime/create-application-runtime';
import {DREAM_OUTBOX_INDEX, dreamOutboxKey} from '../../../../backend/app-core/src/dream/evidence-store';

const [rootDir, phase] = process.argv.slice(2), manifest = path.join(rootDir, 'fixture.json');
if (phase === 'commit') {
    const llm = path.join(rootDir, 'etc/llm');
    await mkdir(path.join(llm, '.providers'), {recursive: true}); await mkdir(path.join(llm, '.connections'), {recursive: true});
    await writeFile(path.join(llm, '.providers/fixture.json'), JSON.stringify({id: 'fixture', name: 'Fixture', implementation: 'openai-compatible',
        apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'model', name: 'Fixture'}]}));
    await writeFile(path.join(llm, '.connections/fixture.json'), JSON.stringify({id: 'fixture', name: 'Fixture', providerId: 'fixture',
        protocol: 'openai-chat', tiers: {optimal: 'model'}}));
}
const backend = await openLocalFSBackend({rootDir, sidecarDir: path.join(rootDir, '_meta'), createDb: NodeSqliteSidecarDb.open});
const remoteSourceProvider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote file open');}};
const runtime = await createApplicationRuntime({backend, ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false, remoteSourceProvider});
try {
    let owner: string, source: string;
    const dream = runtime.dream!, fs = await runtime.vfs.openFileSystem('/');
    if (phase === 'commit') {
        const project = await runtime.projects.create('Owner'); owner = project.project.id;
        const files = await runtime.projects.openFiles(project.path);
        await files.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'Fixture evidence.'}); await files.dispose();
        await dream.create(owner, 'dream', 'create', 'Dream');
        await dream.setModelConnection(owner, 'dream', 'fixture');
        const scanner = {id: 'fixture-scanner', name: 'Scanner', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'result', name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: {value: {candidates: []}}}], edges: [], outputs: {result: {value: '${nodes.result.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [scanner]} as never);
        const target = (await dream.scannerTargets(owner, 'dream')).find(item => item.target.id === 'fixture-scanner')!.target;
        source = (await dream.addFile(owner, 'dream', 'add', 1, {projectId: owner, connectionId: 'dream-local', path: '/notes/source.md',
            executor: {target}, maxOutputTokens: 256, runTokenLimit: 1000})).sourceId;
        await writeFile(manifest, JSON.stringify({owner, source}));
    } else ({owner, source} = JSON.parse(await readFile(manifest, 'utf8')));
    const evidencePath = `/var/lib/projects/${owner}/dream/dream/evidence.seq`;
    if (phase === 'commit') {
        if (!await fs.driver.exists(evidencePath)) await fs.driver.createFile({parentPath: `/var/lib/projects/${owner}/dream/dream`, name: 'evidence.seq', type: 'seqfile', recursive: true});
        if (!await fs.driver.exists(DREAM_OUTBOX_INDEX)) await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        const authority = await (dream as any).sourceAuthorization.authorizeDreamSource(owner, 'dream-local', 'fileRead');
        await fs.meta.seq!.setEntry(evidencePath, `source:${JSON.stringify(source)}`, JSON.stringify({projectId: owner, connectionId: 'dream-local', authority, cursor: 'captured'}));
        const store = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), evidencePath);
        await store.stage({version: 'v1', parentVersion: null, requiredScopes: [source], topics: [{id: 'memory', content: 'persisted'}]});
        await store.commit('commit1', 'v1', null, async tx => {await tx.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey(owner, 'dream'), JSON.stringify({owner, dream: 'dream'}));});
        await store.stage({version: 'uncommitted', parentVersion: 'v1', requiredScopes: [source], topics: [{id: 'memory', content: 'invisible'}]});
        for (const kind of ['daily', 'kanban']) {
            assert.equal((await store.pending(kind, 0, 10)).items.length, 1);
            assert.equal(await fs.meta.seq!.getEntry(evidencePath, `consumer-result:${kind}:${JSON.stringify('commit1')}`), null);
        }
    } else {
        if (phase === 'redeliver') await fs.meta.seq!.transaction!(async tx => {
            for (const kind of ['daily', 'kanban']) await tx.deleteEntry(evidencePath, `outbox-delivered:${JSON.stringify(JSON.stringify([kind, 'commit1']))}`);
        });
        runtime.startBackground!();
        const deadline = Date.now() + 20000;
        let daily, kanban;
        do {
            daily = await dream.readDownstream(owner, 'dream', 'daily', 'commit1');
            kanban = await dream.readDownstream(owner, 'dream', 'kanban', 'commit1');
            const delivered = await Promise.all(['daily', 'kanban'].map(kind => fs.meta.seq!.getEntry(evidencePath,
                `outbox-delivered:${JSON.stringify(JSON.stringify([kind, 'commit1']))}`)));
            if (daily && kanban && delivered.every(Boolean)) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert.equal(daily?.changes[0]?.content, 'persisted'); assert.deepEqual(kanban, daily);
        for (const kind of ['daily', 'kanban']) assert.equal(await fs.meta.seq!.getEntry(evidencePath,
            `outbox-delivered:${JSON.stringify(JSON.stringify([kind, 'commit1']))}`), '1');
        assert.equal((await dream.activeConsolidation(owner, 'dream'))?.version, 'v1');
        for (const kind of ['daily', 'kanban']) {
            const rows: string[] = [];
            await fs.meta.seq!.walkEntries(evidencePath, row => {rows.push(row.key); return true;}, {keyPrefix: `consumer-result:${kind}:`});
            assert.equal(rows.length, 1);
        }
    }
    console.log(JSON.stringify({phase, pid: process.pid}));
} finally {await runtime.dispose();}
