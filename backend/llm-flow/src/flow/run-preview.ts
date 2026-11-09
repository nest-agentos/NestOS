import type {FlowRunPreview} from '../contracts/flow-run-summary';
import {nodeOutputEntries} from '../contracts/flow-output';

interface Budget {remaining: number; truncated: boolean}
const LIMIT = 600;

/** Bound traversal and text before serializing persisted input or output into a list response. */
export function flowRunPreview(value: unknown): FlowRunPreview | undefined {
    if (value === undefined) return undefined;
    const budget = {remaining: 40, truncated: false};
    const projected = project(value, budget, 0);
    const text = typeof projected === 'string' ? projected : JSON.stringify(projected, null, 2) ?? '';
    const clipped = clip(text, LIMIT);
    return {text: clipped, truncated: budget.truncated || clipped.length < text.length};
}

/** Flatten a bounded sample of node artifacts so previews show values instead of transport envelopes. */
export function flowRunOutputPreview(value: unknown): FlowRunPreview | undefined {
    const root = record(value), nodes = record(root?.nodes);
    if (!nodes) return flowRunPreview(value);
    const keys = Object.keys(nodes), entries: Array<[string, unknown]> = [];
    let omitted = keys.length > 4;
    for (const key of keys.slice(0, 4)) {
        const node = record(nodes[key]), outputs = record(node?.outputs);
        const names = outputs ? Object.keys(outputs) : [];
        omitted ||= names.length > 4;
        const sample = outputs ? {outputs: Object.fromEntries(names.slice(0, 4).map(name => [name, outputs[name]]))} : nodes[key];
        for (const entry of nodeOutputEntries(sample)) entries.push([`${key} / ${entry.name}`, entry.value]);
    }
    const extra = Object.keys(root!).filter(key => key !== 'nodes');
    omitted ||= extra.length > 4;
    for (const key of extra.slice(0, 4)) entries.push([key, root![key]]);
    const preview = flowRunPreview(Object.fromEntries(entries))!;
    preview.truncated ||= omitted; return preview;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function project(value: unknown, budget: Budget, depth: number): unknown {
    if (budget.remaining-- <= 0) {budget.truncated = true; return '…';}
    if (typeof value === 'string') {
        const text = clip(value, LIMIT + 1); budget.truncated ||= text.length < value.length; return text;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 4) {budget.truncated = true; return '…';}
    if (Array.isArray(value)) {
        budget.truncated ||= value.length > 8;
        return value.slice(0, 8).map(item => project(item, budget, depth + 1));
    }
    const keys = Object.keys(value), record = value as Record<string, unknown>;
    budget.truncated ||= keys.length > 8;
    return Object.fromEntries(keys.slice(0, 8).map(key => {
        const name = clip(key, 80); budget.truncated ||= name.length < key.length;
        return [name, project(record[key], budget, depth + 1)];
    }));
}

function clip(value: string, length: number): string {
    const text = value.slice(0, length);
    return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
