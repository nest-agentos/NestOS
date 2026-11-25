import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DREAM_SCHEDULE_INDEX, dreamScheduleKey, DreamConfigStore} from '../src/dream/config-store';
import {DREAM_OUTBOX_INDEX, dreamOutboxKey, DreamEvidenceStore} from '../src/dream/evidence-store';
const allow = {owner: async () => {}, source: async () => {}};

it('indexes consolidation configuration before the first committed memory exists', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamConfigStore(fs);
        const target = {kind: 'flow', id: 'flow', version: '1', digest: 'digest'} as const;
        await store.save('owner', 'dream', 'create', null, {name: 'Dream', enabled: true, files: [], consolidation: {target}}, allow);
        expect(JSON.parse((await fs.meta.seq!.getEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream')))!)).toEqual({owner: 'owner', dream: 'dream'});
    } finally {await manager.dispose();}
});

it('persists owner-scoped configuration and rejects stale or unauthorized writes', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamConfigStore(fs);
        const file = {id: 'source', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/notes/source.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin-source'};
        const config = {name: 'Dream', enabled: true, files: [file]};
        await expect(store.save('owner', 'dream', 'denied', null, config, {owner: async () => {throw new Error('private');}, source: async () => {}})).rejects.toThrow('DREAM_CONFIG_AUTHORIZATION_FAILED');
        expect(await store.read('owner', 'dream')).toBeNull();
        await expect(store.save('owner', 'dream', 'source-denied', null, config,
            {owner: async () => {}, source: async () => {throw new Error('private source');}})).rejects.toThrow('DREAM_CONFIG_AUTHORIZATION_FAILED');
        expect(await store.read('owner', 'dream')).toBeNull();
        await store.save('owner', 'dream', 'first', null, config, allow);
        expect(await store.save('owner', 'dream', 'first', null, config, allow)).toMatchObject({revision: 1});
        await expect(store.save('owner', 'dream', 'first', null, {...config, name: 'Changed'}, allow))
            .rejects.toThrow('DREAM_OPERATION_CONFLICT');
        expect((await store.read('owner', 'dream'))?.config).toEqual(config);
        expect(await store.read('other', 'dream')).toBeNull();
        const attempts = await Promise.allSettled([store.save('owner', 'dream', 'a', 1, {...config, name: 'A'}, allow),
            store.save('owner', 'dream', 'b', 1, {...config, name: 'B'}, allow)]);
        expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect((await store.read('owner', 'dream'))?.revision).toBe(2);
        expect((await store.readRevision('owner', 'dream', 1))?.config).toEqual(config);
    } finally {await manager.dispose();}
});

it('stores authorized adoption sources without changing legacy file configuration', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const store = new DreamConfigStore(await manager.openFileSystem('/'));
        const legacy = {name: 'Dream', enabled: true, files: []};
        await store.save('owner', 'dream', 'create', null, legacy, allow);
        const adoption = {id: 'source', boardId: 'board', itemId: 'item'};
        const next = {...legacy, adoptions: [adoption]};
        await expect(store.save('owner', 'dream', 'denied', 1, next, allow)).rejects.toThrow('DREAM_CONFIG_AUTHORIZATION_FAILED');
        await expect(store.save('owner', 'dream', 'outside', 1, next, {...allow, adoption: async () => {throw new Error('scope');}}))
            .rejects.toThrow('DREAM_CONFIG_AUTHORIZATION_FAILED');
        const authorized = {...allow, adoption: async (source: typeof adoption) => {if (source.boardId !== 'board') throw new Error('scope');}};
        expect(await store.save('owner', 'dream', 'add', 1, next, authorized)).toMatchObject({revision: 2, config: next});
        expect(await store.save('owner', 'dream', 'add', 1, next, authorized)).toMatchObject({revision: 2});
        await expect(store.save('owner', 'dream', 'duplicate', 2, {...next, adoptions: [adoption, {...adoption, id: 'other'}]}, authorized))
            .rejects.toThrow('DREAM_CONFIG_INVALID');
        const file = {id: 'source', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin'};
        await expect(store.save('owner', 'dream', 'duplicate-file-id', 2, {...next, files: [file]}, authorized))
            .rejects.toThrow('DREAM_CONFIG_INVALID');
        expect((await store.readRevision('owner', 'dream', 1))?.config).toEqual(legacy);
        expect(await store.read('other', 'dream')).toBeNull();
        await store.save('owner', 'dream', 'remove', 2, {...legacy, adoptions: []}, authorized);
        await expect(store.save('owner', 'dream', 'rebind', 3,
            {...legacy, adoptions: [{...adoption, itemId: 'another'}]}, authorized)).rejects.toThrow('DREAM_SOURCE_BINDING_CHANGED');
    } finally {await manager.dispose();}
});

