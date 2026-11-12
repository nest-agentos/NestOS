import type {KanbanExecutionPort} from '@nestos/kanban/execution';
import type {KanbanDispatch, KanbanItem} from '@nestos/kanban/contracts';
import type {IndependentCallService} from '@nestos/llm-session';
import type {SubmissionRequest, IndependentCallInput} from '@nestos/llm-session/contracts';
import type {TargetRef} from '@nestos/llm-flow/contracts';
import type {OriginalSessionResolver} from '../projects/original-execution-session';

import {requireValue} from './validation';
import type {createSessionSubmission as sessionSubmission} from '@nestos/llm-session';

interface Origin {schema: 1; dispatch: KanbanDispatch; input: IndependentCallInput}
interface Continued {schema: 2; dispatch: KanbanDispatch; origin: Origin; request: SubmissionRequest}
export interface ContinuationContext {dispatch:KanbanDispatch;item:KanbanItem;originalDispatch:KanbanDispatch;sessionId:string;nativeSessionId?:string;target:TargetRef}
interface Recovered {schema:3;dispatch:KanbanDispatch;origin:Origin;context:ContinuationContext;proof:unknown}
export interface ContinueWorkOptions {
    completedResult?:{prepare(input:ContinuationContext):Promise<unknown|undefined>;inspect(input:ContinuationContext,proof:unknown):Promise<import('@nestos/kanban/execution').KanbanExecutionObservation>};
    submission: ReturnType<typeof sessionSubmission>; calls: Pick<IndependentCallService, 'inspectTaskCallSubmission' | 'list'>;
    originalSession:OriginalSessionResolver;
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
        start: value => isRecovered(value)?inspectRecovered(options,value):isContinued(value) ? observe(value, true) : executor.start(value),
        inspect: value => isRecovered(value)?inspectRecovered(options,value):isContinued(value) ? observe(value, false) : executor.inspect(value)};
}
function isRecovered(value:unknown):value is Recovered{return (value as Recovered)?.schema===3;}
async function inspectRecovered(options:ContinueWorkOptions,value:Recovered){
    requireValue(options.completedResult,'CONTINUATION_RESULT_UNAVAILABLE');
    return options.completedResult.inspect(value.context,value.proof);
}
function isContinued(value: unknown): value is Continued {return (value as Continued)?.schema === 2;}
async function prepare(options: ContinueWorkOptions, dispatch: KanbanDispatch, item: KanbanItem, previous: unknown): Promise<Continued|Recovered> {
    const origin = isContinued(previous)||isRecovered(previous) ? previous.origin : previous as Origin;
    requireValue(origin?.schema === 1 && origin.dispatch?.itemId === item.id && origin.input?.request?.expectedTarget, 'CONTINUATION_SCOPE_MISMATCH');
    const original=await options.originalSession(origin.input);
    const {sessionId,nativeSessionId,target}=original;
    const context:ContinuationContext={dispatch,item,originalDispatch:origin.dispatch,sessionId,nativeSessionId,target};
    const proof=await options.completedResult?.prepare(context);
    if(proof!==undefined)return {schema:3,dispatch,origin,context,proof};
    const instruction = await options.prepare?.({dispatch, item, originalDispatch: origin.dispatch, sessionId, nativeSessionId, target})
        ?? dispatch.continuation?.instruction;
    requireValue(instruction, 'CONTINUATION_INSTRUCTION_REQUIRED');
    return {schema:2,dispatch,origin,request:original.request(dispatch.id,instruction)};
}
