import type {TaskRecord} from '@nestos/durable-kernel';
import type {DurableChatOutput} from '@nestos/llm-tasks';
import {formatFlowOutput} from '@nestos/llm-flow/contracts';
import type {Round} from '../contracts/conversation';
/** Project only a confirmed task exit; never infer completion from a quiet stream. */
export function terminalTaskRoundResult(task: TaskRecord): Pick<Round, 'output' | 'status' | 'error' | 'result'> {
    const exit = task.exit!;
    if (exit.status !== 'succeeded') return {output: [], status: exit.status === 'cancelled' ? 'cancelled' : 'failed',
        error: exit.error?.message ?? `Task ${exit.status}`};
    if (task.program.kind === 'flow.aggregate') return {output: [{role: 'assistant', content: formatFlowOutput(exit.output)}], status: 'completed'};
    const output = exit.output as Partial<DurableChatOutput> | null;
    if (!output?.message || output.message.role !== 'assistant'
        || typeof output.message.content !== 'string' && !Array.isArray(output.message.content))
        throw Object.assign(new Error('CALL_RESULT_INVALID'),{code:'CALL_RESULT_INVALID'});
    return {output: [structuredClone(output.message)], status: 'completed', result: {
        assistantBlocks: [{type: 'text', content: structuredClone(output.message.content)}], toolResults: [],
        ...(output.usage ? {usage: structuredClone(output.usage)} : {}),
        ...(output.finishReason ? {finishReason: output.finishReason} : {})}};
}