it('requires project authorization and stable identities for selected task sources', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const store = new DreamConfigStore(await manager.openFileSystem('/'));
        const file = {id: 'file', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin'};
        const base = {name: 'Dream', enabled: true, files: [file]};
        await store.save('owner', 'dream', 'create', null, base, allow);
        const task = {id: 'source', projectId: 'project', connectionId: 'connection', boardId: 'board', itemId: 'item', scannerSourceId: 'file'};
        await expect(store.save('owner', 'dream', 'denied', 1, {...base, tasks: [task]}, allow)).rejects.toThrow('DREAM_CONFIG_AUTHORIZATION_FAILED');
        const authorized = {...allow, task: async () => {}};
        expect(await store.save('owner', 'dream', 'add', 1, {...base, tasks: [task]}, authorized)).toMatchObject({revision: 2});
        await expect(store.save('owner', 'dream', 'duplicate', 2, {...base, tasks: [task, {...task, id: 'other'}]}, authorized)).rejects.toThrow('DREAM_CONFIG_INVALID');
        await store.save('owner', 'dream', 'remove', 2, {...base, tasks: []}, authorized);
        await expect(store.save('owner', 'dream', 'rebind', 3, {...base, tasks: [{...task, itemId: 'other'}]}, authorized)).rejects.toThrow('DREAM_SOURCE_BINDING_CHANGED');
    } finally {await manager.dispose();}
});

it('bounds and authorizes selected local Session windows', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const store = new DreamConfigStore(await manager.openFileSystem('/'));
        const file = {id: 'file', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin'};
        const base = {name: 'Dream', enabled: true, files: [file]};
        await store.save('owner', 'dream', 'create', null, base, allow);
        const source = {id: 'session-source', projectId: 'local', connectionId: 'dream-local', sessionId: 'session', maxRounds: 2, scannerSourceId: 'file'};
        await expect(store.save('owner', 'dream', 'denied', 1, {...base, sessions: [source]}, allow)).rejects.toThrow('DREAM_CONFIG_AUTHORIZATION_FAILED');
        const authorized = {...allow, session: async () => {}};
        await expect(store.save('owner', 'dream', 'too-many', 1, {...base, sessions: [{...source, maxRounds: 21}]}, authorized)).rejects.toThrow('DREAM_CONFIG_INVALID');
        await expect(store.save('owner', 'dream', 'remote', 1, {...base, sessions: [{...source, connectionId: 'remote'}]}, authorized)).rejects.toThrow('DREAM_CONFIG_INVALID');
        expect(await store.save('owner', 'dream', 'add', 1, {...base, sessions: [source]}, authorized)).toMatchObject({revision: 2});
        await store.save('owner', 'dream', 'remove', 2, {...base, sessions: []}, authorized);
        await expect(store.save('owner', 'dream', 'rebind', 3, {...base, sessions: [{...source, sessionId: 'other'}]}, authorized))
            .rejects.toThrow('DREAM_SOURCE_BINDING_CHANGED');
        const remote = {...source, id: 'remote-source', projectId: 'remote-project', connectionId: 'remote', profileId: 'profile'};
        expect(await store.save('owner', 'dream', 'add-remote', 3, {...base, sessions: [remote]}, authorized)).toMatchObject({revision: 4});
    } finally {await manager.dispose();}
});

it('authorizes change scopes and prevents rebinding a retained source identity', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const store = new DreamConfigStore(await manager.openFileSystem('/'));
        const file = {id: 'file', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin'};
        const base = {name: 'Dream', enabled: true, files: [file]};
        const source = {id: 'change', projectId: 'project', connectionId: 'connection', directory: '/docs',
            exclude: ['/docs/private'], maxEntries: 10, scannerSourceId: 'file'};
        await store.save('owner', 'dream', 'create', null, base, allow);
        await expect(store.save('owner', 'dream', 'denied', 1, {...base, changes: [source]}, allow)).rejects.toThrow('DREAM_CONFIG_AUTHORIZATION_FAILED');
        const authorized = {...allow, change: async () => {}};
        await expect(store.save('owner', 'dream', 'bad-scope', 1, {...base, changes: [{...source, exclude: ['/other']}]}, authorized)).rejects.toThrow('DREAM_CHANGE_SCOPE_INVALID');
        await store.save('owner', 'dream', 'add', 1, {...base, changes: [source]}, authorized);
        await store.save('owner', 'dream', 'remove', 2, {...base, changes: []}, authorized);
        await expect(store.save('owner', 'dream', 'rebind', 3, {...base, changes: [{...source, directory: '/other', exclude: []}]}, authorized)).rejects.toThrow('DREAM_SOURCE_BINDING_CHANGED');
    } finally {await manager.dispose();}
});

