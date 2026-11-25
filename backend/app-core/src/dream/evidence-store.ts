import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {SourceEvidence, SourceScanResult} from '@nestos/dream';
import type {DreamAdoptionRecord, DreamAdoptionRequest, DreamDecisionAdoptionRequest} from '@nestos/app-contracts/services';

type Outcome = Omit<Extract<SourceScanResult<never>, {status: 'ok'}>, 'items'> | Exclude<SourceScanResult<never>, {status: 'ok'}>;
interface Run {operationId: string; outcomes: Outcome[]; findings?: string[]; execution?: DreamExecutionReceipt; requestHash?: string; configRevision?: number}
export interface DreamExecutionReceipt {scanRunId: string; sessionId: string; taskId: string}
export interface DreamFinding {id: string; sourceId: string; kind: 'fact' | 'inference' | 'suggestion'; content: string; quote?: string; subject?: string; project?: string; eventTime?: string; recordedAt?: number}
export interface DreamFindingView extends DreamFinding {revision: number; state: 'active' | 'disputed' | 'disabled'; origin: 'source' | 'user-correction'; updatedAt?: number}
export type DreamReview = {action: 'correct'; content: string; kind: 'fact' | 'inference'} | {action: 'dispute' | 'disable' | 'restore'};
interface DreamMerge {id: string; members: Array<{id: string; sourceId: string; revision: number}>; operationId: string}
export interface Watermark {projectId: string; connectionId: string; authority: SourceEvidence['authority']; cursor: string | null}
const key = (name: string, id: string) => `${name}:${JSON.stringify(id)}`;
const identity = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const log = createModuleLogger('dream-memory');

/** Atomic metadata receipts and source watermarks; source bodies never enter this store. */
export class DreamEvidenceStore {
    constructor(private readonly fs: IFileSystem) {}

    async prepare(projectId: string, dreamId: string, operationId: string, requestHash: string, sourceId?: string): Promise<void> {
        const path = this.path(projectId, dreamId);
        if (!identity(operationId) || !/^[a-f0-9]{64}$/.test(requestHash) || sourceId !== undefined && !identity(sourceId)) throw new Error('DREAM_REQUEST_INVALID');
        await this.create(path);
        await this.fs.meta.seq!.transaction!(async tx => {
            const previous = await tx.getEntry(path, key('intent', operationId));
            if (previous && previous !== requestHash) throw new Error('DREAM_OPERATION_CONFLICT');
            if (!previous) {
                await tx.setEntry(path, key('intent', operationId), requestHash);
                await addHistory(tx, path, operationId, sourceId);
            } else if (!await tx.getEntry(path, key('run', operationId))) {
                const raw = await tx.getEntry(path, key('run-state', operationId));
                if (!raw) throw new Error('DREAM_HISTORY_INVALID');
                const state = historyState(raw);
                if (state.sourceId !== sourceId) throw new Error('DREAM_OPERATION_CONFLICT');
                await tx.setEntry(path, key('run-state', operationId), JSON.stringify({startedAt: state.startedAt, state: 'prepared', ...(sourceId ? {sourceId} : {})}));
            }
        });
    }

    async fail(projectId: string, dreamId: string, operationId: string, code: string): Promise<void> {
        const path = this.path(projectId, dreamId);
        if (!identity(operationId) || !/^DREAM_[A-Z_]+$/.test(code)) throw new Error('DREAM_HISTORY_INVALID');
        await this.fs.meta.seq!.transaction!(async tx => {
            if (!await tx.getEntry(path, key('intent', operationId)) || await tx.getEntry(path, key('run', operationId))) return;
            const raw = await tx.getEntry(path, key('run-state', operationId));
            if (!raw) throw new Error('DREAM_HISTORY_INVALID');
            const state = historyState(raw);
            await tx.setEntry(path, key('run-state', operationId), JSON.stringify({startedAt: state.startedAt, state: 'failed', code, ...(state.sourceId ? {sourceId: state.sourceId} : {})}));
        });
    }

