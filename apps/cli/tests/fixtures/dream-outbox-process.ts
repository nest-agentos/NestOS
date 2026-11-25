import {strict as assert} from 'node:assert';
import path from 'node:path';
import {openLocalFSBackend} from '@nestos/vfsdriver-local';
import {createVFS} from '@nestos/vfs-core';
import {NodeSqliteSidecarDb} from '@nestos/node-host/storage';
import {MemoryCommitStore} from '../../../../libraries/dream/src/vfs';
import {DreamOutbox} from '../../../../backend/app-core/src/dream/outbox';
import {DreamDownstream} from '../../../../backend/app-core/src/dream/downstream';
import {DREAM_OUTBOX_INDEX, dreamOutboxKey} from '../../../../backend/app-core/src/dream/evidence-store';

const [rootDir, phase] = process.argv.slice(2);
const backend = await openLocalFSBackend({rootDir, sidecarDir: path.join(rootDir, '_meta'), createDb: NodeSqliteSidecarDb.open});
const {manager} = await createVFS({rootBackend: backend}), fs = await manager.openFileSystem('/');
const pathName = '/var/lib/projects/owner/dream/dream/evidence.seq';
try {
    if (phase === 'commit') {
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        await fs.driver.createFile({parentPath: '/var/lib/projects/owner/dream/dream', name: 'evidence.seq', type: 'seqfile', recursive: true});
        const store = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), pathName);
        await store.stage({version: 'v1', parentVersion: null, requiredScopes: ['source'], topics: [{id: 'memory', content: 'persisted'}]});
        await store.commit('commit1', 'v1', null, async tx => {await tx.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));});
        assert.equal((await store.active(async () => {}))?.version, 'v1');
        assert.equal((await store.pending('daily', 0, 10)).items.length, 1);
    } else {
        const downstream = new DreamDownstream(fs, async () => {}), worker = new DreamOutbox(fs, downstream);
        if (phase === 'redeliver') await fs.meta.seq!.transaction!(tx => tx.deleteEntry(pathName, `outbox-delivered:${JSON.stringify(JSON.stringify(['daily', 'commit1']))}`));
        await worker.scan(); await worker.quiesce();
        const result = await downstream.read('owner', 'dream', 'daily', 'commit1');
        assert.equal(result?.changes[0]?.content, 'persisted');
        assert.deepEqual(await downstream.read('owner', 'dream', 'kanban', 'commit1'), result);
        const rows: string[] = [];
        await fs.meta.seq!.walkEntries(pathName, row => {rows.push(row.key); return true;}, {keyPrefix: 'consumer-result:daily:'});
        assert.equal(rows.length, 1);
        const store = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), pathName);
        assert.equal((await store.active(async () => {}))?.version, 'v1');
        assert.equal((await store.pending('daily', 0, 10)).items.length, 0);
    }
    console.log(JSON.stringify({phase, pid: process.pid}));
} finally {await manager.dispose();}