it('fences stale configuration in the same transaction as findings and the watermark', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), configs = new DreamConfigStore(fs), evidence = new DreamEvidenceStore(fs);
        const config = {name: 'Dream', enabled: true, files: []};
        await configs.save('owner', 'dream', 'first', null, config, allow);
        const hash = 'a'.repeat(64); await evidence.prepare('owner', 'dream', 'run', hash);
        await configs.save('owner', 'dream', 'second', 1, {...config, name: 'Changed'}, allow);
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'remote'};
        const batch = {status: 'ok' as const, items: ['source'], evidence: {sourceId: 'source', projectId: 'project', connectionId: 'connection',
            authority, startCursor: null, endCursor: 'next', version: 'v1', scanned: 1}};
        const findings = [{id: 'finding', sourceId: 'source', kind: 'fact' as const, content: 'result'}];
        await expect(evidence.settle('owner', 'dream', 'run', [batch], findings,
            {scanRunId: 'scan', sessionId: 'session', taskId: 'task'}, hash, 1)).rejects.toThrow('DREAM_CONFIG_CONFLICT');
        expect(await evidence.run('owner', 'dream', 'run')).toBeNull();
        expect(await evidence.finding('owner', 'dream', 'finding')).toBeNull();
        expect(await evidence.watermark('owner', 'dream', 'source')).toBeNull();
    } finally {await manager.dispose();}
});

it('reserves stable file and scanner identities across retries and configuration revisions', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamConfigStore(fs);
        await store.save('owner', 'dream', 'create', null, {name: 'Dream', enabled: true, files: []}, allow);
        const fingerprint = 'a'.repeat(64), first = await store.reserveFile('owner', 'dream', 'add', 1, fingerprint);
        await store.reserveBatch('owner', 'dream', 'batch', 1);
        await store.reserveBatch('owner', 'dream', 'batch', 1);
        expect(await store.reserveFile('owner', 'dream', 'add', 1, fingerprint)).toEqual(first);
        await expect(store.reserveFile('owner', 'dream', 'add', 1, 'b'.repeat(64))).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        await store.save('owner', 'dream', 'update', 1, {name: 'Renamed', enabled: true, files: []}, allow);
        await expect(store.reserveBatch('owner', 'dream', 'batch', 2)).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        expect(await store.reserveFile('owner', 'dream', 'add', 1, fingerprint)).toEqual(first);
        await expect(store.reserveFile('owner', 'dream', 'other', 1, fingerprint)).rejects.toThrow('DREAM_CONFIG_CONFLICT');
    } finally {await manager.dispose();}
});

it('fences a fixed single-concurrency schedule with the configuration transaction', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamConfigStore(fs);
        const schedule = {state: 'active' as const, firstAt: Date.now() + 60_000, timeZone: 'UTC',
            cadence: {kind: 'interval' as const, milliseconds: 60_000}, trigger: 'fixed' as const, maxConcurrency: 1};
        const config = {name: 'Dream', enabled: true, files: [], schedule};
        await store.save('owner', 'dream', 'create', null, config, allow);
        const row = JSON.parse((await fs.meta.seq!.getEntry(DREAM_SCHEDULE_INDEX, dreamScheduleKey('owner', 'dream')))!);
        expect(row).toMatchObject({owner: 'owner', dream: 'dream', enabled: true, configRevision: 1, nextAt: schedule.firstAt});
        await store.save('owner', 'dream', 'pause', 1, {...config, enabled: false}, allow);
        expect(JSON.parse((await fs.meta.seq!.getEntry(DREAM_SCHEDULE_INDEX, dreamScheduleKey('owner', 'dream')))!) )
            .toMatchObject({enabled: false, configRevision: 2, nextAt: schedule.firstAt});
        await expect(store.save('owner', 'dream', 'invalid', 2, {...config, schedule: {...schedule, maxConcurrency: 2}}, allow))
            .rejects.toThrow('DREAM_SCHEDULE_INVALID');
        expect((await store.read('owner', 'dream'))?.revision).toBe(2);
    } finally {await manager.dispose();}
});
