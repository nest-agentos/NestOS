import type {KanbanDispatch,KanbanFixSession} from '@itookit/kanban/contracts';
import type {SessionInstruction} from '@itookit/llm-session/contracts';
import type {Options,SavedFix} from './task-fix-contracts';
import {createPublishedKanbanWorkExecutor} from './published-work';
import {automationTarget} from './automation-targets';
import {acceptSnapshot} from './task-fix-acceptance';
import {observeFixMessages} from './task-fix-messages';
import {confirmFix} from './task-fix-confirmation';
import {freezeFix} from './task-fix-preparation';
import {requireValue} from './validation';
import {safeCode} from './automation-analysis';

export function createTaskFix(options:Options) {return new TaskFix(options);}
/** Confirmation and admission use durable identities; Session observation cannot create another task. */
class TaskFix {
    private readonly executor;
    constructor(private readonly options:Options) {
        this.executor=createPublishedKanbanWorkExecutor({...options.automation,prepareSession:options.prepareSession,binding:dispatch=>this.binding(dispatch)});
    }
    private async binding(dispatch:KanbanDispatch) {
        const {options}=this,fix=(await options.journal.get<SavedFix>('fix:'+dispatch.id))!;
        const board=await options.service.read(fix.boardId);
        requireValue(board.automation?.preparation&&options.automation.prepareWork,'FIX_PREPARATION_UNAVAILABLE');
        const target=await options.automation.prepareWork({stage:'fix',context:fix.context,dispatch,item:fix.item,
            target:automationTarget(board.automation.executor,await options.automation.catalog()),preparation:board.automation.preparation,options:board.automation.preparationOptions});
        return {target};
    }
    private async prepare(fix:SavedFix):Promise<SavedFix> {
        if(fix.request)return fix;
        const work=await this.executor.prepare(fix.dispatch,{...fix.item,responsibility:'Clarify a new fix task. Read _nestos/kanban/prompts/task-fix-pre.md and frozen context.input. Do not develop or rerun the original task.'});
        return this.options.journal.update<SavedFix>('fix:'+fix.id,old=>({...old!,request:old!.request??work}));
    }
    private async advance(fix:SavedFix):Promise<KanbanFixSession> {
        const {options}=this;fix=await this.prepare(fix);
        if(fix.snapshot) {await acceptSnapshot(options,fix);return view((await options.journal.get<SavedFix>('fix:'+fix.id))!);}
        const claimed=await options.journal.claim('fix:'+fix.id);
        const observation=await (claimed?this.executor.start(fix.request):this.executor.inspect(fix.request));
        const sessionId=observation.executionSessionId??fix.sessionId;
        if(sessionId!==fix.id)await options.journal.update('fix-session:'+sessionId,old=>old??fix.id);
        const saved=await options.journal.update<SavedFix>('fix:'+fix.id,old=>({...old!,sessionId,code:observation.code}));
        await observeFixMessages(options,saved);return view(saved);
    }
    fixTask=async(boardId:string,request:{itemId:string;operationId:string}):Promise<KanbanFixSession>=>this.advance(await freezeFix(this.options,boardId,request));
    intercept=async(sessionId:string,input:SessionInstruction):Promise<boolean>=>{
        const id=await this.options.journal.get<string>('fix-session:'+sessionId);if(!id)return false;
        const fix=(await this.options.journal.get<SavedFix>('fix:'+id))!;
        return confirmFix(this.options,fix,input);
    };
    scan=async()=>{
        for(const id of await this.options.journal.get<string[]>('fix-index')??[]) {
            const fix=await this.options.journal.get<SavedFix>('fix:'+id);if(!fix||fix.accepted)continue;
            try {await this.advance(fix);} catch(error) {this.options.log({operationId:id,boardId:fix.boardId,stage:'fix.recover',result:'failure',code:safeCode(error,'FIX_RECOVERY_FAILED'),durationMs:0});}
        }
    };
}
function view(fix:SavedFix):KanbanFixSession {const {id,boardId,itemId,sessionId,state,createdItemId}=fix;return {id,boardId,itemId,sessionId,state,createdItemId};}