    async commit(projectId: string, dreamId: string, operationId: string, results: SourceScanResult<unknown>[]): Promise<void> {
        if (results.some(result => result.status === 'ok' && result.evidence.scanned > 0)) throw new Error('DREAM_SETTLEMENT_REQUIRED');
        await this.settle(projectId, dreamId, operationId, results, []);
    }

    /** Results and watermarks must be committed in the same transaction. */
    async settle(projectId: string, dreamId: string, operationId: string, results: SourceScanResult<unknown>[], findings: DreamFinding[], execution?: DreamExecutionReceipt, requestHash?: string, configRevision?: number): Promise<void> {
        const path = this.path(projectId, dreamId);
        if (!identity(operationId)) throw new Error('DREAM_INVALID_OPERATION');
        if ((findings.length > 0 || results.some(result => result.status === 'ok' && result.items.length > 0)) && !execution) throw new Error('DREAM_RECEIPT_REQUIRED');
        const outcomes = results.map(outcomeMetadata);
        validate(outcomes);
        const records = findings.map(finding => ({id: finding.id, sourceId: finding.sourceId, kind: finding.kind, content: finding.content,
            ...(finding.quote !== undefined ? {quote: finding.quote} : {}), ...(finding.eventTime !== undefined ? {eventTime: finding.eventTime} : {}),
            ...(finding.subject !== undefined ? {subject: finding.subject} : {}), ...(finding.project !== undefined ? {project: finding.project} : {}),
            ...(finding.recordedAt !== undefined ? {recordedAt: finding.recordedAt} : {})}));
        validateFindings(records, outcomes);
        if (execution && (!identity(execution.scanRunId) || !identity(execution.sessionId) || !identity(execution.taskId))) throw new Error('DREAM_RECEIPT_INVALID');
        if (requestHash !== undefined && !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('DREAM_REQUEST_INVALID');
        const run: Run = {operationId, outcomes, findings: records.map(record => record.id), ...(execution ? {execution: {...execution}} : {}),
            ...(requestHash ? {requestHash} : {}), ...(configRevision !== undefined ? {configRevision} : {})}, encoded = JSON.stringify(run);
        await this.create(path);
        await this.fs.meta.seq!.transaction!(async tx => {
            if (requestHash && await tx.getEntry(path, key('intent', operationId)) !== requestHash) throw new Error('DREAM_REQUEST_INVALID');
            const previous = await tx.getEntry(path, key('run', operationId));
            if (previous !== null && previous !== undefined) {
                if (previous !== encoded) throw new Error('DREAM_OPERATION_CONFLICT');
                for (const record of records) if (await tx.getEntry(path, key('finding', record.id)) !== JSON.stringify(record))
                    throw new Error('DREAM_OPERATION_CONFLICT');
                return;
            }
            if (configRevision !== undefined) {
                const rawConfig = await tx.getEntry(this.configPath(projectId, dreamId), 'config');
                if (configVersion(rawConfig) !== configRevision) throw new Error('DREAM_CONFIG_CONFLICT');
            }
            for (const record of records) {
                if (await tx.getEntry(path, key('finding', record.id))) throw new Error('DREAM_FINDING_CONFLICT');
                await tx.setEntry(path, key('finding', record.id), JSON.stringify(record));
            }
            for (const outcome of outcomes) if (outcome.status === 'ok') {
                const evidence = outcome.evidence, watermarkKey = key('source', evidence.sourceId);
                const raw = await tx.getEntry(path, watermarkKey), watermark = raw ? decodeWatermark(raw) : null;
                if (!matches(watermark, evidence)) throw new Error('DREAM_WATERMARK_CONFLICT');
                await tx.setEntry(path, watermarkKey, JSON.stringify({projectId: evidence.projectId, connectionId: evidence.connectionId,
                    authority: evidence.authority, cursor: evidence.endCursor} satisfies Watermark));
            }
            await tx.setEntry(path, key('run', operationId), encoded);
            if (!await tx.getEntry(path, key('run-state', operationId))) await addHistory(tx, path, operationId);
            const state = historyState((await tx.getEntry(path, key('run-state', operationId)))!);
            await tx.setEntry(path, key('run-state', operationId), JSON.stringify({startedAt: state.startedAt, state: 'settled', settledAt: Date.now(), ...(state.sourceId ? {sourceId: state.sourceId} : {})}));
        });
    }

    async history(projectId: string, dreamId: string, before?: number) {
        const path = this.path(projectId, dreamId);
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('DREAM_HISTORY_INVALID');
        if (!await this.fs.driver.exists(path)) return {items: [], scanned: 0};
        const count = Number(await this.fs.meta.seq!.getEntry(path, 'run-count') ?? 0);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('DREAM_HISTORY_INVALID');
        const start = Math.min(count, before === undefined ? count : before - 1), end = Math.max(1, start - 19);
        const keys = Array.from({length: Math.max(0, start - end + 1)}, (_, index) => `run-order:${start - index}`);
        const rows = await this.fs.meta.seq!.getEntries(path, keys);
        const items = keys.map(entry => {
            const item = parseStored<{operationId: string}>(rows[entry], 'DREAM_HISTORY_INVALID');
            if (!item || !identity(item.operationId)) throw new Error('DREAM_HISTORY_INVALID');
            return item;
        });
        const states = await this.fs.meta.seq!.getEntries(path, items.map(item => key('run-state', item.operationId)));
        const detailed = items.map(item => ({...item, ...historyState(states[key('run-state', item.operationId)])}));
        return {items: detailed, scanned: keys.length, ...(end > 1 && keys.length ? {nextCursor: end} : {})};
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
            if (configVersion(await tx.getEntry(this.configPath(request.ownerProjectId, request.dreamId), 'config')) !== configRevision)
                throw new Error('DREAM_CONFIG_CONFLICT');
            const raw = await tx.getEntry(path, key('run', request.runId));
            const run = raw ? parseStored<Run>(raw, 'DREAM_EVIDENCE_INVALID') : null;
            if (!run?.findings?.includes(request.suggestionId)) throw new Error('DREAM_SUGGESTION_UNAVAILABLE');
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

    async run(projectId: string, dreamId: string, operationId: string): Promise<Run | null> {
        const path = this.path(projectId, dreamId);
        if (!identity(operationId)) throw new Error('DREAM_INVALID_OPERATION');
        if (!await this.fs.driver.exists(path)) return null;
        const raw = await this.fs.meta.seq!.getEntry(path, key('run', operationId));
        if (!raw) return null;
        const result = JSON.parse(raw) as Run;
        if (result.operationId !== operationId || !Array.isArray(result.outcomes) || result.findings !== undefined
            && (!Array.isArray(result.findings) || result.findings.some(id => !identity(id)))
            || result.execution && (!identity(result.execution.scanRunId) || !identity(result.execution.sessionId) || !identity(result.execution.taskId))
            || result.requestHash !== undefined && !/^[a-f0-9]{64}$/.test(result.requestHash)
            || result.configRevision !== undefined && (!Number.isSafeInteger(result.configRevision) || result.configRevision < 1)) throw new Error('DREAM_EVIDENCE_INVALID');
        validate(result.outcomes);
        return result;
    }

    async finding(projectId: string, dreamId: string, id: string): Promise<DreamFindingView | null> {
        const path = this.path(projectId, dreamId);
        if (!identity(id)) throw new Error('DREAM_FINDING_INVALID');
        if (!await this.fs.driver.exists(path)) return null;
        const raw = await this.fs.meta.seq!.getEntry(path, key('finding', id));
        if (!raw) return null;
        const record = parseStored<DreamFinding>(raw, 'DREAM_FINDING_INVALID');
        if (!record || record.id !== id || !identity(record.sourceId) || !['fact', 'inference', 'suggestion'].includes(record.kind)
            || typeof record.content !== 'string' || !record.content.trim() || record.content.length > 16000
            || record.quote !== undefined && (typeof record.quote !== 'string' || record.quote.length > 16000)
            || record.subject !== undefined && (typeof record.subject !== 'string' || record.subject.length > 1000)
            || record.project !== undefined && (typeof record.project !== 'string' || record.project.length > 1000)
            || record.eventTime !== undefined && (typeof record.eventTime !== 'string' || record.eventTime.length > 1000)
            || record.recordedAt !== undefined && (!Number.isSafeInteger(record.recordedAt) || record.recordedAt < 0))
            throw new Error('DREAM_FINDING_INVALID');
        const head = await this.fs.meta.seq!.getEntry(path, key('finding-head', id));
        return head ? decodeFindingView(head, record) : {...record, revision: 0, state: 'active', origin: 'source'};
    }

    async review(projectId: string, dreamId: string, id: string, operationId: string, expectedRevision: number,
        review: DreamReview, authorize: (sourceId: string) => Promise<void>, configRevision?: number): Promise<DreamFindingView> {
        const started = Date.now(); let stage = 'validate';
        try {
            const path = this.path(projectId, dreamId);
            if (!identity(id) || !identity(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('DREAM_REVIEW_INVALID');
            const change = normalizeReview(review), current = await this.finding(projectId, dreamId, id);
            if (!current) throw new Error('DREAM_FINDING_MISSING');
            if (current.kind === 'suggestion') throw new Error('DREAM_REVIEW_INVALID');
            stage = 'authorization'; await authorize(current.sourceId);
            stage = 'commit';
            const result = await this.reviewTransaction(path, id, operationId, expectedRevision, change, configRevision);
            log.info('dream.memory.review', {operationId, stage, result: 'success', durationMs: Date.now() - started}); return result;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message
                : stage === 'authorization' ? 'DREAM_AUTHORIZATION_UNAVAILABLE' : 'DREAM_REVIEW_FAILED';
            log.warn('dream.memory.review', {operationId: identity(operationId) ? operationId : 'invalid', stage, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    async merge(projectId: string, dreamId: string, ids: [string, string], revisions: [number, number], operationId: string, configRevision: number,
        authorize: (sourceId: string) => Promise<void>): Promise<{mergeId: string}> {
        const started = Date.now(); let stage = 'validate';
        try {
            if (!identity(operationId) || !Array.isArray(ids) || ids.length !== 2 || !ids.every(identity) || ids[0] === ids[1]
                || !Array.isArray(revisions) || revisions.length !== 2 || revisions.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('DREAM_MERGE_INVALID');
            const findings = await Promise.all(ids.map(id => this.finding(projectId, dreamId, id)));
            if (findings.some(item => !item || item.state !== 'active' || item.kind === 'suggestion') || findings[0]!.kind !== findings[1]!.kind)
                throw new Error('DREAM_MERGE_INVALID');
            if (findings.some((item, index) => item!.revision !== revisions[index])) throw new Error('DREAM_REVIEW_CONFLICT');
            stage = 'authorization'; for (const item of findings) await requireFindingAuthority(authorize, item!.sourceId);
            stage = 'commit';
            const result = await this.mergeTransaction(projectId, dreamId, findings as [DreamFindingView, DreamFindingView], operationId, configRevision);
            log.info('dream.memory.merge', {operationId, stage, result: 'success', durationMs: Date.now() - started}); return result;
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_MERGE_FAILED';
            log.warn('dream.memory.merge', {operationId: identity(operationId) ? operationId : 'invalid', stage, result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
        }
    }
    private async mergeTransaction(projectId: string, dreamId: string, findings: [DreamFindingView, DreamFindingView], operationId: string, configRevision: number) {
        const path = this.path(projectId, dreamId), members = findings.map(item => ({id: item.id, sourceId: item.sourceId, revision: item.revision}));
        const fingerprint = sha256HexSync(JSON.stringify([members, configRevision])), mergeId = 'merge-' + sha256HexSync(JSON.stringify([projectId, dreamId, operationId]));
        return this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = key('merge-receipt', operationId), receiptRaw = await tx.getEntry(path, receiptKey);
            if (receiptRaw) {
                const receipt = parseStored<{fingerprint: string; mergeId: string}>(receiptRaw, 'DREAM_MERGE_INVALID');
                if (receipt.fingerprint !== fingerprint) throw new Error('DREAM_OPERATION_CONFLICT'); return {mergeId: receipt.mergeId};
            }
            if (configVersion(await tx.getEntry(this.configPath(projectId, dreamId), 'config')) !== configRevision) throw new Error('DREAM_CONFIG_CONFLICT');
            for (const item of findings) {
                const original = await tx.getEntry(path, key('finding', item.id)), head = await tx.getEntry(path, key('finding-head', item.id));
                if (!original) throw new Error('DREAM_FINDING_MISSING');
                const current = head ? decodeFindingView(head, JSON.parse(original) as DreamFinding) : {...JSON.parse(original), revision: 0, state: 'active'};
                if (current.revision !== item.revision || current.state !== 'active') throw new Error('DREAM_REVIEW_CONFLICT');
                const prior = await tx.getEntry(path, key('merge-of', item.id));
                if (prior) {
                    const raw = await tx.getEntry(path, key('merge-group', prior));
                    const group = raw ? parseStored<DreamMerge>(raw, 'DREAM_MERGE_INVALID') : null;
                    const member = group?.members?.find(candidate => candidate.id === item.id && candidate.sourceId === item.sourceId);
                    if (!member || group?.id !== prior) throw new Error('DREAM_MERGE_INVALID');
                    if (member.revision === item.revision) throw new Error('DREAM_MERGE_CONFLICT');
                }
            }
            const group: DreamMerge = {id: mergeId, members, operationId};
            await tx.setEntry(path, key('merge-group', mergeId), JSON.stringify(group));
            for (const item of members) await tx.setEntry(path, key('merge-of', item.id), mergeId);
            await tx.setEntry(path, receiptKey, JSON.stringify({fingerprint, mergeId})); return {mergeId};
        });
    }
    async mergeGroup(projectId: string, dreamId: string, finding: DreamFindingView): Promise<string | undefined> {
        const path = this.path(projectId, dreamId), id = await this.fs.meta.seq!.getEntry(path, key('merge-of', finding.id));
        if (!id) return;
        if (!identity(id)) throw new Error('DREAM_MERGE_INVALID');
        const raw = await this.fs.meta.seq!.getEntry(path, key('merge-group', id));
        const group = raw ? parseStored<DreamMerge>(raw, 'DREAM_MERGE_INVALID') : null;
        if (!group || group.id !== id || !Array.isArray(group.members) || group.members.length !== 2) throw new Error('DREAM_MERGE_INVALID');
        return group.members.some(item => item.id === finding.id && item.sourceId === finding.sourceId && item.revision === finding.revision) ? id : undefined;
    }

    private async reviewTransaction(path: string, id: string, operationId: string, expectedRevision: number, change: DreamReview, configRevision?: number): Promise<DreamFindingView> {
        const fingerprint = sha256HexSync(JSON.stringify([id, expectedRevision, change]));
        return this.fs.meta.seq!.transaction!(async tx => {
            const receiptKey = key('review', operationId), rawReceipt = await tx.getEntry(path, receiptKey);
            if (rawReceipt) {
                const receipt = JSON.parse(rawReceipt) as {fingerprint: string; result: DreamFindingView};
                if (receipt.fingerprint !== fingerprint) throw new Error('DREAM_OPERATION_CONFLICT');
                const original = await tx.getEntry(path, key('finding', id));
                if (!original) throw new Error('DREAM_FINDING_MISSING');
                return decodeFindingView(JSON.stringify(receipt.result), JSON.parse(original) as DreamFinding);
            }
            const raw = await tx.getEntry(path, key('finding', id));
            if (!raw) throw new Error('DREAM_FINDING_MISSING');
            const original = JSON.parse(raw) as DreamFinding, head = await tx.getEntry(path, key('finding-head', id));
            const current = head ? decodeFindingView(head, original) : {...original, revision: 0, state: 'active' as const, origin: 'source' as const};
            if (current.kind === 'suggestion') throw new Error('DREAM_REVIEW_INVALID');
            if (current.revision !== expectedRevision) throw new Error('DREAM_REVIEW_CONFLICT');
            if (configRevision !== undefined && configVersion(await tx.getEntry(path.replace(/evidence\.seq$/, 'config.seq'), 'config')) !== configRevision)
                throw new Error('DREAM_CONFIG_CONFLICT');
            const result: DreamFindingView = {...current, ...(change.action === 'correct' ? {content: change.content, kind: change.kind, state: 'active' as const, origin: 'user-correction' as const}
                : {state: change.action === 'dispute' ? 'disputed' as const : change.action === 'restore' ? 'active' as const : 'disabled' as const}), revision: current.revision + 1, updatedAt: Date.now()};
            await tx.setEntry(path, key('finding-history', `${id}:${result.revision}`), JSON.stringify({operationId, previous: current, result}));
            await tx.setEntry(path, key('finding-head', id), JSON.stringify(result));
            await tx.setEntry(path, receiptKey, JSON.stringify({fingerprint, result})); return result;
        });
    }

    async reviewHistory(projectId: string, dreamId: string, id: string, revision: number,
        authorize: (sourceId: string) => Promise<void>): Promise<{operationId: string; previous: DreamFindingView; result: DreamFindingView} | null> {
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('DREAM_REVIEW_INVALID');
        const current = await this.finding(projectId, dreamId, id);
        if (!current) return null;
        await requireFindingAuthority(authorize, current.sourceId);
        const raw = await this.fs.meta.seq!.getEntry(this.path(projectId, dreamId), key('finding-history', `${id}:${revision}`));
        if (!raw) return null;
        const entry = parseStored<{operationId: string; previous: DreamFindingView; result: DreamFindingView}>(raw, 'DREAM_REVIEW_INVALID');
        if (!entry || !entry.result || !entry.previous || !identity(entry.operationId) || entry.result.id !== id || entry.result.sourceId !== current.sourceId
            || entry.result.revision !== revision || entry.previous.id !== id || entry.previous.sourceId !== current.sourceId
            || entry.previous.revision !== revision - 1) throw new Error('DREAM_REVIEW_INVALID');
        await requireFindingAuthority(authorize, current.sourceId); return entry;
    }

    async watermark(projectId: string, dreamId: string, sourceId: string): Promise<Watermark | null> {
        const path = this.path(projectId, dreamId);
        if (!identity(sourceId)) throw new Error('DREAM_EVIDENCE_INVALID');
        if (!await this.fs.driver.exists(path)) return null;
        const raw = await this.fs.meta.seq!.getEntry(path, key('source', sourceId));
        return raw ? decodeWatermark(raw) : null;
    }

    async checkConfig(projectId: string, dreamId: string, revision: number): Promise<void> {
        const raw = await this.fs.meta.seq!.getEntry(this.configPath(projectId, dreamId), 'config');
        if (configVersion(raw) !== revision) throw new Error('DREAM_CONFIG_CONFLICT');
    }

    private path(projectId: string, dreamId: string): string {
        if (!identity(projectId) || !identity(dreamId)) throw new Error('DREAM_INVALID_SCOPE');
        return `/var/lib/projects/${projectId}/dream/${dreamId}/evidence.seq`;
    }
    private configPath(projectId: string, dreamId: string): string {
        return this.path(projectId, dreamId).replace(/evidence\.seq$/, 'config.seq');
    }
    private async create(path: string): Promise<void> {
        try { await this.fs.driver.createFile({parentPath: path.slice(0, path.lastIndexOf('/')), name: 'evidence.seq', type: 'seqfile', recursive: true}); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }
}

async function addHistory(tx: import('@nestos/vfs-core').ISeqFileTransaction, path: string, operationId: string, sourceId?: string): Promise<void> {
    const sequence = await tx.increment(path, 'run-count', 1);
    await tx.setEntry(path, `run-order:${sequence}`, JSON.stringify({operationId}));
    await tx.setEntry(path, key('run-state', operationId), JSON.stringify({startedAt: Date.now(), state: 'prepared', ...(sourceId ? {sourceId} : {})}));
}
function historyState(raw: string) {
    const value = parseStored<{startedAt: number; state: 'prepared' | 'failed' | 'settled'; sourceId?: string; code?: string; settledAt?: number}>(raw, 'DREAM_HISTORY_INVALID');
    if (!value || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 || !['prepared', 'failed', 'settled'].includes(value.state)
        || value.sourceId !== undefined && !identity(value.sourceId) || value.state === 'failed' && (typeof value.code !== 'string' || !/^DREAM_[A-Z_]+$/.test(value.code))
        || value.state === 'settled' && (!Number.isSafeInteger(value.settledAt) || value.settledAt! < 0)) throw new Error('DREAM_HISTORY_INVALID');
    return value;
}

function normalizeReview(review: DreamReview): DreamReview {
    if (review?.action === 'dispute' || review?.action === 'disable' || review?.action === 'restore') return {action: review.action};
    if (review?.action !== 'correct' || !['fact', 'inference'].includes(review.kind) || typeof review.content !== 'string'
        || !review.content.trim() || review.content.length > 16000) throw new Error('DREAM_REVIEW_INVALID');
    return {action: 'correct', content: review.content.trim(), kind: review.kind};
}
async function requireFindingAuthority(authorize: (sourceId: string) => Promise<void>, sourceId: string): Promise<void> {
    try {await authorize(sourceId);} catch {throw new Error('DREAM_AUTHORIZATION_UNAVAILABLE');}
}
function decodeFindingView(raw: string, original: DreamFinding): DreamFindingView {
    const view = parseStored<DreamFindingView>(raw, 'DREAM_FINDING_INVALID');
    if (!view || view.id !== original.id || view.sourceId !== original.sourceId || !Number.isSafeInteger(view.revision) || view.revision < 1
        || !['active', 'disputed', 'disabled'].includes(view.state) || !['source', 'user-correction'].includes(view.origin)
        || !Number.isSafeInteger(view.updatedAt) || view.updatedAt! < 0 || !['fact', 'inference', 'suggestion'].includes(view.kind)
        || (['quote', 'subject', 'project', 'eventTime', 'recordedAt'] as const).some(field => view[field] !== original[field])
        || typeof view.content !== 'string' || !view.content.trim() || view.content.length > 16000) throw new Error('DREAM_FINDING_INVALID');
    return view;
}
function parseStored<T>(raw: string, code: string): T {
    try {return JSON.parse(raw) as T;} catch {throw new Error(code);}
}
function configVersion(raw: string | null): number | undefined {
    if (!raw) return undefined;
    const value = parseStored<{revision?: number} | null>(raw, 'DREAM_CONFIG_INVALID');
    return value && typeof value === 'object' ? value.revision : undefined;
}
function validateFindings(findings: DreamFinding[], outcomes: Outcome[]): void {
    const sources = new Set(outcomes.flatMap(outcome => outcome.status === 'ok' ? [outcome.evidence.sourceId] : []));
    const ids = new Set<string>();
    if (findings.length > 1000) throw new Error('DREAM_FINDING_INVALID');
    for (const finding of findings) {
        if (!identity(finding.id) || ids.has(finding.id) || !sources.has(finding.sourceId)
            || !['fact', 'inference', 'suggestion'].includes(finding.kind) || typeof finding.content !== 'string'
            || !finding.content.trim() || finding.content.length > 16000 || finding.quote !== undefined && (typeof finding.quote !== 'string' || finding.quote.length > 16000)
            || finding.subject !== undefined && (typeof finding.subject !== 'string' || finding.subject.length > 1000)
            || finding.project !== undefined && (typeof finding.project !== 'string' || finding.project.length > 1000)
            || finding.eventTime !== undefined && (typeof finding.eventTime !== 'string' || finding.eventTime.length > 1000)
            || finding.recordedAt !== undefined && (!Number.isSafeInteger(finding.recordedAt) || finding.recordedAt < 0)) throw new Error('DREAM_FINDING_INVALID');
        ids.add(finding.id);
    }
}
function validate(outcomes: Outcome[]): void {
    if (!Array.isArray(outcomes) || outcomes.length > 1000) throw new Error('DREAM_EVIDENCE_INVALID');
    const ids = new Set<string>();
    for (const outcome of outcomes) {
        const evidence = outcome.status === 'ok' ? outcome.evidence : null;
        const id = evidence?.sourceId ?? ('sourceId' in outcome ? outcome.sourceId : '');
        if (!identity(id) || ids.has(id)) throw new Error('DREAM_EVIDENCE_INVALID');
        ids.add(id);
        if (!evidence) {
            if (outcome.status !== 'failed' && outcome.status !== 'skipped'
                || outcome.status === 'failed' && !['AUTHORIZATION_FAILED', 'READ_FAILED', 'AUTHORIZATION_CHANGED', 'INVALID_BATCH'].includes(outcome.code)
                || outcome.status === 'skipped' && outcome.code !== 'BUDGET_EXHAUSTED') throw new Error('DREAM_EVIDENCE_INVALID');
            continue;
        }
        if (!identity(evidence.projectId) || !identity(evidence.connectionId) || typeof evidence.version !== 'string' || !evidence.version || evidence.version.length > 4096 ||
            !Number.isSafeInteger(evidence.scanned) || evidence.scanned < 0 || !validCursor(evidence.startCursor) || !validCursor(evidence.endCursor)
            || !evidence.authority || Object.values(evidence.authority).some(value => typeof value !== 'string' || !value || value.length > 4096)
            || !['principalId', 'revision', 'projectRevision', 'serverId', 'serverProjectId'].every(field => field in evidence.authority))
            throw new Error('DREAM_EVIDENCE_INVALID');
    }
}
function outcomeMetadata(result: SourceScanResult<unknown>): Outcome {
    if (result.status !== 'ok') return {status: result.status, sourceId: result.sourceId, code: result.code} as Outcome;
    const e = result.evidence, a = e.authority;
    return {status: 'ok', evidence: {sourceId: e.sourceId, projectId: e.projectId, connectionId: e.connectionId,
        startCursor: e.startCursor, endCursor: e.endCursor, version: e.version, scanned: e.scanned,
        authority: {principalId: a.principalId, revision: a.revision, projectRevision: a.projectRevision,
            serverId: a.serverId, serverProjectId: a.serverProjectId}}};
}
function validCursor(value: unknown): boolean { return value === null || typeof value === 'string' && value.length <= 4096; }
function decodeWatermark(raw: string): Watermark {
    const value = JSON.parse(raw) as Watermark;
    if (!value || !value.authority || !validCursor(value.cursor)) throw new Error('DREAM_EVIDENCE_INVALID');
    return value;
}
function matches(current: Watermark | null, next: SourceEvidence): boolean {
    if (!current) return next.startCursor === null;
    return current.cursor === next.startCursor && current.projectId === next.projectId && current.connectionId === next.connectionId
        && (['principalId', 'revision', 'projectRevision', 'serverId', 'serverProjectId'] as const)
            .every(field => current.authority[field] === next.authority[field]);
}
