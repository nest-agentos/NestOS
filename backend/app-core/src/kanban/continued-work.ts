import type {KanbanExecutionPort} from '@nestos/kanban/execution';
import type {KanbanDispatch, KanbanItem} from '@nestos/kanban/contracts';
import type {IndependentCallService} from '@nestos/llm-session';
import type {SubmissionRequest, IndependentCallInput} from '@nestos/llm-session/contracts';
import type {TargetRef} from '@nestos/llm-flow/contracts';
import type {Kernel} from '@nestos/durable-kernel';
import {originalSession} from './session-operation';
import {requireValue} from './validation';
import type {createSessionSubmission as sessionSubmission} from '@nestos/llm-session';

interface Origin {schema: 1; dispatch: KanbanDispatch; input: IndependentCallInput}
interface Continued {schema: 2; dispatch: KanbanDispatch; origin: Origin; request: SubmissionRequest}
export interface ContinueWorkOptions {
    submission: ReturnType<typeof sessionSubmission>; calls: Pick<IndependentCallService, 'inspectTaskCallSubmission' | 'list'>;
    kernel: Pick<Kernel, 'inspectSession' | 'sessionActivity'>;
    prepare?(input: {dispatch: KanbanDispatch; item: KanbanItem; originalDispatch: KanbanDispatch; sessionId: string; nativeSessionId?: string; target: TargetRef}): Promise<string>;
    observe?(dispatch: KanbanDispatch, result: import('@nestos/kanban/execution').KanbanExecutionObservation): Promise<import('@nestos/kanban/execution').KanbanExecutionObservation>;
}
/** The predecessor remains terminal; a new request runs in its original execution Session. */
export function withContinuedWork(executor: KanbanExecutionPort, options: ContinueWorkOptions): KanbanExecutionPort {
    const observe = async (value: Continued, start: boolean) => {
        const result = await options.submission[start ? 'start' : 'inspect'](value.request);
        const observation = {controlCapabilities:result.controlCapabilities, executionSessionId: result.sessionId, outcome: result.outcome, code: result.code, ...(result.outcome === 'succeeded' ? {outputs: []} : {})};
        return options.observe ? options.observe(value.dispatch, observation) : observation;
    };
    return {...executor, prepareContinuation: (dispatch, item, previous) => prepare(options, dispatch, item, previous),
        start: value => isContinued(value) ? observe(value, true) : executor.start(value),
        inspect: value => isContinued(value) ? observe(value, false) : executor.inspect(value)};
}
function isContinued(value: unknown): value is Continued {return (value as Continued)?.schema === 2;}
async function prepare(options: ContinueWorkOptions, dispatch: KanbanDispatch, item: KanbanItem, previous: unknown): Promise<Continued> {
    const origin = isContinued(previous) ? previous.origin : previous as Origin;
    requireValue(origin?.schema === 1 && origin.dispatch?.itemId === item.id && origin.input?.request?.expectedTarget, 'CONTINUATION_SCOPE_MISMATCH');
    const original=await originalSession(options,origin.input);
    const {sessionId,nativeSessionId,target}=original;
    const instruction = await options.prepare?.({dispatch, item, originalDispatch: origin.dispatch, sessionId, nativeSessionId, target})
        ?? dispatch.continuation?.instruction;
    requireValue(instruction, 'CONTINUATION_INSTRUCTION_REQUIRED');
    return {schema:2,dispatch,origin,request:original.request(dispatch.id,instruction)};
}
