import {MemoryCommitStore, type MemoryCandidate, type MemoryCommittedEvent} from '@nestos/dream/vfs';
import type {IFileSystem} from '@nestos/vfs-core';

type Authorize = (owner: string, dream: string, scopes: readonly string[]) => Promise<void>;
export interface DreamContribution {
    commitId: string; version: string; requiredScopes: string[]; committedAt?: number;
    referenceCommits?: string[];
    changes: Array<{id: string; action: 'add' | 'update' | 'retire'; content: string | null; evidenceIds: string[];
        kind?: 'constraint' | 'topic'; priority?: number; title?: string; evidenceRefs?: Array<{proposalId: string; evidenceId: string}>}>;
}
const key = (kind: string, id: string) => `${kind}:${JSON.stringify(id)}`;
const valid = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const pathFor = (owner: string, dream: string) => {
    if (!valid(owner) || !valid(dream)) throw new Error('DREAM_OUTBOX_INVALID');
    return `/var/lib/projects/${owner}/dream/${dream}/evidence.seq`;
};

/** Independent, idempotent consumer of committed references; reads always reauthorize. */
export class DreamDownstream {
    constructor(private readonly fs: IFileSystem, private readonly authorize: Authorize) {}
    async consume(owner: string, dream: string, kind: 'daily' | 'kanban', event: MemoryCommittedEvent): Promise<void> {
        const path = pathFor(owner, dream), authorize = (scopes: readonly string[]) => this.authorize(owner, dream, scopes);
        const store = new MemoryCommitStore(operation => this.fs.meta.seq!.transaction!(operation), path);
        const committed = await store.committed(event.commitId, authorize);
        if (!committed || JSON.stringify(committed.event) !== JSON.stringify(event)) throw new Error('DREAM_COMMIT_INVALID');
        const prior = await this.parent(path, committed.candidate, authorize);
        const evidence = await this.evidence(path, event.commitId, authorize, new Set());
        const requiredScopes = [...new Set([...event.requiredScopes, ...prior?.requiredScopes ?? [], ...evidence.scopes])].sort();
        await authorize(requiredScopes);
        const time = await this.fs.meta.seq!.getEntry(path, key('committed-at', event.commitId));
        const committedAt = time === null ? undefined : Number(time);
        if (committedAt !== undefined && (!Number.isSafeInteger(committedAt) || committedAt < 0)) throw new Error('DREAM_COMMIT_INVALID');
        const result: DreamContribution = {commitId: event.commitId, version: event.version, requiredScopes,
            ...(committedAt !== undefined ? {committedAt} : {}),
            ...(evidence.referenceCommits.length ? {referenceCommits: evidence.referenceCommits} : {}),
            changes: changes(prior, committed.candidate, evidence.byTopic)};
        const encoded = JSON.stringify(result);
        await this.fs.meta.seq!.transaction!(async tx => {
            const resultKey = key(`consumer-result:${kind}`, event.commitId), previous = await tx.getEntry(path, resultKey);
            if (previous && previous !== encoded) throw new Error('DREAM_OUTBOX_CONFLICT');
            if (!previous) await tx.setEntry(path, resultKey, encoded);
        });
        await authorize(requiredScopes);
    }
    async read(owner: string, dream: string, kind: 'daily' | 'kanban', commitId: string): Promise<DreamContribution | null> {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(commitId)) throw new Error('DREAM_COMMIT_INVALID');
        const path = pathFor(owner, dream), resultKey = key(`consumer-result:${kind}`, commitId);
        if (!await this.fs.driver.exists(path)) return null;
        const raw = await this.fs.meta.seq!.getEntry(path, resultKey); if (!raw) return null;
        const result = JSON.parse(raw) as DreamContribution;
        if (result.commitId !== commitId || !Array.isArray(result.requiredScopes) || !Array.isArray(result.changes)) throw new Error('DREAM_OUTBOX_INVALID');
        await this.authorize(owner, dream, result.requiredScopes);
        if (await this.fs.meta.seq!.getEntry(path, resultKey) !== raw) throw new Error('DREAM_OUTBOX_CONFLICT');
        await this.authorize(owner, dream, result.requiredScopes);
        return result;
    }
    async list(owner: string, dream: string, kind: 'daily' | 'kanban', after?: string) {
        const path = pathFor(owner, dream), prefix = `consumer-result:${kind}:`;
        if (after !== undefined && (!after.startsWith(prefix) || after.length > 256)) throw new Error('DREAM_OUTBOX_INVALID');
        if (!await this.fs.driver.exists(path)) return {items: [], scanned: 0};
        const rows: Array<{key: string; value: string}> = [];
        await this.fs.meta.seq!.walkEntries(path, row => {rows.push(row); return true;}, {keyPrefix: prefix, order: 'key', after, limit: 50});
        const items: DreamContribution[] = [];
        for (const row of rows) {
            const value = JSON.parse(row.value) as DreamContribution;
            try {const result = await this.read(owner, dream, kind, value.commitId); if (result) items.push(result);}
            catch (error) {
                if (!denied(error)) throw error;
            }
        }
        const visible: DreamContribution[] = [];
        for (const item of items) {
            try {await this.authorize(owner, dream, item.requiredScopes); visible.push(item);}
            catch (error) {if (!denied(error)) throw error;}
        }
        return {items: visible, scanned: rows.length, ...(rows.length === 50 ? {nextCursor: rows[rows.length - 1].key} : {})};
    }
    private async parent(path: string, candidate: MemoryCandidate, authorize: (scopes: readonly string[]) => Promise<void>): Promise<MemoryCandidate | null> {
        if (!candidate.parentVersion) return null;
        const raw = await this.fs.meta.seq!.getEntry(path, key('candidate', candidate.parentVersion));
        if (!raw) throw new Error('DREAM_CANDIDATE_MISSING');
        const parent = JSON.parse(raw) as MemoryCandidate;
        if (parent.version !== candidate.parentVersion || !Array.isArray(parent.requiredScopes) || !Array.isArray(parent.topics)) throw new Error('DREAM_CANDIDATE_INVALID');
        await authorize(parent.requiredScopes);
        if (await this.fs.meta.seq!.getEntry(path, key('candidate', candidate.parentVersion)) !== raw) throw new Error('DREAM_CANDIDATE_CONFLICT');
        return parent;
    }
    private async evidence(path: string, commitId: string, authorize: (scopes: readonly string[]) => Promise<void>, visited: Set<string>): Promise<{
        byTopic: Map<string, Array<{proposalId: string; evidenceId: string}>>; scopes: string[]; referenceCommits: string[]}> {
        if (visited.has(commitId) || visited.size >= 32) throw new Error('DREAM_COMMIT_INVALID');
        visited.add(commitId);
        const raw = await this.fs.meta.seq!.getEntry(path, `review-receipt:${JSON.stringify([commitId])}`);
        if (!raw) {
            const target = await this.fs.meta.seq!.getEntry(path, key('rollback-target', commitId));
            if (!target) return {byTopic: new Map(), scopes: [], referenceCommits: []};
            if (!valid(target)) throw new Error('DREAM_COMMIT_INVALID');
            const store = new MemoryCommitStore(operation => this.fs.meta.seq!.transaction!(operation), path);
            const committed = await store.committed(target, authorize);
            if (!committed) throw new Error('DREAM_COMMIT_MISSING');
            const origin = await this.evidence(path, target, authorize, visited);
            return {...origin, scopes: [...new Set([...origin.scopes, ...committed.event.requiredScopes])].sort(),
                referenceCommits: [target, ...origin.referenceCommits]};
        }
        const receipt = JSON.parse(raw) as {selected: Array<{id: string; revision: number}>};
        if (!Array.isArray(receipt.selected) || receipt.selected.length > 50) throw new Error('DREAM_REVIEW_RECEIPT_INVALID');
        const byTopic = new Map<string, Map<string, {proposalId: string; evidenceId: string}>>(), scopes = new Set<string>();
        for (const choice of receipt.selected) {
            const saved = await this.fs.meta.seq!.getEntry(path, `proposal-history:${JSON.stringify([choice.id, String(choice.revision)])}`);
            if (!saved) throw new Error('DREAM_PROPOSAL_MISSING');
            const proposal = JSON.parse(saved) as {id: string; revision: number; evidenceIds: string[]; requiredScopes: string[]; changes: Array<{id: string}>};
            if (proposal.id !== choice.id || proposal.revision !== choice.revision || !Array.isArray(proposal.evidenceIds)
                || !Array.isArray(proposal.requiredScopes) || !Array.isArray(proposal.changes)) throw new Error('DREAM_PROPOSAL_INVALID');
            await authorize(proposal.requiredScopes);
            for (const change of proposal.changes) {
                const refs = byTopic.get(change.id) ?? new Map<string, {proposalId: string; evidenceId: string}>();
                for (const evidenceId of proposal.evidenceIds) refs.set(JSON.stringify([proposal.id, evidenceId]), {proposalId: proposal.id, evidenceId});
                byTopic.set(change.id, refs);
            }
            proposal.requiredScopes.forEach(scope => scopes.add(scope));
        }
        return {byTopic: new Map([...byTopic].map(([id, refs]) => [id, [...refs.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ref]) => ref)])),
            scopes: [...scopes].sort(), referenceCommits: []};
    }
}
function denied(error: unknown): boolean {
    return error instanceof Error && ['DREAM_AUTHORIZATION_CHANGED', 'DREAM_AUTHORIZATION_DENIED', 'DREAM_SOURCE_NOT_CONFIGURED',
        'DREAM_CONFIG_CONFLICT', 'DREAM_OWNER_AUTHORIZATION_FAILED', 'DREAM_AUTHORIZATION_UNAVAILABLE', 'DREAM_SERVER_IDENTITY_CHANGED'].includes(error.message);
}
function changes(previous: MemoryCandidate | null, current: MemoryCandidate,
    evidence: Map<string, Array<{proposalId: string; evidenceId: string}>>): DreamContribution['changes'] {
    const old = new Map(previous?.topics.map(topic => [topic.id, topic]) ?? []);
    const next = new Map(current.topics.map(topic => [topic.id, topic]));
    return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap(id => {
        const before = old.get(id), after = next.get(id);
        if (before && after && before.content === after.content && (before.kind ?? 'constraint') === (after.kind ?? 'constraint')
            && (before.priority ?? 0) === (after.priority ?? 0) && (before.updatedAt ?? 0) === (after.updatedAt ?? 0)
            && (before.title ?? '') === (after.title ?? '')) return [];
        const content = after?.content ?? null;
        const refs = evidence.get(id) ?? [];
        return [{id, action: !old.has(id) ? 'add' as const : !next.has(id) ? 'retire' as const : 'update' as const,
            content, ...(after?.kind !== undefined ? {kind: after.kind} : {}), ...(after?.priority !== undefined ? {priority: after.priority} : {}),
            ...(after?.title !== undefined ? {title: after.title} : {}),
            evidenceIds: [...new Set(refs.map(ref => ref.evidenceId))].sort(), ...(refs.length ? {evidenceRefs: refs} : {})}];
    });
}
