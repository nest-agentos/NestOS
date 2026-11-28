import {planningCandidates} from './kanban-planning-candidates';
import {planningConversationControl} from './kanban-planning-control';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {DEFAULT_KANBAN_WORK_TYPES} from '@nestos/kanban/contracts';
import {DirectorySubscriptions} from '../run/directory-subscriptions';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {requireValue} from '../kanban/validation';
import type {NativeWorkspaceOptions} from './kanban-native-workspace';
import type {NativeWorkChannel} from './kanban-work-channel';
import {readPlanningChannel} from '../run/planning-channel';

type Workspace=NativeWorkChannel&{directoryOnly?:true};
export function nativeWorkPlanning(options:NativeWorkspaceOptions,prepare:NonNullable<PersonalKanbanAutomationOptions['prepareWork']>,wake:()=>void,
    validate?:(workspace:Workspace,output:unknown)=>void) {
    const journal = new KanbanAutomationJournal(options.fs, kanbanJournalOptions),watches=new DirectorySubscriptions();
    const prepareAnalysis:NonNullable<PersonalKanbanAutomationOptions['prepareAnalysis']>=async input => {
        const preparation=input.board.automation?.preparation;
        requireValue(preparation,'SESSION_CHANNEL_WORKSPACE_REQUIRED');
        const prepared=await prepare({board:input.board,context:{...input.context as object, snapshot:{item:input.item,items:planningCandidates(input.item,input.board.items),workTypes:input.board.workTypes??DEFAULT_KANBAN_WORK_TYPES,defaultWorkType:input.board.defaultWorkType??'task'}},reportActivity:input.reportActivity,target:input.target,preparation,item:input.item,
            options:input.board.automation?.preparationOptions,stage:'decision',
            dispatch:{id:input.id,itemId:input.item.id,itemRevision:input.item.revision,planId:input.id,planRevision:1,
                principal:input.board.automation!.coordinator,definitionDigest:input.target.digest,attempt:1,fence:input.id,
                preparedAt:Date.now(),outcome:'prepared',inputs:{}}});
        const workspace=await journal.get<Workspace>('development-workspace:'+input.id);
        requireValue(workspace,'SESSION_CHANNEL_WORKSPACE_REQUIRED');
        await watch(input.id,workspace.projectId);
        return {target:prepared.target,contextRef:{scopeId:input.id,section:'planning-input'},instruction:'Current stage: active planning. Read `decision.md` via `session_context` and execute its main instructions and references. Lifecycle sections such as postload apply only when explicitly requested in a later lifecycle call. Finish through the planning report protocol.'};
    };
    async function watch(id:string,projectId:string) {
        await watches.ensure(id,async()=>{
            const client=await options.remote.projectHarness(projectId);
            try {requireValue(client.subscribeChannel,'SESSION_CHANNEL_REQUIRED');const stop=client.subscribeChannel(id,wake);
                return async()=>{stop?.();await client.close();};}
            catch(error){await client.close();throw error;}
        });
    }
    return {prepare:prepareAnalysis,control:planningConversationControl(options,journal),dispose:()=>watches.dispose(),async read(id:string) {
        const workspace=await journal.get<Workspace>('development-workspace:'+id);
        requireValue(workspace,'SESSION_CHANNEL_WORKSPACE_REQUIRED');
        await watch(id,workspace.projectId);
        const result=await readPlanningChannel(options.remote,workspace.projectId,id,journal,validate?output=>validate(workspace,output):undefined);
        if(result&&['succeeded','failed','cancelled'].includes(result.state))await watches.close(id);
        return result;
    }};
}
