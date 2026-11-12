import {type IndependentCallExecutionReader} from '@nestos/llm-session';
import {contextReferenceInstruction} from '../run/context-reference-instruction';
import {formatPromptSections} from '@nestos/llm-context/prompt';
import type {IndependentCallService} from '@nestos/llm-session';
import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import type {TargetRef} from '@nestos/llm-flow/contracts';
import type {KanbanDispatch, KanbanItem} from '@nestos/kanban/contracts';
import type {KanbanExecutionPort, KanbanExecutionObservation} from '@nestos/kanban/execution';
import {KanbanError} from '@nestos/kanban';
interface WorkExecutionPolicy {maxDepth: number; timeoutMs?: number | null}
interface FrozenWork {schema: 1; dispatch: KanbanDispatch; input: IndependentCallInput; policy: WorkExecutionPolicy}
export interface PublishedKanbanWorkOptions {
    onSessionPrepared?(dispatch: KanbanDispatch, item: KanbanItem, sessionId: string): Promise<void>;
    title?(dispatch: KanbanDispatch, item: KanbanItem): string;
    observe?(dispatch: KanbanDispatch, observation: KanbanExecutionObservation): Promise<KanbanExecutionObservation>;
    calls: Pick<IndependentCallService,'prepareTaskCall'|'submitPreparedTaskCall'|'inspectTaskCallSubmission'|'list'>; execution:Pick<IndependentCallExecutionReader,'inspect'>;
    /** Stable Session preparation is owned by the host's existing session journal. */
    prepareSession(dispatchId: string): Promise<string>;
    binding(dispatch: KanbanDispatch, item: KanbanItem): Promise<{target: TargetRef; contextRef?: unknown; instruction?: string; dependencies?: unknown; overrides?: IndependentCallInput['request']['overrides']}>;
    context?(dispatch: KanbanDispatch, item: KanbanItem): Promise<unknown>;
    executionPolicy?: WorkExecutionPolicy;
}
/** Reuse published admission and execution facts; uncertain effects only request fenced reconciliation. */
export function createPublishedKanbanWorkExecutor(options: PublishedKanbanWorkOptions): KanbanExecutionPort {
    return {
        async prepare(dispatch: KanbanDispatch, item: KanbanItem): Promise<FrozenWork> {
            const sessionId=await options.prepareSession(dispatch.id);
            await options.onSessionPrepared?.(dispatch, item, sessionId);
            const binding=await options.binding(dispatch, item);
            const input: IndependentCallInput={title:options.title?.(dispatch, item) ?? `${item.number ? '#' + item.number + ' · ' : ''}${item.title}`, request:{expectedSessionId:sessionId,expectedBranch:'main',expectedTarget:binding.target,
                target:{kind:binding.target.kind,id:binding.target.id,version:binding.target.version},overrides:binding.overrides,
                source:{kind:'composer',text:binding.contextRef!==undefined?referencePrompt(binding):formatPromptSections( [{title:'Task',content:{item,inputs:dispatch.inputs,dependencies:await options.context?.(dispatch,item),planId:dispatch.planId,planRevision:dispatch.planRevision}}]),attachments:[],values:{}},
                submission:{id:dispatch.id,source:{kind:'conversation',ownerId:sessionId,id:dispatch.id}}}};
            return {schema:1,dispatch:structuredClone(dispatch),input,policy:structuredClone(options.executionPolicy ?? {maxDepth:4, timeoutMs: null})};
        },
        async start(value) {
            const frozen=validateFrozen(value);
            try {await options.calls.prepareTaskCall(frozen.input,frozen.policy);}
            catch(error) {if (isStopping(error)) throw unstarted(error); return {outcome:'failed',code:knownCode(error,'WORK_PREPARATION_FAILED')};}
            try {await options.calls.submitPreparedTaskCall(frozen.input);}
            catch (error) {
                if (isStopping(error) && !await options.calls.inspectTaskCallSubmission(frozen.input)) throw unstarted(error);
                throw error;
            }
            const observation = await inspectWork(options,frozen);
            return options.observe ? options.observe(frozen.dispatch, observation) : observation;
        },
        inspect: async value => {const frozen = validateFrozen(value), observation = await inspectWork(options, frozen);
            return options.observe ? options.observe(frozen.dispatch, observation) : observation;},
    };
}
async function inspectWork(options: PublishedKanbanWorkOptions, frozen: FrozenWork): Promise<KanbanExecutionObservation> {
    const {sessionId,output,...observation}=await options.execution.inspect(frozen.input);
    return {...observation,...(sessionId?{executionSessionId:sessionId}:{}),...(observation.outcome==='succeeded'?{outputs:[]}:{})};
}
function validateFrozen(value: unknown): FrozenWork {
    const frozen=value as FrozenWork;
    if(frozen?.schema!==1||!frozen.dispatch?.id||!frozen.policy||frozen.input?.request?.submission?.id!==frozen.dispatch.id) throw new KanbanError('INVALID_FROZEN_EXECUTION');return frozen;
}
function knownCode(error: unknown, fallback: string): string {const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:fallback;}

function isStopping(error: unknown): boolean {return ['SERVICE_STOPPING', 'DISPOSED'].includes(knownCode(error, ''));}
/** Only a definite lack of admission allows replaying the same frozen request after restart. */
function unstarted(error: unknown): Error {
    return Object.assign(new KanbanError(knownCode(error, 'SERVICE_STOPPING')), {executionOutcome: 'not-started', retryable: true});
}

function referencePrompt(binding:{contextRef?:unknown;instruction?:string;dependencies?:unknown}):string {
    const text=contextReferenceInstruction(binding.contextRef,binding.instruction);
    return binding.dependencies===undefined?text:text+'\n\n'+formatPromptSections([{title:'Dependencies',content:binding.dependencies}]);
}
