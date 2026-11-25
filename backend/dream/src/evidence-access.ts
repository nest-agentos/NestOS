import {sameAuthority, type DreamSource, type SourceAuthority, type SourceEvidence} from './sources';

export type EvidenceAccess = {status: 'available'; evidence: SourceEvidence}
    | {status: 'unavailable'; sourceId: string; code: 'SOURCE_NOT_SELECTED' | 'AUTHORIZATION_FAILED' | 'AUTHORIZATION_CHANGED'};

/** Stored evidence remains accessible only while its original source grant is current. */
export async function authorizeEvidence(evidence: readonly SourceEvidence[], selected: readonly DreamSource[],
    authorize: (source: DreamSource) => Promise<SourceAuthority>): Promise<EvidenceAccess[]> {
    const sources = new Map(selected.map(source => [source.id, {...source}]));
    if (sources.size !== selected.length) throw new Error('DREAM_DUPLICATE_SOURCE');
    const result: EvidenceAccess[] = [];
    for (const item of structuredClone(evidence)) {
        const source = sources.get(item.sourceId);
        if (!source || source.projectId !== item.projectId || source.connectionId !== item.connectionId) {
            result.push({status: 'unavailable', sourceId: item.sourceId, code: 'SOURCE_NOT_SELECTED'}); continue;
        }
        try {
            const current = await authorize({...source});
            result.push(sameAuthority(item.authority, current) ? {status: 'available', evidence: item}
                : {status: 'unavailable', sourceId: item.sourceId, code: 'AUTHORIZATION_CHANGED'});
        } catch { result.push({status: 'unavailable', sourceId: item.sourceId, code: 'AUTHORIZATION_FAILED'}); }
    }
    return result;
}
