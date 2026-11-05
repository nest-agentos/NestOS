import {DEFAULT_KANBAN_WORK_TYPES,type KanbanBoard,type KanbanItem,type KanbanService} from '@nestos/kanban/contracts';
import {analyzeItem as coordinateAnalysis,safeCode,type KanbanAutomationJournal,type KanbanAnalysisObservation} from '@nestos/kanban/integration';
import {t} from '@nestos/common';
import {taskStat,type Kernel,type TaskCallResult} from '@nestos/durable-kernel';
import type {IndependentCallService} from '@nestos/llm-session';
import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import type {TargetRef} from '@nestos/llm-flow/contracts';
import {requireValue} from './validation';
import preset from '../presets/kanban-planning.json';
export interface AnalysisOptions {
    readAnalysisOutput?(id:string):Promise<unknown|undefined>;
    onAnalysis?: import('./personal-automation').PersonalKanbanAutomationOptions['onAnalysis'];
    prepareAnalysis?: import('./personal-automation').PersonalKanbanAutomationOptions['prepareAnalysis'];
    journal: KanbanAutomationJournal; calls: IndependentCallService; kernel: Pick<Kernel, 'task'>;
    prepareSession(id: string): Promise<string>; active(): boolean;
    log(input: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
/** Only NestOS request construction and execution observation live in this adapter. */
export function analyzeItem(options:AnalysisOptions,board:KanbanBoard,item:KanbanItem,target:TargetRef|undefined,service:KanbanService):Promise<void> {
    return coordinateAnalysis<TargetRef,IndependentCallInput>({journal:options.journal,active:options.active,log:options.log,
        inheritReferences:refs=>refs.filter(ref=>['nestos-remote-project','nestos-decision-run'].includes(ref.system)),
        onSettled:options.onAnalysis?async input=>options.onAnalysis!({...input,target:input.request.request.expectedTarget!}):undefined,
        port:{
            prepare:async ({id,board,item,target})=>{
                const prepared=await options.prepareAnalysis?.({id,board,item,target});
                return analysisInput(board,item,prepared?.target??target,id,prepared?.instruction,prepared?.contextRef);
            },
            prepareExecution:async(id,input)=>{await options.prepareSession(id);await options.calls.prepareTaskCall(input,{maxDepth:4,timeoutMs:null});},
            submit:async input=>{await options.calls.submitPreparedTaskCall(input);},
            inspect:(id,input)=>inspectAnalysis(options,id,input),
        },
    },board,item,target,service);
}
function analysisInput(board:KanbanBoard,item:KanbanItem,target:TargetRef,id:string,instruction=preset.instruction,contextRef?:unknown):IndependentCallInput {
    const items=board.items.map(({id,title,responsibility,acceptance,planning,status})=>({id,title,responsibility,acceptance,planning,status}));
    return {title:`${t('kanban.automationAnalysis')} · ${item.number?'#'+item.number+' · ':''}${item.title}`,
        request:{expectedSessionId:id,expectedBranch:'main',expectedTarget:target,target:{kind:target.kind,id:target.id,version:target.version},
            source:{kind:'composer',text:JSON.stringify(contextRef===undefined?{instruction,snapshot:{item,items,workTypes:board.workTypes??DEFAULT_KANBAN_WORK_TYPES,defaultWorkType:board.defaultWorkType??'task'}}:{instruction,contextRef}),attachments:[],values:{}},
            submission:{id,source:{kind:'conversation',ownerId:id,id}}}};
}
async function inspectAnalysis(options:AnalysisOptions,id:string,input:IndependentCallInput):Promise<KanbanAnalysisObservation> {
    const pending={state:'running' as const},admission=await options.calls.inspectTaskCallSubmission(input);
    if(!options.active())return pending;
    if(!admission)return {state:'unknown',code:'AUTOMATION_ADMISSION_UNKNOWN'};
    const views=await options.calls.list({sessionId:id,branchId:'main'}),view=views.find(row=>row.input.request.submission?.id===id);
    if(!options.active()||!view?.callerState?.settled||!view.executionTree?.settled)return pending;
    const record=await options.kernel.task(admission.submission.task.sessionId,admission.submission.task.taskId);
    if(!options.active()||!taskStat(record).settled)return pending;
    const result=record.exit?.output as TaskCallResult|undefined;
    if(record.exit?.status!=='succeeded'||result?.exit.status!=='succeeded')return {state:record.exit?.status==='cancelled'||result?.exit.status==='cancelled'?'cancelled':'failed',code:safeCode(result?.exit.error??record.exit?.error,'AUTOMATION_ANALYSIS_FAILED')};
    requireValue(options.readAnalysisOutput,'SESSION_CHANNEL_RESULT_UNAVAILABLE');
    const output=await options.readAnalysisOutput(id);
    return output===undefined?{state:'unknown',code:'SESSION_CHANNEL_RESULT_PENDING'}:{state:'succeeded',output};
}
