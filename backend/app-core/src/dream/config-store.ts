import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {createModuleLogger, randomUUID, sha256HexSync} from '@nestos/common';
import type {DreamProjectFile} from './project-file-source';
import {validateChangeScope, type DreamChangeSource} from './change-source';
import type {KanbanRecurrence} from '@nestos/kanban/contracts';
import {nextRecurrence, validateRecurrence} from '@nestos/kanban/integration';

export interface DreamFileConfig extends DreamProjectFile {planId: string; planRevision: string; twinSourceId: string}
export interface DreamAdoptionSourceConfig {id: string; boardId: string; itemId: string}
export interface DreamDecisionSourceConfig {id: string; projectId: string; connectionId: string; boardId: string; recordId: string; scannerSourceId: string}
export interface DreamTaskSourceConfig {id: string; projectId: string; connectionId: string; boardId: string; itemId: string; scannerSourceId: string}
export interface DreamSessionSourceConfig {id: string; projectId: string; connectionId: string; sessionId: string; profileId?: string; maxRounds: number; scannerSourceId: string}
export type DreamChangeSourceConfig = DreamChangeSource;
export interface DreamConfig {name: string; enabled: boolean; files: DreamFileConfig[]; adoptions?: DreamAdoptionSourceConfig[]; decisions?: DreamDecisionSourceConfig[]; tasks?: DreamTaskSourceConfig[]; sessions?: DreamSessionSourceConfig[]; changes?: DreamChangeSourceConfig[]; schedule?: KanbanRecurrence}
export interface DreamConfigRecord {revision: number; config: DreamConfig}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const log = createModuleLogger('dream-config');
export const DREAM_SCHEDULE_INDEX = '/var/lib/dream/schedules.seq';
export const dreamScheduleKey = (owner: string, dream: string) => `schedule:${JSON.stringify([owner, dream])}`;
export interface DreamScheduleRow {owner: string; dream: string; configRevision: number; recurrence: KanbanRecurrence;
    enabled: boolean; removed?: boolean; nextAt: number; diagnostic?: {code: string; at: number}; tasks?: Array<{revision: number; sessionId: string; requestId: string;
        input: import('./schedule-program').DreamScheduleInput; taskId?: string}>}

