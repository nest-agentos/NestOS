import {ConsolidationStore, MemoryCommitStore, ProposalStore, type CapturedEvidence, type MemoryProposal} from '@nestos/dream/vfs';
import type {SourceAuthority} from '@nestos/dream';
import type {IFileSystem, ISeqFileTransaction} from '@nestos/vfs-core';
import {createModuleLogger, sha256HexSync} from '@nestos/common';

export type ProposalDraft = Pick<MemoryProposal, 'id' | 'targetId' | 'status' | 'affectedMemoryIds' | 'changes' | 'constraint'>;
export interface ConsolidationModel {
    /** The operation ID is a stable submission identity and must be reused when recovering an unknown result. */
    run(input: {operationId: string; evidence: CapturedEvidence | CapturedEvidence[]; memory: Awaited<ReturnType<MemoryCommitStore['active']>>;
        pending: MemoryProposal[]; requiredScopes: string[]; focus?: string}): Promise<ProposalDraft[]>;
}
export interface ConsolidationAuthorization {
    evidence(value: CapturedEvidence): Promise<SourceAuthority>;
    evidenceScope(value: CapturedEvidence): string;
    scopes(scopes: readonly string[]): Promise<void>;
    transaction?(tx: Pick<ISeqFileTransaction, 'getEntry'>): Promise<void>;
}
export interface ConsolidationRequest {operationId: string; captureOperationId: string; scope: string; scopes: string[]; permittedScopes?: string[]; pendingIds?: string[]; focus?: string}
export interface ConsolidationBatchRequest {operationId: string; captureOperationIds: string[]; scope: string; receiptScope?: string; expectedVersion?: string | null; permittedScopes: string[]; focus?: string}
const log = createModuleLogger('dream-consolidation');
const key = (id: string) => `consolidation-result:${JSON.stringify(id)}`;
const valid = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

/** The host supplies the actual model transport and authorizes each restricted input. */
export class DreamConsolidationService {
    private readonly ledger: ConsolidationStore;
    private readonly proposals: ProposalStore;
    private readonly memory: MemoryCommitStore;
    constructor(private readonly fs: IFileSystem, private readonly path: string, private readonly model: ConsolidationModel,
        private readonly authorization: ConsolidationAuthorization) {
        const transaction = <T>(action: (tx: ISeqFileTransaction) => Promise<T>) => fs.meta.seq!.transaction!(action);
        this.ledger = new ConsolidationStore(transaction, path);
        this.proposals = new ProposalStore(transaction, path);
        this.memory = new MemoryCommitStore(transaction, path);
    }

