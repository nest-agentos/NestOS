import {taskStat,type Kernel} from '@nestos/durable-kernel';
import type {PersistedRound} from '../persistence/round-types';
import {RoundLog} from '../persistence/round-log';
import type {ISessionRepository} from '../persistence/types';
import type {SessionHost} from '../utils/host-ports';
import {terminalTaskRoundResult} from './task-round-result';
/** Repair a queued Round from its exact settled execution, without submitting any work. */
export async function recoverInstructionRound(kernel:Pick<Kernel,'task'|'inspectSession'>,repository:ISessionRepository,round:PersistedRound,host:SessionHost):Promise<'completed'|'failed'|'running'|'uncertain'> {
    const started=Date.now(),primary=round.executions.find(row=>row.role==='primary');
    if(!primary?.invocation)return 'uncertain';
    const task=await kernel.task(round.sessionId,primary.taskId);
    if(task.sessionId!==round.sessionId||task.labels?.roundId!==round.id||task.labels?.invocationId!==primary.invocation.invocationId)throw Object.assign(new Error('QUEUE_HISTORY_EXECUTION_CONFLICT'),{code:'QUEUE_HISTORY_EXECUTION_CONFLICT'});
    const snapshot=await(await kernel.inspectSession(round.sessionId)).snapshot();
    if(!taskStat(task).settled||snapshot.tasks.some(row=>row.rootTaskId===task.rootTaskId&&!taskStat(row).settled))return 'running';
    if(!task.exit)return 'uncertain';
    const result=terminalTaskRoundResult(task),log=new RoundLog(repository,round.sessionId);
    if(result.status==='completed')await log.setAssistantInRound(round.id,{assistantMessages:result.output,result:{...round.result,...result.result,assistantBlocks:result.result?.assistantBlocks??round.result?.assistantBlocks??[],toolResults:round.result?.toolResults??result.result?.toolResults??[]}});
    else await log.setConversationStatus(round.id,result.status!,result.error,round.result);
    host.logger.info('Queued history recovered',{operation:'session.history.recover',operationId:round.id,sessionId:round.sessionId,stage:'terminal-task',result:'success',taskId:task.id,outcome:result.status,durationMs:Date.now()-started});
    return result.status==='completed'?'completed':'failed';
}
