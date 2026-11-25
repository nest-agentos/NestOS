export interface DreamSource {
    id: string;
    projectId: string;
    connectionId: string;
    cursor: string | null;
}

export interface SourceAuthority {
    principalId: string;
    revision: string;
    projectRevision: string;
    serverId: string;
    serverProjectId: string;
}

export interface SourceBatch<T> {
    items: T[];
    cursor: string | null;
    scanned: number;
    version: string;
}

export interface SourceEvidence {
    sourceId: string;
    projectId: string;
    connectionId: string;
    authority: SourceAuthority;
    startCursor: string | null;
    endCursor: string | null;
    version: string;
    scanned: number;
}

export interface SourcePort<T> {
    authorize(source: DreamSource): Promise<SourceAuthority>;
    read(source: DreamSource, limit: number): Promise<SourceBatch<T>>;
}

export type SourceScanResult<T> =
    | {status: 'ok'; items: T[]; evidence: SourceEvidence}
    | {status: 'skipped'; sourceId: string; code: 'BUDGET_EXHAUSTED'}
    | {status: 'failed'; sourceId: string; code: 'AUTHORIZATION_FAILED' | 'READ_FAILED' | 'AUTHORIZATION_CHANGED' | 'INVALID_BATCH'};

export interface ScanDiagnostic {
    operation: 'dream.scan.source';
    operationId: string;
    sourceId: string;
    stage: 'complete';
    result: 'ok' | 'failed' | 'skipped';
    code?: string;
    durationMs: number;
}

export function sameAuthority(a: SourceAuthority, b: SourceAuthority): boolean {
    return !!a && !!b && !!a.principalId && !!a.revision && !!a.projectRevision && !!a.serverId && !!a.serverProjectId
        && a.principalId === b.principalId && a.revision === b.revision && a.projectRevision === b.projectRevision
        && a.serverId === b.serverId && a.serverProjectId === b.serverProjectId;
}

function validBatch<T>(batch: SourceBatch<T>, limit: number): boolean {
    return !!batch && Array.isArray(batch.items) && Number.isSafeInteger(batch.scanned) && batch.scanned >= 0
        && batch.scanned <= limit && batch.items.length <= batch.scanned && typeof batch.version === 'string'
        && batch.version.length > 0 && (batch.cursor === null || typeof batch.cursor === 'string');
}

async function scanOne<T>(source: DreamSource, limit: number, port: SourcePort<T>): Promise<SourceScanResult<T>> {
    let before: SourceAuthority;
    try { before = {...await port.authorize({...source})}; } catch { return {status: 'failed', sourceId: source.id, code: 'AUTHORIZATION_FAILED'}; }
    if (!sameAuthority(before, before)) return {status: 'failed', sourceId: source.id, code: 'AUTHORIZATION_FAILED'};
    let batch: SourceBatch<T>;
    try { batch = await port.read({...source}, limit); } catch { return {status: 'failed', sourceId: source.id, code: 'READ_FAILED'}; }
    if (!validBatch(batch, limit)) return {status: 'failed', sourceId: source.id, code: 'INVALID_BATCH'};
    let after: SourceAuthority;
    try { after = await port.authorize({...source}); } catch { return {status: 'failed', sourceId: source.id, code: 'AUTHORIZATION_FAILED'}; }
    if (!sameAuthority(before, after)) return {status: 'failed', sourceId: source.id, code: 'AUTHORIZATION_CHANGED'};
    return {status: 'ok', items: batch.items, evidence: {sourceId: source.id, projectId: source.projectId,
        connectionId: source.connectionId, authority: {...before}, startCursor: source.cursor,
        endCursor: batch.cursor, version: batch.version, scanned: batch.scanned}};
}

/** Each source is reauthorized after reading; failed batches never advance their cursor. */
export async function scanSources<T>(sources: DreamSource[], limit: number, port: SourcePort<T>,
    diagnostic?: {operationId: string; emit(event: ScanDiagnostic): void}): Promise<SourceScanResult<T>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('DREAM_INVALID_READ_LIMIT');
    const snapshot = sources.map(source => ({...source}));
    if (snapshot.some(source => !source.id || !source.projectId || !source.connectionId
        || source.cursor !== null && typeof source.cursor !== 'string')) throw new Error('DREAM_INVALID_SOURCE');
    if (new Set(snapshot.map(source => source.id)).size !== snapshot.length) throw new Error('DREAM_DUPLICATE_SOURCE');
    const results: SourceScanResult<T>[] = [];
    for (const [index, source] of snapshot.entries()) {
        const started = Date.now();
        const quota = Math.floor(limit / snapshot.length) + (index < limit % snapshot.length ? 1 : 0);
        const result: SourceScanResult<T> = !quota ? {status: 'skipped', sourceId: source.id, code: 'BUDGET_EXHAUSTED'}
            : await scanOne({...source}, quota, port);
        results.push(result);
        try { diagnostic?.emit({operation: 'dream.scan.source', operationId: diagnostic.operationId, sourceId: source.id,
            stage: 'complete', result: result.status, ...('code' in result ? {code: result.code} : {}), durationMs: Date.now() - started}); } catch { /* Diagnostics must not alter scan results. */ }
    }
    return results;
}
