export interface DerivedFinding {
    kind: 'inference' | 'suggestion'; content: string; quote: string; subject: string; project: string; eventTime: string;
}

/** Explicitly labelled derived outputs remain separate from source-stated facts. */
export function parseDerivedFindings(value: unknown, source: string): DerivedFinding[] {
    if (!value || typeof value !== 'object' || !('dreamFindings' in value)) return [];
    const rows = (value as {dreamFindings?: unknown}).dreamFindings;
    if (!Array.isArray(rows) || rows.length > 10) throw new Error('DREAM_RESULT_UNSUPPORTED');
    return rows.map(row => {
        if (!row || typeof row !== 'object') throw new Error('DREAM_RESULT_UNSUPPORTED');
        const item = row as DerivedFinding;
        if (!['inference', 'suggestion'].includes(item.kind) || !valid(item.content, 4000) || !valid(item.quote, 1000)
            || !source.includes(item.quote) || !valid(item.subject, 200) || typeof item.project !== 'string' || item.project.length > 200
            || typeof item.eventTime !== 'string' || item.eventTime.length > 200) throw new Error('DREAM_RESULT_UNSUPPORTED');
        return {kind: item.kind, content: item.content, quote: item.quote, subject: item.subject, project: item.project, eventTime: item.eventTime};
    });
}
function valid(value: unknown, limit: number): value is string {return typeof value === 'string' && !!value.trim() && value.length <= limit;}
