import {sha256HexSync} from '@nestos/common';
import type {KanbanRecurrence} from '@nestos/kanban/contracts';
import {nextRecurrence, validateRecurrence} from '@nestos/kanban/integration';
import type {Decision, DurableTaskProgram, TaskInputEvent} from '@nestos/durable-kernel';

export interface DreamScheduleInput {owner: string; dream: string; configRevision: number; schedule: KanbanRecurrence; nextAt: number}
interface ScheduleState extends DreamScheduleInput {child?: string; last?: {scheduledAt: number; status: 'succeeded' | 'failed' | 'cancelled'; code?: string;
    failures?: Array<{sourceId: string; code: string}>}}
export interface DreamRoundInput {owner: string; dream: string; configRevision: number; operationId: string; scheduledAt: number; nextAt: number}
const scheduleRef = {kind: 'dream.schedule', version: '1'};
const roundRef = {kind: 'dream.scan-round', version: '1'};

/** One persisted child at a time; a delayed timer coalesces all missed slots into one round. */
export const dreamScheduleProgram: DurableTaskProgram<ScheduleState, DreamScheduleInput, null> = {
    manifest: scheduleRef,
    init(input) {
        validateRecurrence(input.schedule);
        if (input.schedule.state !== 'active' || input.schedule.trigger !== 'fixed' || input.schedule.maxConcurrency !== 1
            || !Number.isSafeInteger(input.nextAt) || input.nextAt < 0 || !Number.isSafeInteger(input.configRevision) || input.configRevision < 1)
            throw new Error('DREAM_SCHEDULE_INVALID');
        return wait({...structuredClone(input)});
    },
    reduce(state, event) {
        if (event.type === 'timer-fired' && !state.child && event.id === 'dream-schedule') return scheduleRound(state, event);
        if (event.type === 'task-exited' && state.child && event.spawnKey === state.child) {
            const {child, ...remaining} = state;
            const output = event.exit.output as {results?: Array<{status?: string; sourceId?: string; code?: string}>} | undefined;
            const partial = event.exit.status === 'succeeded' && Array.isArray(output?.results) && output.results.some(item => item.status === 'failed');
            const status = partial ? 'failed' : event.exit.status;
            const candidate = event.exit.error?.code;
            const code = partial ? 'DREAM_SCHEDULE_SOURCE_FAILED' : typeof candidate === 'string' && /^DREAM_[A-Z_]+$/.test(candidate) ? candidate : undefined;
            const failures = partial ? output!.results!.flatMap(item => item.status === 'failed' && typeof item.sourceId === 'string'
                && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(item.sourceId) && typeof item.code === 'string' && /^DREAM_[A-Z_]+$/.test(item.code)
                ? [{sourceId: item.sourceId, code: item.code}] : []) : [];
            return wait({...remaining, last: {scheduledAt: Number(child.slice('round:'.length)), status, ...(code ? {code} : {}), ...(failures.length ? {failures} : {})}});
        }
        return wait({...state});
    },
};
function wait(state: ScheduleState): Decision<ScheduleState, null> {
    return {state, next: {type: 'wait', on: state.child ? {type: 'child', spawnKey: state.child}
        : {type: 'timer', id: 'dream-schedule', at: state.nextAt}}};
}
function scheduleRound(state: ScheduleState, event: Extract<TaskInputEvent, {type: 'timer-fired'}>): Decision<ScheduleState, null> {
    const at = state.nextAt, child = `round:${at}`;
    const nextAt = nextRecurrence(state.schedule, Math.max(at, event.firedAt ?? event.at));
    const operationId = 'schedule-' + sha256HexSync(JSON.stringify([state.owner, state.dream, state.configRevision, at]));
    const input: DreamRoundInput = {owner: state.owner, dream: state.dream, configRevision: state.configRevision, operationId, scheduledAt: at, nextAt};
    return {state: {...state, nextAt, child}, actions: [{type: 'spawn', spawnKey: child, spec: {program: roundRef, input}}],
        next: {type: 'wait', on: {type: 'child', spawnKey: child}}};
}

/** A round invokes the existing scanner through one durable Effect identity. */
export const dreamRoundProgram: DurableTaskProgram<DreamRoundInput, DreamRoundInput, unknown> = {
    manifest: roundRef,
    init(input) {return {state: input, actions: [{type: 'effect', effect: {id: 'scan', kind: 'dream.scan', version: '1',
        request: input, idempotencyKey: input.operationId, timeoutMs: null}}], next: {type: 'wait', on: {type: 'effect', id: 'scan'}}};},
    reduce(state, event) {
        if (event.type === 'effect-completed' && event.effectId === 'scan') return {state: {...state}, next: {type: 'complete', output: event.result}};
        if (event.type === 'effect-failed' && event.effectId === 'scan') return {state: {...state}, next: {type: 'fail', error: event.error}};
        return {state: {...state}, next: {type: 'wait', on: {type: 'effect', id: 'scan'}}};
    },
};
