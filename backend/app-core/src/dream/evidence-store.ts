import type {IFileSystem} from '@nestos/vfs-core';
import {createModuleLogger, sha256HexSync} from '@nestos/common';
import {DreamEvidenceStore as VfsDreamEvidenceStore} from '@nestos/dream/vfs';
import type {DreamAdoptionRecord, DreamAdoptionRequest, DreamDecisionAdoptionRequest} from '@nestos/app-contracts/services';

export type {DreamExecutionReceipt, DreamFinding, DreamFindingView, DreamReview, Watermark} from '@nestos/dream/vfs';

const key = (name: string, id: string) => `${name}:${JSON.stringify(id)}`;
const identity = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const log = createModuleLogger('dream-memory');
const scopePath = (project: string, dream: string) => `/var/lib/projects/${project}/dream/${dream}`;

export class DreamEvidenceStore extends VfsDreamEvidenceStore {
    constructor(fs: IFileSystem) {
        super(fs, {
            evidencePath: (project, dream) => scopePath(project, dream) + '/evidence.seq',
            readConfigRevision: async (reader, project, dream) => {
                const raw = await reader.getEntry(scopePath(project, dream) + '/config.seq', 'config');
                return raw ? parseStored<{revision?: number} | null>(raw, 'DREAM_CONFIG_INVALID')?.revision : undefined;
            },
            sha256: sha256HexSync,
            log: (operation, event) => event.result === 'success' ? log.info(operation, event) : log.warn(operation, event),
        });
    }

    async prepareAdoption(request: DreamAdoptionRequest, configRevision: number): Promise<void> {
        await this.prepareAdoptionRecord({request, configRevision, state: 'prepared'});
    }
    async prepareDecisionAdoption(request: DreamDecisionAdoptionRequest, configRevision: number): Promise<void> {
        await this.prepareAdoptionRecord({kind: 'decision', request, configRevision, state: 'prepared'});
    }
    private async prepareAdoptionRecord(record: DreamAdoptionRecord): Promise<void> {
        const {request, configRevision} = record;
        const path = this.path(request.ownerProjectId, request.dreamId);
        if (!identity(request.operationId) || !identity(request.runId) || !identity(request.suggestionId)
            || JSON.stringify(request).length > 60_000 || !Number.isSafeInteger(configRevision) || configRevision < 1) throw new Error('DREAM_ADOPTION_INVALID');
        record = structuredClone(record);
        await this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = key('adoption', request.operationId), old = await tx.getEntry(path, receiptKey);
            if (old) {
                const saved = parseStored<DreamAdoptionRecord>(old, 'DREAM_ADOPTION_INVALID');
                if (saved.kind !== record.kind || JSON.stringify(saved.request) !== JSON.stringify(record.request) || saved.configRevision !== configRevision)
                    throw new Error('DREAM_OPERATION_CONFLICT');
                return;
            }
            await this.assertConfigRevision(tx, request.ownerProjectId, request.dreamId, configRevision);
            if (!await this.runContainsFinding(tx, request.ownerProjectId, request.dreamId, request.runId, request.suggestionId))
                throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
            const indexKey = key('adoptions', request.suggestionId), index = parseStored<string[]>(await tx.getEntry(path, indexKey) ?? '[]', 'DREAM_ADOPTION_INVALID');
            if (!Array.isArray(index) || index.length >= 100 || index.some(id => !identity(id))) throw new Error('DREAM_ADOPTION_LIMIT');
            await tx.setEntry(path, receiptKey, JSON.stringify(record));
            await tx.setEntry(path, indexKey, JSON.stringify([...index, request.operationId]));
        });
    }
    async completeAdoption(owner: string, dream: string, operationId: string, itemId: string): Promise<void> {
        await this.completeAdoptionRecord(owner, dream, operationId, itemId, false);
    }
    async completeDecisionAdoption(owner: string, dream: string, operationId: string, recordId: string): Promise<void> {
        await this.completeAdoptionRecord(owner, dream, operationId, recordId, true);
    }
    async adoptionReceipt(owner: string, dream: string, operationId: string): Promise<DreamAdoptionRecord | null> {
        if (!identity(operationId)) throw new Error('DREAM_ADOPTION_INVALID');
        const raw = await this.fs.meta.seq!.getEntry(this.path(owner, dream), key('adoption', operationId));
        return raw ? parseStored<DreamAdoptionRecord>(raw, 'DREAM_ADOPTION_INVALID') : null;
    }
    private async completeAdoptionRecord(owner: string, dream: string, operationId: string, id: string, decision: boolean): Promise<void> {
        if (!identity(operationId) || !identity(id)) throw new Error('DREAM_ADOPTION_INVALID');
        const path = this.path(owner, dream);
        await this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = key('adoption', operationId), raw = await tx.getEntry(path, receiptKey);
            if (!raw) throw new Error('DREAM_ADOPTION_INVALID');
            const record = parseStored<DreamAdoptionRecord>(raw, 'DREAM_ADOPTION_INVALID');
            const isDecision = record.kind === 'decision';
            if (isDecision !== decision || record.state === 'committed' && (isDecision ? record.recordId : record.itemId) !== id)
                throw new Error('DREAM_ADOPTION_RECEIPT_MISMATCH');
            if (record.state !== 'committed') await tx.setEntry(path, receiptKey,
                JSON.stringify({...record, state: 'committed', ...(isDecision ? {recordId: id} : {itemId: id})}));
        });
    }
    async adoptions(owner: string, dream: string, suggestionId: string): Promise<DreamAdoptionRecord[]> {
        if (!identity(suggestionId)) throw new Error('DREAM_ADOPTION_INVALID');
        const path = this.path(owner, dream); if (!await this.fs.driver.exists(path)) return [];
        const ids = parseStored<string[]>(await this.fs.meta.seq!.getEntry(path, key('adoptions', suggestionId)) ?? '[]', 'DREAM_ADOPTION_INVALID');
        if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !identity(id))) throw new Error('DREAM_ADOPTION_INVALID');
        const entries = await this.fs.meta.seq!.getEntries(path, ids.map(id => key('adoption', id)));
        return ids.map(id => {
            const record = parseStored<DreamAdoptionRecord>(entries[key('adoption', id)], 'DREAM_ADOPTION_INVALID');
            if (!record || record.request?.operationId !== id || record.request.suggestionId !== suggestionId
                || record.request.ownerProjectId !== owner || record.request.dreamId !== dream || !['prepared', 'committed'].includes(record.state)
                || record.state === 'committed' && !identity((record.kind === 'decision' ? record.recordId : record.itemId) ?? ''))
                throw new Error('DREAM_ADOPTION_INVALID');
            return record;
        });
    }
}

function parseStored<T>(raw: string, code: string): T {
    try {return JSON.parse(raw) as T;} catch {throw new Error(code);}
}
