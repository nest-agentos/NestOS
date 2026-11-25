import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {createModuleLogger, sha256HexSync} from '@nestos/common';
import {buildMemoryTopics, ConsolidationStore, DreamEvidenceStore as VfsDreamEvidenceStore, MemoryCommitStore, ProposalStore,
    type CapturedEvidence, type MemoryCandidate, type MemoryProposal, type ProposalChoice, type ProposalResolution} from '@nestos/dream/vfs';
import type {DreamAdoptionRecord, DreamAdoptionRequest, DreamDecisionAdoptionRequest} from '@nestos/app-contracts/services';
import type {SourceAuthority} from '@nestos/dream';
import {DreamConsolidationService, type ConsolidationAuthorization, type ConsolidationModel} from './consolidation';
import {DREAM_OUTBOX_INDEX, dreamOutboxKey} from './outbox-index';
export {DREAM_OUTBOX_INDEX, dreamOutboxKey} from './outbox-index';

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

    async captureEvidence(owner: string, dream: string, evidence: CapturedEvidence,
        previousCursor: string | null, nextCursor: string | null, operationId?: string): Promise<number> {
        const store = new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
        return store.capture(evidence, previousCursor, nextCursor, operationId);
    }

    async readCapturedEvidence(owner: string, dream: string, source: [string, string, string], sequence: number,
        authorize: (evidence: CapturedEvidence) => Promise<SourceAuthority>): Promise<CapturedEvidence | null> {
        const store = new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
        return store.read(source, sequence, authorize);
    }
    async readCapturedEvidenceById(owner: string, dream: string, source: [string, string, string], id: string,
        authorize: (evidence: CapturedEvidence) => Promise<SourceAuthority>) {
        return this.attempts(owner, dream).readById(source, id, authorize);
    }
    async proposal(owner: string, dream: string, id: string, authorize: (scopes: readonly string[]) => Promise<void>) {
        const path = this.path(owner, dream);
        if (!await this.fs.driver.exists(path)) return null;
        return new ProposalStore(operation => this.fs.meta.seq!.transaction!(operation), path).read(id, authorize);
    }

    async readCapturedOperation(owner: string, dream: string, operationId: string,
        authorize: (evidence: CapturedEvidence) => Promise<SourceAuthority>): Promise<CapturedEvidence | null> {
        const store = new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
        return store.readOperation(operationId, authorize);
    }

    async bindCapturedRun(owner: string, dream: string, operationId: string, runId: string): Promise<void> {
        const store = new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
        await store.bindOperationRun(operationId, runId);
    }

    async capturedRun(owner: string, dream: string, operationId: string): Promise<string | null> {
        const store = new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
        return store.operationRun(operationId);
    }

    private attempts(owner: string, dream: string) {
        return new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
    }
    scanAttempt(owner: string, dream: string, operationId: string) {return this.attempts(owner, dream).scanAttempt(operationId);}
    advanceScanAttempt(owner: string, dream: string, operationId: string, attempt: number, runId: string) {
        return this.attempts(owner, dream).advanceScanAttempt(operationId, attempt, runId);
    }
    bindScanAttempt(owner: string, dream: string, operationId: string, attempt: number, runId: string) {
        return this.attempts(owner, dream).bindScanAttempt(operationId, attempt, runId);
    }

    async latestCapturedOperation(owner: string, dream: string, sourceId: string): Promise<string | null> {
        const store = new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
        return store.latestSourceOperation(sourceId);
    }

    async pendingCapturedOperations(owner: string, dream: string, scope: string, source: [string, string, string], after: number, limit: number,
        authorize: (evidence: CapturedEvidence) => Promise<SourceAuthority>) {
        const store = new ConsolidationStore(operation => this.fs.meta.seq!.transaction!(operation), this.path(owner, dream));
        const page = await store.pendingOperations(scope, source, after, limit);
        for (let pass = 0; pass < 2; pass++) for (const item of page.items) {
            const evidence = await store.readOperation(item.operationId, authorize);
            if (!evidence) throw new Error('DREAM_EVIDENCE_MISSING');
            const reference = await store.operationReference(item.operationId);
            if (JSON.stringify([evidence.projectId, evidence.sourceType, evidence.sourceId]) !== JSON.stringify(source))
                throw new Error('DREAM_SOURCE_BINDING_CHANGED');
            if (!reference || reference.sequence !== item.sequence) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        }
        return page;
    }

    consolidationWatermark(owner: string, dream: string, scope: string, source: [string, string, string]) {
        return this.attempts(owner, dream).watermark(scope, source);
    }

    async activeMemoryScopes(owner: string, dream: string) {
        const path = this.path(owner, dream);
        if (!await this.fs.driver.exists(path)) return null;
        return new MemoryCommitStore(operation => this.fs.meta.seq!.transaction!(operation), path).activeScopes();
    }
    async pendingMemoryScopes(owner: string, dream: string): Promise<string[][]> {
        const path = this.path(owner, dream);
        if (!await this.fs.driver.exists(path)) return [];
        return new ProposalStore(operation => this.fs.meta.seq!.transaction!(operation), path).pendingScopes();
    }

    consolidation(owner: string, dream: string, model: ConsolidationModel, authorization: ConsolidationAuthorization, configRevision?: number): DreamConsolidationService {
        return new DreamConsolidationService(this.fs, this.path(owner, dream), model, {...authorization,
            ...(configRevision !== undefined ? {transaction: tx => this.assertConfigRevision(tx, owner, dream, configRevision)} : {})});
    }

    consolidationPath(owner: string, dream: string): string {return this.path(owner, dream);}

    async pendingProposals(owner: string, dream: string, scope: string, after: string | undefined,
        visible: (scopes: readonly string[]) => Promise<boolean>) {
        const path = this.path(owner, dream);
        if (!await this.fs.driver.exists(path)) return {items: [], scanned: 0};
        return new ProposalStore(operation => this.fs.meta.seq!.transaction!(operation), path).listPending(scope, after, 50, visible);
    }

    async activeMemory(owner: string, dream: string, authorize: (scopes: readonly string[]) => Promise<void>) {
        const path = this.path(owner, dream);
        if (!await this.fs.driver.exists(path)) return null;
        return new MemoryCommitStore(operation => this.fs.meta.seq!.transaction!(operation), path).active(authorize);
    }

    async rollbackMemory(owner: string, dream: string, operationId: string, targetCommitId: string, expectedVersion: string,
        configRevision: number, authorize: (scopes: readonly string[]) => Promise<void>) {
        if (![operationId, targetCommitId, expectedVersion].every(identity)) throw new Error('DREAM_COMMIT_INVALID');
        const path = this.path(owner, dream), started = Date.now(), memory = new MemoryCommitStore(operation => this.fs.meta.seq!.transaction!(operation), path);
        const fingerprint = sha256HexSync(JSON.stringify([targetCommitId, expectedVersion]));
        try {
            const previous = await this.fs.meta.seq!.getEntry(path, key('rollback-receipt', operationId));
            if (previous) {
                if (previous !== fingerprint) throw new Error('DREAM_OPERATION_CONFLICT');
                const saved = await memory.committed(operationId, authorize);
                if (!saved) throw new Error('DREAM_REVIEW_RECEIPT_INVALID');
                await this.checkConfig(owner, dream, configRevision); return saved.event;
            }
            const target = await memory.committed(targetCommitId, authorize), active = await memory.active(authorize);
            if (!target) throw new Error('DREAM_COMMIT_MISSING');
            if (!active || active.version !== expectedVersion) throw new Error('DREAM_VERSION_CONFLICT');
            const requiredScopes = [...new Set([...active.requiredScopes, ...target.candidate.requiredScopes])].sort();
            const candidate: MemoryCandidate = {version: 'version-' + sha256HexSync(JSON.stringify([owner, dream, operationId])),
                parentVersion: expectedVersion, requiredScopes, topics: structuredClone(target.candidate.topics)};
            try {await this.fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});}
            catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
            await authorize(requiredScopes); await memory.stage(candidate); await authorize(requiredScopes);
            const event = await memory.commit(operationId, candidate.version, expectedVersion, async (tx, scopes) => {
                if (JSON.stringify(scopes) !== JSON.stringify(requiredScopes)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
                await this.assertConfigRevision(tx, owner, dream, configRevision);
            }, async (tx, _candidate, replay) => {
                if (replay) throw new Error('DREAM_REVIEW_RECEIPT_INVALID');
                const raw = await tx.getEntry(path, key('commit', targetCommitId));
                if (raw !== JSON.stringify(target.event) || await tx.getEntry(path, key('candidate', target.event.version)) !== JSON.stringify(target.candidate))
                    throw new Error('DREAM_VERSION_CONFLICT');
                await tx.setEntry(path, key('rollback-receipt', operationId), fingerprint);
                await tx.setEntry(path, key('rollback-target', operationId), targetCommitId);
                await tx.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey(owner, dream), JSON.stringify({owner, dream}));
            });
            log.info('dream.consolidation.rollback', {operationId, stage: 'commit', result: 'success', durationMs: Date.now() - started});
            return event;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_ROLLBACK_FAILED';
            log.warn('dream.consolidation.rollback', {operationId, stage: 'commit', result: 'failure', code, durationMs: Date.now() - started});
            if (error instanceof Error && code === error.message) throw error; throw new Error(code);
        }
    }

    async committedMemory(owner: string, dream: string, commitId: string, authorize: (scopes: readonly string[]) => Promise<void>) {
        const path = this.path(owner, dream);
        if (!await this.fs.driver.exists(path)) return null;
        return new MemoryCommitStore(operation => this.fs.meta.seq!.transaction!(operation), path).committed(commitId, authorize);
    }

    async resolveProposal(owner: string, dream: string, operationId: string, id: string, revision: number,
        resolution: ProposalResolution, configRevision: number, authorize: (scopes: readonly string[]) => Promise<void>) {
        const path = this.path(owner, dream), store = new ProposalStore(operation => this.fs.meta.seq!.transaction!(operation), path);
        const started = Date.now();
        try {
            const item = await store.read(id, authorize);
            if (!item) throw new Error('DREAM_PROPOSAL_MISSING');
            await authorize(item.requiredScopes);
            const result = await store.resolve(id, revision, resolution, async (tx, scopes) => {
                if (scopes.some(scope => !item.requiredScopes.includes(scope))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
                await this.assertConfigRevision(tx, owner, dream, configRevision);
            }, operationId);
            log.info('dream.consolidation.resolve', {operationId, stage: 'commit', result: 'success', durationMs: Date.now() - started});
            return result;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_RESOLUTION_FAILED';
            log.warn('dream.consolidation.resolve', {operationId, stage: 'commit', result: 'failure', code, durationMs: Date.now() - started});
            if (error instanceof Error && code === error.message) throw error;
            throw new Error(code);
        }
    }

    async commitProposals(owner: string, dream: string, operationId: string, expectedVersion: string | null,
        selected: ProposalChoice[], configRevision: number, authorize: (scopes: readonly string[]) => Promise<void>) {
        if (!identity(operationId) || !Array.isArray(selected) || !selected.length || selected.length > 50) throw new Error('DREAM_SELECTION_INVALID');
        const started = Date.now(), path = this.path(owner, dream), transaction = <T>(operation: (tx: import('@nestos/vfs-core').ISeqFileTransaction) => Promise<T>) =>
            this.fs.meta.seq!.transaction!(operation);
        const proposals = new ProposalStore(transaction, path), memory = new MemoryCommitStore(transaction, path);
        try {
            const prior = await proposals.receipt(operationId);
            if (prior) {
                if (prior.expectedVersion !== expectedVersion || JSON.stringify(prior.selected) !== JSON.stringify(selected)) throw new Error('DREAM_OPERATION_CONFLICT');
                await authorize(prior.event.requiredScopes); await this.checkConfig(owner, dream, configRevision);
                return prior.event;
            }
            const items: MemoryProposal[] = [];
            for (const choice of selected) {
                const item = await proposals.read(choice.id, authorize);
                if (!item) throw new Error('DREAM_PROPOSAL_MISSING');
                items.push(item);
            }
            const active = await memory.active(authorize);
            if ((active?.version ?? null) !== expectedVersion) throw new Error('DREAM_VERSION_CONFLICT');
            const time = await this.reserveReviewTime(owner, dream, operationId, expectedVersion, selected, configRevision);
            const candidate = reviewCandidate(owner, dream, operationId, active, items, time);
            try {await this.fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});}
            catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
            await authorize(candidate.requiredScopes); await memory.stage(candidate); await authorize(candidate.requiredScopes);
            await proposals.commit(operationId, candidate.version, expectedVersion, selected, new Set(candidate.requiredScopes), async (tx, scopes) => {
                if (JSON.stringify(scopes) !== JSON.stringify(candidate.requiredScopes)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
                await this.assertConfigRevision(tx, owner, dream, configRevision);
                await tx.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey(owner, dream), JSON.stringify({owner, dream}));
            });
            log.info('dream.consolidation.review', {operationId, stage: 'commit', result: 'success', count: selected.length, durationMs: Date.now() - started});
            return {commitId: operationId, version: candidate.version, requiredScopes: candidate.requiredScopes};
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_REVIEW_FAILED';
            log.warn('dream.consolidation.review', {operationId, stage: 'commit', result: 'failure', code, durationMs: Date.now() - started});
            if (error instanceof Error && code === error.message) throw error;
            throw new Error(code);
        }
    }

    private async reserveReviewTime(owner: string, dream: string, operationId: string, expectedVersion: string | null,
        selected: ProposalChoice[], configRevision: number): Promise<number> {
        const path = this.path(owner, dream), fingerprint = sha256HexSync(JSON.stringify([expectedVersion, selected, configRevision]));
        return this.fs.meta.seq!.transaction!(async tx => {
            await this.assertConfigRevision(tx, owner, dream, configRevision);
            const timeKey = key('review-time', operationId), raw = await tx.getEntry(path, timeKey);
            if (raw) {
                const value = parseStored<{fingerprint: string; time: number}>(raw, 'DREAM_REVIEW_RECEIPT_INVALID');
                if (value.fingerprint !== fingerprint || !Number.isSafeInteger(value.time) || value.time < 0) throw new Error('DREAM_OPERATION_CONFLICT');
                return value.time;
            }
            if ((await tx.getEntry(path, 'active-version') ?? null) !== expectedVersion) throw new Error('DREAM_VERSION_CONFLICT');
            const time = Date.now(); await tx.setEntry(path, timeKey, JSON.stringify({fingerprint, time})); return time;
        });
    }

    async prepareAdoption(request: DreamAdoptionRequest, configRevision: number): Promise<void> {
        await this.prepareAdoptionRecord({request, configRevision, state: 'prepared'});
    }
    async prepareDecisionAdoption(request: DreamDecisionAdoptionRequest, configRevision: number): Promise<void> {
        await this.prepareAdoptionRecord({kind: 'decision', request, configRevision, state: 'prepared'});
    }
    async prepareDownstreamDecisionAdoption(request: DreamDecisionAdoptionRequest, configRevision: number): Promise<void> {
        await this.prepareAdoptionRecord({kind: 'decision', request, configRevision, state: 'prepared'}, true);
    }
    private async prepareAdoptionRecord(record: DreamAdoptionRecord, downstream = false): Promise<void> {
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
            if (downstream) {
                const raw = await tx.getEntry(path, key('consumer-result:kanban', request.runId));
                const result = raw ? parseStored<{commitId: string; changes: Array<{id: string}>}>(raw, 'DREAM_OUTBOX_INVALID') : null;
                if (!result || result.commitId !== request.runId || !Array.isArray(result.changes)
                    || !result.changes.some(change => change.id === request.suggestionId)) throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
            } else if (!await this.runContainsFinding(tx, request.ownerProjectId, request.dreamId, request.runId, request.suggestionId))
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

function reviewCandidate(owner: string, dream: string, operationId: string, active: MemoryCandidate | null,
    proposals: MemoryProposal[], time: number): MemoryCandidate {
    const requiredScopes = [...new Set([...(active?.requiredScopes ?? []), ...proposals.flatMap(item => item.requiredScopes)])].sort();
    return {version: 'version-' + sha256HexSync(JSON.stringify([owner, dream, operationId])), parentVersion: active?.version ?? null,
        requiredScopes, topics: buildMemoryTopics(active?.topics ?? [], proposals, time)};
}
