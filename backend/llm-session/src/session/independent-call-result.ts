import {terminalTaskRoundResult} from './task-round-result';
import {taskStat, type TaskRecord} from '@nestos/durable-kernel';
import {type DagRunSpec, type JsonValue} from '@nestos/llm-flow/contracts';
import type {Round} from '../contracts/conversation';
import type {SubmissionRequest} from '../contracts/submission';
import type {PreparedIndependentTaskCall} from './independent-call-preparation';
import {submissionInstruction} from './submission-input';
import {instructionDigest, prepareInstruction} from './instruction-queue-rules';
import {conversationUserMessage} from './conversation-attachments';

/** Terminal history is a deterministic projection of the original request and real target. */
export async function independentCallResult(request: SubmissionRequest, ready: PreparedIndependentTaskCall,
    task: TaskRecord): Promise<Round | undefined> {
    if (!taskStat(task).settled || !task.exit) return;
    if (task.sessionId !== ready.executionSessionId || task.labels?.roundId !== request.submission!.id
        || task.labels?.invocationId !== ready.invocation.invocationId) throw invalid('CALL_EXECUTION_CONFLICT');
    const input = prepareInstruction(submissionInstruction(request), task.sessionId, request.expectedBranch!);
    const temporary = input.sendIntent?.retention.mode === 'temporary';
    const flow = flowHistory(task);
    return {id: request.submission!.id, sessionId: task.sessionId, submission: structuredClone(request.submission),
        submissionDigest: await instructionDigest(input), historyParentIds: [],
        input: [conversationUserMessage(input.text, input.files)], ...terminalTaskRoundResult(task),
        executions: [{taskId: task.id, role: 'primary', invocation: structuredClone(ready.invocation)}],
        createdAt: task.createdAt, completedAt: task.exit.completedAt, origin: 'user',
        ...(request.expectedTarget!.kind === 'agent' ? {agentId: request.expectedTarget!.id} : {}), target: structuredClone(request.expectedTarget),
        ...(flow ? {flow} : {}),
        callInput: {source: structuredClone(request.source)}, exposure: temporary ? 'internal' : 'public',
        defaultContextMode: temporary ? 'exclude' : 'include', defaultContextScope: 'subtree'};
}

function flowHistory(task: TaskRecord): Round['flow'] {
    if (task.program.kind !== 'flow.aggregate') return;
    const initial = (task.input as {initialScheduler?: {spec: DagRunSpec; parameters?: Record<string, JsonValue>}}).initialScheduler;
    const invocation = initial?.spec.invocation;
    if (!invocation) return;
    return {flowId: invocation.flowId as import('@nestos/llm-flow/contracts').FlowId, revision: invocation.revision, input: structuredClone(initial!.spec.input),
        ...(initial?.parameters ? {parameters: structuredClone(initial.parameters)} : {})};
}
function invalid(code: string): Error {return Object.assign(new Error(code), {code});}
