import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {sha256HexSync} from '@nestos/common';

export interface DreamSessionMemory {owner: string; dream: string; runId: string; sourceIds: string[]; configRevision: number; revision: number;
    additional?: Array<{runId: string; sourceIds: string[]}>}
export type DreamSessionBinding = DreamSessionMemory | {revision: number; disabled: true};
const FILE = '/var/lib/dream/session-memory.seq';
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const key = (prefix: string, id: string) => `${prefix}:${JSON.stringify(id)}`;

/** Session routing contains only selected identities; memory content stays in the owner project. */
export class DreamSessionMemoryStore {
    constructor(private readonly fs: IFileSystem) {}
    async read(session: string): Promise<DreamSessionBinding | null> {
        if (!valid(session)) throw new Error('DREAM_SESSION_INVALID');
        if (!await this.fs.driver.exists(FILE)) return null;
        const raw = await this.fs.meta.seq!.getEntry(FILE, key('session', session)); return raw ? decode(raw) : null;
    }
    async unbind(session: string, operationId: string, expectedRevision: number): Promise<{revision: number}> {
        if (!valid(session) || !valid(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('DREAM_SESSION_INVALID');
        const fingerprint = sha256HexSync(JSON.stringify(['unbind', session, expectedRevision]));
        if (!await this.fs.driver.exists(FILE)) throw new Error('DREAM_SESSION_BINDING_CONFLICT');
        return this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = key('bind', operationId), previous = await tx.getEntry(FILE, receiptKey);
            if (previous) {
                const receipt = JSON.parse(previous) as {fingerprint: string; revision: number};
                if (receipt.fingerprint !== fingerprint) throw new Error('DREAM_OPERATION_CONFLICT');
                return {revision: receipt.revision};
            }
            const raw = await tx.getEntry(FILE, key('session', session)), current = raw ? decode(raw) : null;
            if (!current || current.revision !== expectedRevision || 'disabled' in current) throw new Error('DREAM_SESSION_BINDING_CONFLICT');
            const revision = current.revision + 1;
            await tx.setEntry(FILE, key('session', session), JSON.stringify({revision, disabled: true}));
            await tx.setEntry(FILE, receiptKey, JSON.stringify({fingerprint, revision})); return {revision};
        });
    }
    async bind(session: string, operationId: string, expectedRevision: number | null,
        input: Omit<DreamSessionMemory, 'revision'>): Promise<{revision: number}> {
        if (!valid(session) || !valid(operationId)) throw new Error('DREAM_SESSION_INVALID');
        const frozen = normalize(input), fingerprint = sha256HexSync(JSON.stringify([session, expectedRevision, frozen]));
        try {await this.fs.driver.createFile({parentPath: '/var/lib/dream', name: 'session-memory.seq', type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
        return this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = key('bind', operationId), rawReceipt = await tx.getEntry(FILE, receiptKey);
            if (rawReceipt) {
                const receipt = JSON.parse(rawReceipt) as {fingerprint: string; revision: number};
                if (receipt.fingerprint !== fingerprint) throw new Error('DREAM_OPERATION_CONFLICT');
                return {revision: receipt.revision};
            }
            const configPath = `/var/lib/projects/${frozen.owner}/dream/${frozen.dream}/config.seq`;
            const configRaw = await tx.getEntry(configPath, 'config');
            if (!configRaw || (JSON.parse(configRaw) as {revision?: number}).revision !== frozen.configRevision) throw new Error('DREAM_CONFIG_CONFLICT');
            const raw = await tx.getEntry(FILE, key('session', session)), current = raw ? decode(raw) : null;
            if ((current?.revision ?? null) !== expectedRevision) throw new Error('DREAM_SESSION_BINDING_CONFLICT');
            const revision = (current?.revision ?? 0) + 1;
            await tx.setEntry(FILE, key('session', session), JSON.stringify({...frozen, revision}));
            await tx.setEntry(FILE, receiptKey, JSON.stringify({fingerprint, revision})); return {revision};
        });
    }
}
function normalize(value: Omit<DreamSessionMemory, 'revision'>): Omit<DreamSessionMemory, 'revision'> {
    if (!value || !valid(value.owner) || !valid(value.dream) || !valid(value.runId) || !Number.isSafeInteger(value.configRevision) || value.configRevision < 1
        || !Array.isArray(value.sourceIds) || !value.sourceIds.length || value.sourceIds.length > 32
        || value.sourceIds.some(id => !valid(id)) || new Set(value.sourceIds).size !== value.sourceIds.length
        || value.additional !== undefined && (!Array.isArray(value.additional) || value.additional.length > 31)) throw new Error('DREAM_SESSION_INVALID');
    const seen = new Set([value.runId]);
    const additional = value.additional?.map(item => {
        if (!item || !valid(item.runId) || seen.has(item.runId) || !Array.isArray(item.sourceIds) || !item.sourceIds.length || item.sourceIds.length > 32
            || item.sourceIds.some(id => !valid(id)) || new Set(item.sourceIds).size !== item.sourceIds.length) throw new Error('DREAM_SESSION_INVALID');
        seen.add(item.runId); return {runId: item.runId, sourceIds: [...item.sourceIds]};
    });
    if (value.sourceIds.length + (additional?.reduce((sum, item) => sum + item.sourceIds.length, 0) ?? 0) > 32)
        throw new Error('DREAM_SESSION_INVALID');
    return {owner: value.owner, dream: value.dream, runId: value.runId, sourceIds: [...value.sourceIds], configRevision: value.configRevision,
        ...(additional?.length ? {additional} : {})};
}
function decode(raw: string): DreamSessionBinding {
    let value: DreamSessionBinding;
    try {value = JSON.parse(raw) as DreamSessionBinding;} catch {throw new Error('DREAM_SESSION_INVALID');}
    if (!Number.isSafeInteger(value?.revision) || value.revision < 1) throw new Error('DREAM_SESSION_INVALID');
    if ('disabled' in value) {if (value.disabled !== true) throw new Error('DREAM_SESSION_INVALID'); return {revision: value.revision, disabled: true};}
    return {...normalize(value), revision: value.revision};
}