/** Configuration belongs to the owner project; authorization is rechecked at execution. */
export class DreamConfigStore {
    constructor(private readonly fs: IFileSystem) {}
    async reserveFile(owner: string, dream: string, operationId: string, expectedRevision: number, fingerprint: string) {
        if (!validId(operationId) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('DREAM_INVALID_OPERATION');
        const path = configPath(owner, dream);
        if (!await this.fs.driver.exists(path)) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        return this.fs.meta.seq!.transaction!(async tx => {
            const key = `file-intent:${JSON.stringify(operationId)}`, raw = await tx.getEntry(path, key);
            if (raw) {
                const intent = JSON.parse(raw) as {fingerprint: string; expectedRevision: number; id: string; sourceId: string; planId: string};
                if (intent.fingerprint !== fingerprint || intent.expectedRevision !== expectedRevision) throw new Error('DREAM_OPERATION_CONFLICT');
                if (!validId(intent.id) || !validId(intent.sourceId) || !validId(intent.planId)) throw new Error('DREAM_CONFIG_INVALID');
                return intent;
            }
            if (decode(await tx.getEntry(path, 'config'))?.revision !== expectedRevision) throw new Error('DREAM_CONFIG_CONFLICT');
            const intent = {fingerprint, expectedRevision, id: randomUUID(), sourceId: randomUUID(), planId: randomUUID()};
            await tx.setEntry(path, key, JSON.stringify(intent)); return intent;
        });
    }
    async reserveBatch(owner: string, dream: string, operationId: string, revision: number): Promise<void> {
        if (!validId(operationId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('DREAM_INVALID_OPERATION');
        const path = configPath(owner, dream);
        await this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = `batch-intent:${JSON.stringify(operationId)}`, prior = await tx.getEntry(path, receiptKey);
            if (prior && prior !== String(revision)) throw new Error('DREAM_OPERATION_CONFLICT');
            if (decode(await tx.getEntry(path, 'config'))?.revision !== revision) throw new Error('DREAM_CONFIG_CONFLICT');
            if (!prior) await tx.setEntry(path, receiptKey, String(revision));
        });
    }
    async markSchedule(owner: string, dream: string, revision: number, nextAt: number): Promise<void> {
        if (!Number.isSafeInteger(nextAt) || nextAt < 0) throw new Error('DREAM_SCHEDULE_INVALID');
        await this.fs.meta.seq!.transaction!(async tx => {
            const key = dreamScheduleKey(owner, dream), raw = await tx.getEntry(DREAM_SCHEDULE_INDEX, key);
            if (!raw) throw new Error('DREAM_CONFIG_CONFLICT');
            const row = JSON.parse(raw) as DreamScheduleRow;
            if (row.owner !== owner || row.dream !== dream || row.configRevision !== revision || !row.enabled || row.recurrence.state !== 'active')
                throw new Error('DREAM_CONFIG_CONFLICT');
            if (nextAt > row.nextAt) await tx.setEntry(DREAM_SCHEDULE_INDEX, key, JSON.stringify({...row, nextAt}));
        });
    }
    async read(owner: string, dream: string): Promise<DreamConfigRecord | null> {
        const path = configPath(owner, dream);
        if (!await this.fs.driver.exists(path)) return null;
        return decode(await this.fs.meta.seq!.getEntry(path, 'config'));
    }
    async readRevision(owner: string, dream: string, revision: number): Promise<DreamConfigRecord | null> {
        const path = configPath(owner, dream);
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('DREAM_CONFIG_INVALID');
        if (!await this.fs.driver.exists(path)) return null;
        return decode(await this.fs.meta.seq!.getEntry(path, `revision:${revision}`));
    }
    async save(owner: string, dream: string, operationId: string, expectedRevision: number | null, config: DreamConfig,
        authorize: {owner(): Promise<void>; source(source: DreamFileConfig): Promise<void>; adoption?(source: DreamAdoptionSourceConfig): Promise<void>; decision?(source: DreamDecisionSourceConfig): Promise<void>; task?(source: DreamTaskSourceConfig): Promise<void>; session?(source: DreamSessionSourceConfig): Promise<void>; change?(source: DreamChangeSourceConfig): Promise<void>}): Promise<DreamConfigRecord> {
        const started = Date.now(); let stage = 'validate';
        try {
            if (!validId(operationId)) throw new Error('DREAM_INVALID_OPERATION');
            const path = configPath(owner, dream), frozen = normalize(config);
            stage = 'authorization';
            await authorize.owner();
            for (const file of frozen.files) await authorize.source({...file});
            const previous = await this.read(owner, dream);
            if (JSON.stringify(previous?.config.adoptions ?? []) !== JSON.stringify(frozen.adoptions ?? [])) {
                if (frozen.adoptions?.length && !authorize.adoption) throw new Error('DREAM_CONFIG_AUTHORIZATION_FAILED');
                for (const source of frozen.adoptions ?? []) await authorize.adoption!({...source});
            }
            if (JSON.stringify(previous?.config.decisions ?? []) !== JSON.stringify(frozen.decisions ?? [])) {
                if (frozen.decisions?.length && !authorize.decision) throw new Error('DREAM_CONFIG_AUTHORIZATION_FAILED');
                for (const source of frozen.decisions ?? []) await authorize.decision!({...source});
            }
            if (JSON.stringify(previous?.config.tasks ?? []) !== JSON.stringify(frozen.tasks ?? [])) {
                if (frozen.tasks?.length && !authorize.task) throw new Error('DREAM_CONFIG_AUTHORIZATION_FAILED');
                for (const source of frozen.tasks ?? []) await authorize.task!({...source});
            }
            if (JSON.stringify(previous?.config.sessions ?? []) !== JSON.stringify(frozen.sessions ?? [])) {
                if (frozen.sessions?.length && !authorize.session) throw new Error('DREAM_CONFIG_AUTHORIZATION_FAILED');
                for (const source of frozen.sessions ?? []) await authorize.session!({...source});
            }
            if (JSON.stringify(previous?.config.changes ?? []) !== JSON.stringify(frozen.changes ?? [])) {
                if (frozen.changes?.length && !authorize.change) throw new Error('DREAM_CONFIG_AUTHORIZATION_FAILED');
                for (const source of frozen.changes ?? []) await authorize.change!({...source});
            }
            stage = 'commit';
            const result = await this.write(path, owner, dream, operationId, expectedRevision, frozen);
            log.info('dream.config.save', {operationId, stage, result: 'success', count: frozen.files.length, durationMs: Date.now() - started});
            return result;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message
                : stage === 'authorization' ? 'DREAM_CONFIG_AUTHORIZATION_FAILED' : 'DREAM_CONFIG_SAVE_FAILED';
            log.warn('dream.config.save', {operationId: validId(operationId) ? operationId : 'invalid', stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    private async write(path: string, owner: string, dream: string, operationId: string, expectedRevision: number | null, frozen: DreamConfig): Promise<DreamConfigRecord> {
        try {await this.fs.driver.createFile({parentPath: path.slice(0, path.lastIndexOf('/')), name: 'config.seq', type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
        try {await this.fs.driver.createFile({parentPath: '/var/lib/dream', name: 'schedules.seq', type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
        return this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = `save:${JSON.stringify(operationId)}`;
            const fingerprint = sha256HexSync(JSON.stringify([expectedRevision, frozen]));
            const raw = await tx.getEntry(path, receiptKey);
            if (raw) {
                const receipt = JSON.parse(raw) as {fingerprint: string; result: DreamConfigRecord};
                if (receipt.fingerprint !== fingerprint) throw new Error('DREAM_OPERATION_CONFLICT');
                if (!receipt.result || !Number.isSafeInteger(receipt.result.revision) || receipt.result.revision < 1) throw new Error('DREAM_CONFIG_INVALID');
                return {revision: receipt.result.revision, config: normalize(receipt.result.config)};
            }
            const current = decode(await tx.getEntry(path, 'config'));
            if ((current?.revision ?? null) !== expectedRevision) throw new Error('DREAM_CONFIG_CONFLICT');
            for (const source of [...frozen.files, ...frozen.adoptions ?? [], ...frozen.decisions ?? [], ...frozen.tasks ?? []])
                if (await tx.getEntry(path, `session-binding:${JSON.stringify(source.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            for (const file of frozen.files)
                if (await tx.getEntry(path, `adoption-binding:${JSON.stringify(file.id)}`) || await tx.getEntry(path, `decision-binding:${JSON.stringify(file.id)}`) || await tx.getEntry(path, `task-binding:${JSON.stringify(file.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            for (const source of frozen.adoptions ?? []) {
                if (current?.config.files.some(file => file.id === source.id) || await tx.getEntry(path, `decision-binding:${JSON.stringify(source.id)}`) || await tx.getEntry(path, `task-binding:${JSON.stringify(source.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                const bindingKey = `adoption-binding:${JSON.stringify(source.id)}`, binding = JSON.stringify([source.boardId, source.itemId]);
                const previous = await tx.getEntry(path, bindingKey);
                if (previous && previous !== binding) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                if (!previous) await tx.setEntry(path, bindingKey, binding);
            }
            for (const source of frozen.decisions ?? []) {
                if (current?.config.files.some(file => file.id === source.id) || await tx.getEntry(path, `adoption-binding:${JSON.stringify(source.id)}`) || await tx.getEntry(path, `task-binding:${JSON.stringify(source.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                const bindingKey = `decision-binding:${JSON.stringify(source.id)}`;
                const binding = JSON.stringify([source.projectId, source.connectionId, source.boardId, source.recordId]);
                const previous = await tx.getEntry(path, bindingKey);
                if (previous && previous !== binding) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                if (!previous) await tx.setEntry(path, bindingKey, binding);
            }
            for (const source of frozen.tasks ?? []) {
                if (current?.config.files.some(file => file.id === source.id) || await tx.getEntry(path, `adoption-binding:${JSON.stringify(source.id)}`) || await tx.getEntry(path, `decision-binding:${JSON.stringify(source.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                const bindingKey = `task-binding:${JSON.stringify(source.id)}`, binding = JSON.stringify([source.projectId, source.connectionId, source.boardId, source.itemId]);
                const previous = await tx.getEntry(path, bindingKey);
                if (previous && previous !== binding) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                if (!previous) await tx.setEntry(path, bindingKey, binding);
            }
            for (const source of frozen.sessions ?? []) {
                if (current?.config.files.some(file => file.id === source.id) || await tx.getEntry(path, `adoption-binding:${JSON.stringify(source.id)}`)
                    || await tx.getEntry(path, `decision-binding:${JSON.stringify(source.id)}`) || await tx.getEntry(path, `task-binding:${JSON.stringify(source.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                const bindingKey = `session-binding:${JSON.stringify(source.id)}`, binding = JSON.stringify([source.projectId, source.connectionId, source.sessionId, source.maxRounds, ...(source.profileId ? [source.profileId] : [])]);
                const previous = await tx.getEntry(path, bindingKey);
                if (previous && previous !== binding) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                if (!previous) await tx.setEntry(path, bindingKey, binding);
            }
            for (const source of [...frozen.files, ...frozen.adoptions ?? [], ...frozen.decisions ?? [], ...frozen.tasks ?? [], ...frozen.sessions ?? []])
                if (await tx.getEntry(path, `change-binding:${JSON.stringify(source.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            for (const source of frozen.changes ?? []) {
                if (current?.config.files.some(file => file.id === source.id) || await tx.getEntry(path, `adoption-binding:${JSON.stringify(source.id)}`)
                    || await tx.getEntry(path, `decision-binding:${JSON.stringify(source.id)}`) || await tx.getEntry(path, `task-binding:${JSON.stringify(source.id)}`)
                    || await tx.getEntry(path, `session-binding:${JSON.stringify(source.id)}`)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                const key = `change-binding:${JSON.stringify(source.id)}`, binding = JSON.stringify([source.projectId, source.connectionId, source.directory, source.exclude, source.maxEntries]);
                const prior = await tx.getEntry(path, key);
                if (prior && prior !== binding) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
                if (!prior) await tx.setEntry(path, key, binding);
            }
            const next = {revision: (current?.revision ?? 0) + 1, config: frozen};
            await tx.setEntry(path, 'config', JSON.stringify(next));
            await tx.setEntry(path, `revision:${next.revision}`, JSON.stringify(next));
            await updateSchedule(tx, owner, dream, current?.config, next);
            await tx.setEntry(path, receiptKey, JSON.stringify({fingerprint, result: next})); return next;
        });
    }
}
async function updateSchedule(tx: import('@nestos/vfs-core').ISeqFileTransaction, owner: string, dream: string,
    previous: DreamConfig | undefined, next: DreamConfigRecord): Promise<void> {
    const key = dreamScheduleKey(owner, dream), raw = await tx.getEntry(DREAM_SCHEDULE_INDEX, key);
    const old = raw ? JSON.parse(raw) as DreamScheduleRow : undefined;
    if (!next.config.schedule && !old?.tasks?.length) {if (raw) await tx.deleteEntry(DREAM_SCHEDULE_INDEX, key); return;}
    const recurrence = next.config.schedule ?? old!.recurrence;
    const unchanged = old && JSON.stringify(previous?.schedule) === JSON.stringify(next.config.schedule);
    const row: DreamScheduleRow = {owner, dream, configRevision: next.revision, recurrence,
        enabled: next.config.enabled && !!next.config.schedule, ...(!next.config.schedule ? {removed: true} : {}),
        nextAt: unchanged || !next.config.schedule ? old!.nextAt : nextRecurrence(recurrence, Date.now() - 1), ...(old?.tasks?.length ? {tasks: old.tasks} : {})};
    await tx.setEntry(DREAM_SCHEDULE_INDEX, key, JSON.stringify(row));
}
function configPath(owner: string, dream: string): string {
    if (!validId(owner) || !validId(dream)) throw new Error('DREAM_INVALID_SCOPE');
    return `/var/lib/projects/${owner}/dream/${dream}/config.seq`;
}
function normalize(config: DreamConfig): DreamConfig {
    if (!config || typeof config.name !== 'string' || !config.name.trim() || config.name.length > 200
        || typeof config.enabled !== 'boolean' || !Array.isArray(config.files) || config.files.length > 32) throw new Error('DREAM_CONFIG_INVALID');
    const ids = new Set<string>();
    const files = config.files.map(file => {
        if (!file || !validId(file.id) || ids.has(file.id) || !validId(file.projectId) || !validId(file.connectionId)
            || !validId(file.planId) || !validId(file.twinSourceId) || typeof file.planRevision !== 'string' || !file.planRevision || file.planRevision.length > 256
            || file.capability !== 'fileRead' || typeof file.path !== 'string' || !file.path.startsWith('/') || file.path.length > 1000
            || /[\\\0]/.test(file.path) || file.path.split('/').slice(1).some(part => !part || part.startsWith('.'))) throw new Error('DREAM_CONFIG_INVALID');
        ids.add(file.id);
        return {id: file.id, projectId: file.projectId, connectionId: file.connectionId, capability: 'fileRead' as const,
            path: file.path, planId: file.planId, planRevision: file.planRevision, twinSourceId: file.twinSourceId};
    });
    let adoptions: DreamAdoptionSourceConfig[] | undefined;
    if (config.adoptions !== undefined) {
        if (!Array.isArray(config.adoptions) || config.adoptions.length + files.length > 32) throw new Error('DREAM_CONFIG_INVALID');
        const targets = new Set<string>();
        adoptions = config.adoptions.map(source => {
            if (!source || !validId(source.id) || ids.has(source.id) || !validId(source.boardId) || !validId(source.itemId)) throw new Error('DREAM_CONFIG_INVALID');
            const target = JSON.stringify([source.boardId, source.itemId]);
            if (targets.has(target)) throw new Error('DREAM_CONFIG_INVALID');
            ids.add(source.id); targets.add(target);
            return {id: source.id, boardId: source.boardId, itemId: source.itemId};
        });
    }
    let decisions: DreamDecisionSourceConfig[] | undefined;
    if (config.decisions !== undefined) {
        if (!Array.isArray(config.decisions) || config.decisions.length + files.length + (adoptions?.length ?? 0) > 32) throw new Error('DREAM_CONFIG_INVALID');
        const targets = new Set<string>();
        decisions = config.decisions.map(source => {
            if (!source || ![source.id, source.projectId, source.connectionId, source.boardId, source.recordId, source.scannerSourceId].every(validId)
                || ids.has(source.id) || !files.some(file => file.id === source.scannerSourceId)) throw new Error('DREAM_CONFIG_INVALID');
            const target = JSON.stringify([source.boardId, source.recordId]);
            if (targets.has(target)) throw new Error('DREAM_CONFIG_INVALID');
            ids.add(source.id); targets.add(target);
            return {id: source.id, projectId: source.projectId, connectionId: source.connectionId, boardId: source.boardId, recordId: source.recordId, scannerSourceId: source.scannerSourceId};
        });
    }
    let tasks: DreamTaskSourceConfig[] | undefined;
    if (config.tasks !== undefined) {
        if (!Array.isArray(config.tasks) || config.tasks.length + files.length + (adoptions?.length ?? 0) + (decisions?.length ?? 0) > 32) throw new Error('DREAM_CONFIG_INVALID');
        const targets = new Set<string>();
        tasks = config.tasks.map(source => {
            if (!source || ![source.id, source.projectId, source.connectionId, source.boardId, source.itemId, source.scannerSourceId].every(validId)
                || ids.has(source.id) || !files.some(file => file.id === source.scannerSourceId)) throw new Error('DREAM_CONFIG_INVALID');
            const target = JSON.stringify([source.boardId, source.itemId]);
            if (targets.has(target)) throw new Error('DREAM_CONFIG_INVALID');
            ids.add(source.id); targets.add(target);
            return {id: source.id, projectId: source.projectId, connectionId: source.connectionId, boardId: source.boardId, itemId: source.itemId, scannerSourceId: source.scannerSourceId};
        });
    }
    let sessions: DreamSessionSourceConfig[] | undefined;
    if (config.sessions !== undefined) {
        if (!Array.isArray(config.sessions) || config.sessions.length + files.length + (adoptions?.length ?? 0) + (decisions?.length ?? 0) + (tasks?.length ?? 0) > 32) throw new Error('DREAM_CONFIG_INVALID');
        const targets = new Set<string>();
        sessions = config.sessions.map(source => {
            if (!source || ![source.id, source.projectId, source.connectionId, source.sessionId, source.scannerSourceId].every(validId)
                || (source.connectionId === 'dream-local' ? source.profileId !== undefined : !validId(source.profileId))
                || !Number.isSafeInteger(source.maxRounds) || source.maxRounds < 1 || source.maxRounds > 20
                || ids.has(source.id) || !files.some(file => file.id === source.scannerSourceId)) throw new Error('DREAM_CONFIG_INVALID');
            const target = JSON.stringify([source.projectId, source.profileId ?? null, source.sessionId]); if (targets.has(target)) throw new Error('DREAM_CONFIG_INVALID');
            ids.add(source.id); targets.add(target);
            return {id: source.id, projectId: source.projectId, connectionId: source.connectionId, sessionId: source.sessionId, ...(source.profileId ? {profileId: source.profileId} : {}), maxRounds: source.maxRounds, scannerSourceId: source.scannerSourceId};
        });
    }
    let changes: DreamChangeSourceConfig[] | undefined;
    if (config.changes !== undefined) {
        if (!Array.isArray(config.changes) || config.changes.length + ids.size > 32) throw new Error('DREAM_CONFIG_INVALID');
        const targets = new Set<string>();
        changes = config.changes.map(source => {
            if (!source || ![source.id, source.projectId, source.connectionId, source.scannerSourceId].every(validId)
                || ids.has(source.id) || !files.some(file => file.id === source.scannerSourceId)) throw new Error('DREAM_CONFIG_INVALID');
            validateChangeScope(source);
            const target = JSON.stringify([source.projectId, source.directory]);
            if (targets.has(target)) throw new Error('DREAM_CONFIG_INVALID');
            targets.add(target); ids.add(source.id);
            return {id: source.id, projectId: source.projectId, connectionId: source.connectionId, scannerSourceId: source.scannerSourceId,
                directory: source.directory, exclude: [...source.exclude], maxEntries: source.maxEntries};
        });
    }
    let schedule: KanbanRecurrence | undefined;
    if (config.schedule !== undefined) {
        try {validateRecurrence(config.schedule);} catch {throw new Error('DREAM_SCHEDULE_INVALID');}
        if (config.schedule.trigger !== 'fixed' || config.schedule.maxConcurrency !== 1) throw new Error('DREAM_SCHEDULE_INVALID');
        schedule = structuredClone(config.schedule);
    }
    return {name: config.name.trim(), enabled: config.enabled, files, ...(adoptions ? {adoptions} : {}), ...(decisions ? {decisions} : {}), ...(tasks ? {tasks} : {}), ...(sessions ? {sessions} : {}), ...(changes ? {changes} : {}), ...(schedule ? {schedule} : {})};
}
export function validateDreamConfig(config: DreamConfig): DreamConfig {return normalize(config);}
function decode(raw: string | null): DreamConfigRecord | null {
    if (!raw) return null;
    let record: DreamConfigRecord;
    try {record = JSON.parse(raw) as DreamConfigRecord;} catch {throw new Error('DREAM_CONFIG_INVALID');}
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('DREAM_CONFIG_INVALID');
    return {revision: record.revision, config: normalize(record.config)};
}
