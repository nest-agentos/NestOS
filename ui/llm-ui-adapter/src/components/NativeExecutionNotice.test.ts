import type {ConversationSnapshot} from '../contracts';
// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {NativeExecutionNotice} from './NativeExecutionNotice';


it('shows compaction prominently and removes it on resumed work or completion', () => {
    const view = new NativeExecutionNotice();
    const state = {observation: {execution: 'running', activity: {turnId: 'turn', phase: 'compacting'}}} as ConversationSnapshot;
    try {
        view.update(state); expect(view.element.hidden).toBe(false); expect(view.element.textContent).toContain('正在整理上下文');
        view.setActive(false); expect(view.element.hidden).toBe(true);
        view.setActive(true); expect(view.element.hidden).toBe(false);
        view.update({...state, observation: {...state.observation!, activity: {turnId: 'turn', phase: 'reasoning'}}});
        expect(view.element.hidden).toBe(true);
        view.update({...state, observation: {...state.observation!, execution: 'idle'}}); expect(view.element.hidden).toBe(true);
    } finally {view.destroy();}
});

it('keeps damaged history visible as a warning without requiring a running turn', () => {
    const view = new NativeExecutionNotice();
    const snapshot = {historyRecovery: {skippedRecords: 1, skippedBytes: 287, nulRecords: 1,
        invalidJsonRecords: 0, invalidRecordRecords: 0, firstOffset: 100, lastOffset: 100}} as ConversationSnapshot;
    try {
        view.update(snapshot);
        expect(view.element.hidden).toBe(false);
        expect(view.element.textContent).toContain('历史不完整');
        expect(view.element.textContent).toContain('1');
        view.setActive(false); expect(view.element.hidden).toBe(true);
        view.setActive(true); expect(view.element.hidden).toBe(false);
        view.update({} as ConversationSnapshot); expect(view.element.hidden).toBe(true);
    } finally {view.destroy();}
});
