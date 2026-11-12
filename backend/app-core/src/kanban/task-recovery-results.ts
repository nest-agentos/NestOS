import {resumeTaskResultRecovery} from '@nestos/kanban/integration';
import {workContext} from './work-context';
import type {TaskRecoveryOptions} from './task-recovery-ports';
import type {KanbanTaskRecoveryRequest,KanbanTaskRecoveryResult} from '@nestos/kanban/contracts';
interface Ports {active():boolean;inspect:typeof import('./task-recovery-state').taskRecoveryState;recoverTask(board:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult>}
/** The application supplies authority and host evidence; Kanban owns recovery admission and progression. */
export async function resumeCompletedResults(options:TaskRecoveryOptions,ports:Ports):Promise<void> {
    await resumeTaskResultRecovery({journal:options.journal,service:options.service,active:ports.active,log:options.log,recover:ports.recoverTask,
        inspect:(board,item)=>ports.inspect(options,board,item),authorized:async(board,item)=>{
            const context=await workContext(options.journal,board,item,options.service);
            return (context.decision?.snapshot as {completion?:string})?.completion==='automatic'&&!!context.decision
                &&(await options.service.record(context.decision.sourceBoardId,context.decision.recordId)).status==='confirmed';
        }});
}
