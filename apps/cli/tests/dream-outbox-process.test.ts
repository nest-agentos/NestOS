import {it, expect} from 'vitest';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

it('recovers committed Dream delivery across separate SQLite processes and deduplicates redelivery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-outbox-process-'));
    try {
        const ids: number[] = [];
        for (const phase of ['commit', 'deliver', 'redeliver']) {
            const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/dream-outbox-process.ts', root, phase],
                {cwd: process.cwd(), encoding: 'utf8', timeout: 30000});
            expect(child.status, child.stderr).toBe(0);
            const record = child.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(item => item.phase === phase);
            expect(record).toBeTruthy(); ids.push(record.pid);
        }
        expect(new Set(ids).size).toBe(3);
    } finally {await rm(root, {recursive: true, force: true});}
}, 120000);

it('restarts the persistent host after pointer switch and delivers both results once', async () => {
    const parent = path.resolve('../../_nestos/kanban/retained-environment'); await mkdir(parent, {recursive: true});
    const root = await mkdtemp(path.join(parent, 'dream-host-outbox-'));
    try {
        const ids: number[] = [];
        for (const phase of ['commit', 'deliver', 'redeliver']) {
            const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/dream-host-outbox-process.ts', root, phase],
                {cwd: process.cwd(), encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024});
            expect(child.status, child.stderr).toBe(0);
            const record = child.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(item => item.phase === phase);
            expect(record).toBeTruthy(); ids.push(record.pid);
        }
        expect(new Set(ids).size).toBe(3);
    } finally {await rm(root, {recursive: true, force: true});}
}, 160000);
