import {createModuleLogger, sha256HexSync} from '@nestos/common';
import {sessionDirectoryStorage, type SessionRepository} from '@nestos/llm-session';
import type {IFileSystem} from '@nestos/vfs-core';
import type {Kernel, TaskHandle} from '@nestos/durable-kernel';
import {validateRecurrence} from '@nestos/kanban/integration';
import {DREAM_SCHEDULE_INDEX, dreamScheduleKey, type DreamScheduleRow} from './config-store';
import {dreamScheduleProgram} from './schedule-program';

type Marker = NonNullable<DreamScheduleRow['tasks']>[number];
interface Options {
    fs: IFileSystem; kernel: Kernel; repository: SessionRepository;
    authorizeOwner(owner: string): Promise<void>; prepare(session: string): Promise<void>; recover(session: string): Promise<boolean>;
}
const log = createModuleLogger('dream-schedule');

/** Reconcile only indexed schedules, using the existing Session lease and durable Task identity. */
export class DreamScheduleManager {
    private readonly active = new Map<string, Promise<void>>();
    private cursor?: string;
    private stopped = false;
    constructor(private readonly options: Options) {}
    async hasSchedules(): Promise<boolean> {
        if (!await this.options.fs.driver.exists(DREAM_SCHEDULE_INDEX)) return false;
        let found = false;
        await this.options.fs.meta.seq!.walkEntries(DREAM_SCHEDULE_INDEX, () => {found = true; return false;}, {keyPrefix: 'schedule:', limit: 1});
        return found;
    }
    async scan(): Promise<void> {
        if (this.stopped || !await this.options.fs.driver.exists(DREAM_SCHEDULE_INDEX)) return;
        const entries: Array<{key: string; value: string}> = [];
        await this.options.fs.meta.seq!.walkEntries(DREAM_SCHEDULE_INDEX, entry => {entries.push(entry); return true;},
            {keyPrefix: 'schedule:', order: 'key', after: this.cursor, limit: 50});
        this.cursor = entries.length === 50 ? entries[entries.length - 1].key : undefined;
        for (const entry of entries) {
            if (this.stopped) return;
            let row: DreamScheduleRow;
            try {row = parse(entry.value);} catch {
                log.warn('dream.schedule.scan', {operationId: 'schedule-scan', stage: 'read', result: 'failure', code: 'DREAM_SCHEDULE_INVALID', durationMs: 0}); continue;
            }
            await this.reconcile(row.owner, row.dream).catch(() => {});
        }
    }
    async reconcile(owner: string, dream: string): Promise<void> {
        if (this.stopped) throw new Error('DREAM_HOST_CLOSED');
        const key = dreamScheduleKey(owner, dream), existing = this.active.get(key);
        if (existing) return existing;
        const work = this.reconcileOne(owner, dream).finally(() => this.active.delete(key));
        this.active.set(key, work); return work;
    }
    async quiesce(): Promise<void> {this.stopped = true; await Promise.allSettled(this.active.values());}
    private async reconcileOne(owner: string, dream: string): Promise<void> {
        const started = Date.now(), operationId = 'schedule-' + sha256HexSync(JSON.stringify([owner, dream])); let stage = 'read', revision: number | undefined;
        try {
            await this.options.authorizeOwner(owner);
            let row = await this.read(owner, dream); if (!row) return; revision = row.configRevision;
            if (!enabled(row) && !row.tasks?.length) return;
            const sessionId = 'dream-schedule-' + sha256HexSync(JSON.stringify([owner, dream]));
            stage = 'session'; await this.options.repository.ensureSession(sessionId, 'Dream schedule');
            await this.options.prepare(sessionId);
            if (!await this.options.recover(sessionId)) throw new Error('DREAM_SCHEDULE_LEASE_UNAVAILABLE');
            const session = await this.options.kernel.openSession(sessionId, sessionDirectoryStorage(sessionId));
            stage = 'stop-old';
            for (const marker of row.tasks ?? []) if (!wanted(row, marker)) {
                const task = await submit(session, marker);
                const status = (await task.status()).task.status;
                if (!['succeeded', 'failed', 'cancelled'].includes(status)) await task.cancel(undefined, {requestId: 'cancel-' + marker.revision});
                await task.wait({until: 'settled', timeoutMs: 5000});
                await this.remove(owner, dream, marker);
            }
            row = await this.read(owner, dream); if (!row || !enabled(row) || row.tasks?.some(marker => !wanted(row!, marker))) return;
            stage = 'reserve'; const marker = await this.reserve(row, sessionId);
            stage = 'submit'; const task = await submit(session, marker); await this.attach(owner, dream, marker, task.id);
            row = await this.read(owner, dream);
            if (row && wanted(row, marker)) {
                stage = 'start'; const status = (await task.status()).task.status;
                if (['succeeded', 'failed', 'cancelled'].includes(status)) throw new Error('DREAM_SCHEDULE_TASK_STOPPED');
                await task.start();
            }
            await this.diagnostic(owner, dream, undefined, marker.revision);
            log.info('dream.schedule.reconcile', {operationId, stage, result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SCHEDULE_RECONCILE_FAILED';
            if (revision !== undefined) await this.diagnostic(owner, dream, code, revision).catch(() => {});
            log.warn('dream.schedule.reconcile', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
        }
    }
    private async read(owner: string, dream: string): Promise<DreamScheduleRow | null> {
        const raw = await this.options.fs.meta.seq!.getEntry(DREAM_SCHEDULE_INDEX, dreamScheduleKey(owner, dream));
        return raw ? parse(raw) : null;
    }
    async status(owner: string, dream: string) {
        const row = await this.read(owner, dream);
        if (!row || row.removed && !row.tasks?.length) return null;
        const active = row.tasks?.find(item => wanted(row, item) && item.taskId);
        if (!enabled(row)) return {state: row.tasks?.length ? 'stopping' as const : 'paused' as const, nextAt: row.nextAt};
        if (row.diagnostic) return {state: 'error' as const, nextAt: row.nextAt, code: row.diagnostic.code};
        if (!active?.taskId) return {state: 'pending' as const, nextAt: row.nextAt};
        try {
            const task = await this.options.kernel.task(active.sessionId, active.taskId);
            const state = task.state as {last?: {scheduledAt: number; status: 'succeeded' | 'failed' | 'cancelled'; code?: string;
                failures?: Array<{sourceId: string; code: string}>}} | undefined;
            return {state: ['succeeded', 'failed', 'cancelled'].includes(task.status) ? 'error' as const
                : task.status === 'created' ? 'pending' as const : 'scheduled' as const,
                nextAt: row.nextAt, ...(['succeeded', 'failed', 'cancelled'].includes(task.status) ? {code: 'DREAM_SCHEDULE_TASK_STOPPED'} : {}),
                ...(state?.last ? {last: state.last} : {})};
        } catch {return {state: 'pending' as const, nextAt: row.nextAt, code: 'DREAM_SCHEDULE_STATUS_UNAVAILABLE'};}
    }
    private async diagnostic(owner: string, dream: string, code: string | undefined, revision: number): Promise<void> {
        await this.options.fs.meta.seq!.transaction!(async tx => {
            const key = dreamScheduleKey(owner, dream), raw = await tx.getEntry(DREAM_SCHEDULE_INDEX, key); if (!raw) return;
            const row = parse(raw); if (row.configRevision !== revision || row.diagnostic?.code === code || !row.diagnostic && !code) return;
            const {diagnostic: _previous, ...rest} = row;
            await tx.setEntry(DREAM_SCHEDULE_INDEX, key, JSON.stringify({...rest, ...(code ? {diagnostic: {code, at: Date.now()}} : {})}));
        });
    }
    private async reserve(row: DreamScheduleRow, sessionId: string): Promise<Marker> {
        return this.options.fs.meta.seq!.transaction!(async tx => {
            const key = dreamScheduleKey(row.owner, row.dream), current = parse((await tx.getEntry(DREAM_SCHEDULE_INDEX, key))!);
            if (current.configRevision !== row.configRevision || !enabled(current)) throw new Error('DREAM_CONFIG_CONFLICT');
            const old = current.tasks?.find(item => item.revision === current.configRevision); if (old) return old;
            if ((current.tasks?.length ?? 0) >= 32) throw new Error('DREAM_SCHEDULE_LIMIT');
            const marker: Marker = {revision: current.configRevision, sessionId, requestId: 'dream-schedule-' + current.configRevision,
                input: {owner: row.owner, dream: row.dream, configRevision: current.configRevision, schedule: current.recurrence, nextAt: current.nextAt}};
            await tx.setEntry(DREAM_SCHEDULE_INDEX, key, JSON.stringify({...current, tasks: [...current.tasks ?? [], marker]})); return marker;
        });
    }
    private async attach(owner: string, dream: string, marker: Marker, taskId: string): Promise<void> {
        await this.change(owner, dream, marker, item => {
            if (item.taskId && item.taskId !== taskId) throw new Error('DREAM_SCHEDULE_ID_CONFLICT');
            return {...item, taskId};
        });
    }
    private async remove(owner: string, dream: string, marker: Marker): Promise<void> {await this.change(owner, dream, marker, () => null);}
    private async change(owner: string, dream: string, marker: Marker, change: (value: Marker) => Marker | null): Promise<void> {
        await this.options.fs.meta.seq!.transaction!(async tx => {
            const key = dreamScheduleKey(owner, dream), raw = await tx.getEntry(DREAM_SCHEDULE_INDEX, key); if (!raw) return;
            const row = parse(raw), tasks = (row.tasks ?? []).flatMap(item => {
                if (item.revision !== marker.revision || item.requestId !== marker.requestId) return [item];
                const next = change(item); return next ? [next] : [];
            });
            if (row.removed && !tasks.length) await tx.deleteEntry(DREAM_SCHEDULE_INDEX, key);
            else if (JSON.stringify(row.tasks ?? []) !== JSON.stringify(tasks)) await tx.setEntry(DREAM_SCHEDULE_INDEX, key, JSON.stringify({...row, tasks}));
        });
    }
}
function enabled(row: DreamScheduleRow): boolean {return row.enabled && !row.removed && row.recurrence.state === 'active';}
function wanted(row: DreamScheduleRow, marker: Marker): boolean {return enabled(row) && marker.revision === row.configRevision;}
function parse(raw: string): DreamScheduleRow {
    let value: DreamScheduleRow;
    try {value = JSON.parse(raw) as DreamScheduleRow;} catch {throw new Error('DREAM_SCHEDULE_INVALID');}
    if (!value || typeof value.owner !== 'string' || typeof value.dream !== 'string' || !Number.isSafeInteger(value.configRevision)
        || !Number.isSafeInteger(value.nextAt) || value.nextAt < 0 || !value.recurrence || typeof value.enabled !== 'boolean'
        || value.tasks !== undefined && (!Array.isArray(value.tasks) || value.tasks.length > 32)) throw new Error('DREAM_SCHEDULE_INVALID');
    try {validateRecurrence(value.recurrence);} catch {throw new Error('DREAM_SCHEDULE_INVALID');}
    const sessionId = 'dream-schedule-' + sha256HexSync(JSON.stringify([value.owner, value.dream]));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.owner) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.dream)
        || value.configRevision < 1 || value.recurrence.trigger !== 'fixed' || value.recurrence.maxConcurrency !== 1
        || value.tasks?.some(item => !item || !Number.isSafeInteger(item.revision) || item.revision < 1 || item.sessionId !== sessionId
            || item.requestId !== 'dream-schedule-' + item.revision || !item.input || item.input.owner !== value.owner || item.input.dream !== value.dream
            || item.input.configRevision !== item.revision || !Number.isSafeInteger(item.input.nextAt) || item.input.nextAt < 0
            || item.taskId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(item.taskId))) throw new Error('DREAM_SCHEDULE_INVALID');
    for (const item of value.tasks ?? []) try {validateRecurrence(item.input.schedule);} catch {throw new Error('DREAM_SCHEDULE_INVALID');}
    return value;
}
async function submit(session: Awaited<ReturnType<Kernel['openSession']>>, marker: Marker): Promise<TaskHandle> {
    return session.submit({program: dreamScheduleProgram.manifest, requestId: marker.requestId, input: marker.input, deferStart: true});
}
