import type { ISeqFileReadTransaction } from '@nestos/vfs-core';
import { decodeRecord, identity, recordKey } from './codec';
import type { TwinRecord, TwinRecordRef } from './contracts';

export interface StoredVersion extends TwinRecord {
    previousRevision: string | null;
    sourceListRevision?: string;
    sourceCount?: number;
}

export const versionKey = (record: TwinRecordRef, revision: string) =>
    'version/' + recordKey(record) + '/' + encodeURIComponent(revision);

function restoreSources(version: StoredVersion, anchor: StoredVersion | null): TwinRecord {
    const sources = anchor?.payload.sourceIds;
    if (!anchor || anchor.revision !== version.sourceListRevision || anchor.sourceListRevision !== undefined ||
        !Array.isArray(sources) || sources.length !== version.sourceCount) throw new Error('TWIN_SCAN_SOURCE_LIST_INCONSISTENT');
    const {sourceListRevision, sourceCount, ...record} = version;
    return {...record, payload: {...record.payload, sourceIds: sources}};
}

/** Source lists are scoped to an older immutable revision of the same run. */
export async function expandRunVersions(tx: ISeqFileReadTransaction, path: string, records: TwinRecord[]): Promise<TwinRecord[]> {
    const references = (records as StoredVersion[]).filter(row => row.family === 'scan-run' && row.sourceListRevision !== undefined);
    if (!references.length) return records;
    const keys = references.map(row => {
        identity(row.sourceListRevision);
        return {fileIdOrPath: path, key: versionKey(row, row.sourceListRevision)};
    });
    const anchors = await tx.getEntriesMany(keys);
    const expanded = new Map(references.map((row, i) => [row, restoreSources(row, decodeRecord(anchors[i], row) as StoredVersion | null)]));
    return records.map(record => expanded.get(record as StoredVersion) ?? record);
}

export function packRunVersion(version: StoredVersion, previous: StoredVersion, sources: unknown): StoredVersion {
    const ids = version.payload.sourceIds;
    if (!Array.isArray(ids) || !Array.isArray(sources) || ids.length !== sources.length ||
        !ids.every((id, index) => id === sources[index]) || JSON.stringify(ids).length <= 128) return version;
    const {sourceIds, ...payload} = version.payload;
    return {...version, payload, sourceListRevision: previous.sourceListRevision ?? previous.revision, sourceCount: ids.length};
}

export async function encodeVersion(tx: ISeqFileReadTransaction, path: string, version: StoredVersion): Promise<StoredVersion> {
    if (version.family !== 'scan-run' || !version.previousRevision || !Array.isArray(version.payload.sourceIds) ||
        JSON.stringify(version.payload.sourceIds).length <= 128) return version;
    const raw = await tx.getEntry(path, versionKey(version, version.previousRevision));
    const previous = decodeRecord(raw, version) as StoredVersion | null;
    if (!previous || previous.revision !== version.previousRevision) throw new Error('TWIN_SCAN_PREVIOUS_VERSION_MISSING');
    const [expanded] = await expandRunVersions(tx, path, [previous]);
    return packRunVersion(version, previous, expanded.payload.sourceIds);
}

/** Rewrite in predecessor order so every reference points directly to a retained full version. */
export function compactRunChain(versions: Map<string, StoredVersion>, head: string): StoredVersion[] {
    const chain: StoredVersion[] = [], seen = new Set<string>();
    for (let cursor: string | null = head; cursor !== null;) {
        const version = versions.get(cursor);
        if (!version || seen.has(cursor)) throw new Error('TWIN_SCAN_VERSION_CHAIN_INCONSISTENT');
        seen.add(cursor); chain.push(version); cursor = version.previousRevision;
    }
    if (chain.length !== versions.size) throw new Error('TWIN_SCAN_VERSION_CHAIN_DISCONNECTED');
    const changes: StoredVersion[] = [];
    let previous: StoredVersion | undefined, sources: unknown;
    for (const version of chain.reverse()) {
        const expanded = version.sourceListRevision ? restoreSources(version, versions.get(version.sourceListRevision) ?? null) : version;
        const full: StoredVersion = {...expanded, previousRevision: version.previousRevision};
        const next = previous ? packRunVersion(full, previous, sources) : full;
        if (next.sourceListRevision !== version.sourceListRevision) changes.push(next);
        previous = next; sources = expanded.payload.sourceIds;
    }
    return changes;
}