    async run(request: ConsolidationRequest): Promise<MemoryProposal[]> {
        const started = Date.now(); let stage = 'validate';
        try {
            validateRequest(request);
            stage = 'authorize';
            const evidence = await this.ledger.readOperation(request.captureOperationId, item => this.authorization.evidence(item));
            const reference = await this.ledger.operationReference(request.captureOperationId);
            if (!evidence || !reference) throw new Error('DREAM_EVIDENCE_MISSING');
            if (sha256HexSync(evidence.snapshot) !== evidence.fingerprint) throw new Error('DREAM_CAPTURE_INVALID');
            const evidenceScope = this.authorization.evidenceScope(evidence);
            if (!valid(evidenceScope) || !request.scopes.includes(evidenceScope)) throw new Error('DREAM_AUTHORIZATION_DENIED');
            const permitted = new Set(request.permittedScopes ?? request.scopes);
            const receipt = await this.ledger.receipt(request.scope, reference.source, reference.sequence);
            if (receipt && ['consolidated_no_op', 'consolidated_proposed'].includes(receipt.status)) {
                const result = await this.replay(receipt.operationId!);
                if (result.some(item => item.requiredScopes.some(scope => !permitted.has(scope)))) throw new Error('DREAM_CONTEXT_SCOPE_EXCLUDED');
                return result;
            }
            log.info('dream.consolidation.step', {operationId: request.operationId, stage: 'inputs', result: 'started', durationMs: Date.now() - started});
            const memory = await this.memory.active(async scopes => {
                if (scopes.some(scope => !permitted.has(scope))) throw new Error('DREAM_CONTEXT_SCOPE_EXCLUDED');
                await this.authorization.scopes(scopes);
            }).catch(error => {
                if (error instanceof Error && error.message === 'DREAM_CONTEXT_SCOPE_EXCLUDED') return null;
                throw error;
            });
            const activeVersion = await this.fs.meta.seq!.transaction!(tx => tx.getEntry(this.path, 'active-version'));
            if (memory && memory.version !== activeVersion) throw new Error('DREAM_VERSION_CONFLICT');
            const pending = request.pendingIds ? await this.readPending(request.pendingIds, permitted) : await this.visiblePending(request.scope, permitted);
            const scopes = [...new Set([...request.scopes, ...(memory?.requiredScopes ?? []), ...pending.flatMap(item => item.requiredScopes)])].sort();
            await this.authorization.scopes(scopes);
            await this.prepare(request, evidence, activeVersion, pending, scopes);
            stage = 'model';
            log.info('dream.consolidation.step', {operationId: request.operationId, stage, result: 'started', durationMs: Date.now() - started});
            const drafts = await this.model.run({operationId: request.operationId, evidence, memory, pending, requiredScopes: scopes,
                ...(request.focus !== undefined ? {focus: request.focus} : {})});
            const records = materialize(request, evidence.id, scopes, pending, drafts);
            stage = 'reauthorize';
            const currentEvidence = await this.ledger.readOperation(request.captureOperationId, item => this.authorization.evidence(item));
            if (!currentEvidence) throw new Error('DREAM_EVIDENCE_MISSING');
            if (JSON.stringify(currentEvidence) !== JSON.stringify(evidence)) throw new Error('DREAM_CAPTURE_INVALID');
            await this.authorization.scopes(scopes);
            stage = 'commit';
            await this.settle(request, reference, receipt?.revision ?? 0, records, activeVersion, pending, evidence);
            log.info('dream.consolidation', {operationId: request.operationId, stage, result: 'success', count: records.length, durationMs: Date.now() - started});
            return this.replay(request.operationId);
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message
                : stage === 'model' ? 'DREAM_CONSOLIDATION_MODEL_FAILED' : stage === 'commit' ? 'DREAM_CONSOLIDATION_COMMIT_FAILED'
                    : stage === 'authorize' || stage === 'reauthorize' ? 'DREAM_AUTHORIZATION_UNAVAILABLE' : 'DREAM_CONSOLIDATION_FAILED';
            log.warn('dream.consolidation', {operationId: valid(request.operationId) ? request.operationId : 'invalid', stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }

    async read(id: string): Promise<MemoryProposal | null> {
        return this.proposals.read(id, scopes => this.authorization.scopes(scopes));
    }

    async runBatch(request: ConsolidationBatchRequest): Promise<MemoryProposal[]> {
        if (!valid(request.operationId) || !valid(request.scope) || !Array.isArray(request.captureOperationIds)
            || !request.captureOperationIds.length || request.captureOperationIds.length > 32
            || new Set(request.captureOperationIds).size !== request.captureOperationIds.length
            || request.captureOperationIds.some(id => !valid(id)) || !Array.isArray(request.permittedScopes) || !request.permittedScopes.length
            || request.permittedScopes.length > 32 || new Set(request.permittedScopes).size !== request.permittedScopes.length
            || request.permittedScopes.some(id => !valid(id)) || request.receiptScope !== undefined && !valid(request.receiptScope)
            || request.expectedVersion !== undefined && request.expectedVersion !== null && !valid(request.expectedVersion)
            || request.focus !== undefined && (typeof request.focus !== 'string' || request.focus.length > 2000)) throw new Error('DREAM_CONSOLIDATION_INVALID');
        const permitted = new Set(request.permittedScopes), captured: Array<{operation: string; evidence: CapturedEvidence;
            reference: {source: [string, string, string]; sequence: number}; revision: number}> = [];
        for (const operation of request.captureOperationIds) {
            const evidence = await this.ledger.readOperation(operation, item => this.authorization.evidence(item));
            const reference = await this.ledger.operationReference(operation);
            if (!evidence || !reference) throw new Error('DREAM_EVIDENCE_MISSING');
            if (sha256HexSync(evidence.snapshot) !== evidence.fingerprint) throw new Error('DREAM_CAPTURE_INVALID');
            if (!permitted.has(this.authorization.evidenceScope(evidence))) throw new Error('DREAM_AUTHORIZATION_DENIED');
            const receipt = await this.ledger.receipt(request.receiptScope ?? request.scope, reference.source, reference.sequence);
            if (receipt && ['consolidated_no_op', 'consolidated_proposed'].includes(receipt.status)) continue;
            captured.push({operation, evidence, reference, revision: receipt?.revision ?? 0});
        }
        if (!captured.length) return [];
        const memory = await this.memory.active(async scopes => {
            if (scopes.some(scope => !permitted.has(scope))) throw new Error('DREAM_CONTEXT_SCOPE_EXCLUDED');
            await this.authorization.scopes(scopes);
        }).catch(error => {if (error instanceof Error && error.message === 'DREAM_CONTEXT_SCOPE_EXCLUDED') return null; throw error;});
        const version = await this.fs.meta.seq!.transaction!(tx => tx.getEntry(this.path, 'active-version'));
        if (request.expectedVersion !== undefined && request.expectedVersion !== version) throw new Error('DREAM_VERSION_CONFLICT');
        if (memory && memory.version !== version) throw new Error('DREAM_VERSION_CONFLICT');
        const pending = await this.visiblePending(request.scope, permitted);
        const scopes = [...new Set([...captured.map(item => this.authorization.evidenceScope(item.evidence)),
            ...(memory?.requiredScopes ?? []), ...pending.flatMap(item => item.requiredScopes)])].sort();
        await this.authorization.scopes(scopes);
        const intent = sha256HexSync(JSON.stringify({request, evidence: captured.map(item => [item.evidence.id, item.evidence.fingerprint]),
            version, pending: pending.map(item => [item.id, item.revision]), scopes}));
        await this.fs.meta.seq!.transaction!(async tx => {
            const intentKey = `consolidation-intent:${JSON.stringify(request.operationId)}`, previous = await tx.getEntry(this.path, intentKey);
            if (previous && previous !== intent) throw new Error('DREAM_OPERATION_CONFLICT');
            if (!previous) await tx.setEntry(this.path, intentKey, intent);
        });
        const drafts = await this.model.run({operationId: request.operationId, evidence: captured.map(item => item.evidence), memory, pending,
            requiredScopes: scopes, ...(request.focus !== undefined ? {focus: request.focus} : {})});
        const records = materialize({...request, captureOperationId: request.captureOperationIds[0], scopes}, captured.map(item => item.evidence.id), scopes, pending, drafts);
        for (const item of captured) {
            const current = await this.ledger.readOperation(item.operation, evidence => this.authorization.evidence(evidence));
            if (!current) throw new Error('DREAM_EVIDENCE_MISSING');
            if (JSON.stringify(current) !== JSON.stringify(item.evidence)) throw new Error('DREAM_CAPTURE_INVALID');
        }
        await this.authorization.scopes(scopes);
        await this.ledger.completeMany(request.receiptScope ?? request.scope, captured.map(item => ({...item.reference, expectedRevision: item.revision})),
            records.length ? 'consolidated_proposed' : 'consolidated_no_op', request.operationId, async tx => {
                await this.authorization.transaction?.(tx);
                for (const item of captured) await assertCaptured(tx, this.path, item.reference, item.evidence);
                if ((await tx.getEntry(this.path, 'active-version') ?? null) !== version) throw new Error('DREAM_VERSION_CONFLICT');
                for (const item of pending) if (await tx.getEntry(this.path, `proposal:${JSON.stringify([item.id])}`) !== JSON.stringify(item))
                    throw new Error('DREAM_PROPOSAL_CONFLICT');
                for (const item of records) await this.proposals.putInTransaction(tx, item, pending.find(old => old.id === item.id)?.revision ?? null);
                await tx.setEntry(this.path, key(request.operationId), JSON.stringify(records.map(item => item.id)));
            });
        return this.replay(request.operationId);
    }

    private async readPending(ids: string[], permitted: ReadonlySet<string>): Promise<MemoryProposal[]> {
        const items: MemoryProposal[] = [];
        for (const id of ids) {
            const item = await this.read(id);
            if (!item || !['ready', 'conflict'].includes(item.status) || item.requiredScopes.some(scope => !permitted.has(scope))) throw new Error('DREAM_PROPOSAL_MISSING');
            items.push(item);
        }
        return items;
    }

    private async visiblePending(scope: string, permitted: ReadonlySet<string>): Promise<MemoryProposal[]> {
        const page = await this.proposals.listPending(scope, undefined, 100, async scopes => {
            if (scopes.some(value => !permitted.has(value))) return false;
            try {await this.authorization.scopes(scopes); return true;}
            catch (error) {
                if (error instanceof Error && ['DREAM_AUTHORIZATION_DENIED', 'DREAM_AUTHORIZATION_CHANGED'].includes(error.message)) return false;
                throw error;
            }
        });
        if (page.nextCursor) throw new Error('DREAM_CONSOLIDATION_PENDING_LIMIT');
        return page.items;
    }

    private async replay(operationId: string): Promise<MemoryProposal[]> {
        const raw = await this.fs.meta.seq!.getEntry(this.path, key(operationId));
        if (!raw) throw new Error('DREAM_CONSOLIDATION_RECEIPT_INVALID');
        const ids = JSON.parse(raw) as string[];
        if (!Array.isArray(ids) || ids.some(id => !valid(id))) throw new Error('DREAM_CONSOLIDATION_RECEIPT_INVALID');
        const result = [];
        for (const id of ids) {const item = await this.read(id); if (!item) throw new Error('DREAM_PROPOSAL_MISSING'); result.push(item);}
        return result;
    }

    private async settle(request: ConsolidationRequest, reference: {source: [string, string, string]; sequence: number}, revision: number,
        records: MemoryProposal[], version: string | null, pending: MemoryProposal[], evidence: CapturedEvidence): Promise<void> {
        const status = records.length ? 'consolidated_proposed' : 'consolidated_no_op';
        await this.ledger.complete(request.scope, reference.source, reference.sequence, revision, status, request.operationId, async tx => {
            await this.authorization.transaction?.(tx);
            await assertCaptured(tx, this.path, reference, evidence);
            if ((await tx.getEntry(this.path, 'active-version') ?? null) !== version) throw new Error('DREAM_VERSION_CONFLICT');
            for (const item of pending) {
                const raw = await tx.getEntry(this.path, `proposal:${JSON.stringify([item.id])}`);
                if (raw !== JSON.stringify(item)) throw new Error('DREAM_PROPOSAL_CONFLICT');
            }
            for (const item of records) await this.proposals.putInTransaction(tx, item, pending.find(old => old.id === item.id)?.revision ?? null);
            await tx.setEntry(this.path, key(request.operationId), JSON.stringify(records.map(item => item.id)));
        });
    }

    private async prepare(request: ConsolidationRequest, evidence: CapturedEvidence, version: string | null,
        pending: MemoryProposal[], scopes: string[]): Promise<void> {
        const intent = sha256HexSync(JSON.stringify({request, evidenceId: evidence.id, fingerprint: evidence.fingerprint,
            version, pending: pending.map(item => [item.id, item.revision]), scopes}));
        await this.fs.meta.seq!.transaction!(async tx => {
            const intentKey = `consolidation-intent:${JSON.stringify(request.operationId)}`;
            const previous = await tx.getEntry(this.path, intentKey);
            if (previous && previous !== intent) throw new Error('DREAM_OPERATION_CONFLICT');
            if (!previous) await tx.setEntry(this.path, intentKey, intent);
        });
    }
}

async function assertCaptured(tx: Pick<ISeqFileTransaction, 'getEntry'>, path: string, reference: {source: [string, string, string]; sequence: number},
    expected: CapturedEvidence): Promise<void> {
    const raw = await tx.getEntry(path, `evidence:${JSON.stringify([...reference.source, reference.sequence])}`);
    if (!raw) throw new Error('DREAM_EVIDENCE_MISSING');
    let value: {evidence?: unknown; sequence?: unknown};
    try {value = JSON.parse(raw) as typeof value;} catch {throw new Error('DREAM_CAPTURE_INVALID');}
    if (value.sequence !== reference.sequence || JSON.stringify(value.evidence) !== JSON.stringify(expected)) throw new Error('DREAM_CAPTURE_INVALID');
}

function validateRequest(request: ConsolidationRequest): void {
    if (!request || ![request.operationId, request.captureOperationId, request.scope].every(valid) || !Array.isArray(request.scopes)
        || !request.scopes.length || request.scopes.length > 32 || request.scopes.some(scope => !valid(scope))
        || request.permittedScopes !== undefined && (!Array.isArray(request.permittedScopes) || !request.permittedScopes.length
            || request.permittedScopes.length > 32 || request.permittedScopes.some(scope => !valid(scope))
            || new Set(request.permittedScopes).size !== request.permittedScopes.length || request.scopes.some(scope => !request.permittedScopes!.includes(scope)))
        || request.focus !== undefined && (typeof request.focus !== 'string' || request.focus.length > 2000)
        || request.pendingIds !== undefined && (!Array.isArray(request.pendingIds) || request.pendingIds.length > 100
            || request.pendingIds.some(id => !valid(id)) || new Set(request.pendingIds).size !== request.pendingIds.length))
        throw new Error('DREAM_CONSOLIDATION_INVALID');
}

function materialize(request: ConsolidationRequest, evidenceId: string | string[], scopes: string[], pending: MemoryProposal[], drafts: ProposalDraft[]): MemoryProposal[] {
    if (!Array.isArray(drafts) || drafts.length > 32 || new Set(drafts.map(item => item.id)).size !== drafts.length)
        throw new Error('DREAM_CONSOLIDATION_INVALID');
    return drafts.map(item => {
        const old = pending.find(value => value.id === item.id);
        return {...item, scope: request.scope, revision: (old?.revision ?? 0) + 1, requiredScopes: scopes,
            evidenceIds: [...new Set([...(old?.evidenceIds ?? []), ...(Array.isArray(evidenceId) ? evidenceId : [evidenceId])])]};
    });
}
