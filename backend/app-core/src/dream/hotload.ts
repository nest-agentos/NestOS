import {sha256HexSync} from '@nestos/common';
import type {MemoryTopic} from '@nestos/dream/vfs';

export interface DreamHotloadItem {namespaceId: string; topic: MemoryTopic; budget: number}
export interface DreamHotloadEntry {entryId: string; namespaceId: string; content: string; contentHash: string}
const compare = (a: DreamHotloadItem, b: DreamHotloadItem) =>
    (b.topic.priority ?? 0) - (a.topic.priority ?? 0) || (b.topic.updatedAt ?? 0) - (a.topic.updatedAt ?? 0)
    || lexical(a.topic.id, b.topic.id) || lexical(a.namespaceId, b.namespaceId);
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const cost = (entry: Pick<DreamHotloadEntry, 'namespaceId' | 'entryId' | 'content'>) =>
    new TextEncoder().encode(`Memory (${entry.namespaceId}/${entry.entryId}):\n${entry.content}`).byteLength;
const entry = (namespaceId: string, entryId: string, content: string): DreamHotloadEntry =>
    ({namespaceId, entryId, content, contentHash: sha256HexSync(content)});

/** Count the exact injected UTF-8 text conservatively and never split an entry. */
export function assembleDreamHotload(owner: string, items: readonly DreamHotloadItem[], limit: number, budget: number): DreamHotloadEntry[] {
    const sorted = [...items].sort((a, b) => Number((a.topic.kind ?? 'constraint') === 'topic')
        - Number((b.topic.kind ?? 'constraint') === 'topic') || compare(a, b));
    const entries: DreamHotloadEntry[] = [], used = new Map<string, number>();
    let remaining = budget, truncated = false;
    for (const item of sorted) {
        const topic = item.topic, content = topic.kind === 'topic' ? `Topic: ${topic.title ?? topic.id}. Use dream_read to retrieve this topic.`
            : topic.title ? `${topic.title}\n${topic.content}` : topic.content;
        const candidate = entry(item.namespaceId, topic.id, content), bytes = cost(candidate), spent = used.get(item.namespaceId) ?? 0;
        if (entries.length >= limit || bytes > remaining || spent + bytes > item.budget) {truncated = true; continue;}
        entries.push(candidate); remaining -= bytes; used.set(item.namespaceId, spent + bytes);
    }
    if (truncated && limit > 0) {
        const hint = entry(`dream:${owner}:search`, 'retrieval-hint', 'Use dream_search to find other authorized memories.');
        const bytes = cost(hint);
        if (bytes <= budget) {
            while (entries.length && (bytes > remaining || entries.length >= limit)) remaining += cost(entries.pop()!);
            if (bytes <= remaining) entries.push(hint);
        }
    }
    return entries;
}
