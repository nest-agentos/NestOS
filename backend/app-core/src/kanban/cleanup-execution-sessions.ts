import {sha256HexSync} from '@nestos/common';
import type {KanbanClient} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import {planningSessionReader} from './planning-sessions';
import {requireValue} from './validation';
/** Automatic software cleanup may archive execution Sessions, never their retained management Session. */
export async function cleanupExecutionSessions(service:KanbanClient,journal:KanbanAutomationJournal,options:PersonalKanbanAutomationOptions,board:string,itemId:string,operationId:string):Promise<boolean> {
    const {item}=await service.item(board,itemId),management=item.purpose==='planning'||item.taskType==='coordination'||item.planning?.execution==='children'
        ?await planningSessionReader(service,journal,options)(board,itemId):undefined;
    requireValue(service.executionSession,'ECAPABILITY');
    const execution=await service.executionSession(board,itemId,{includeRelated:true});
    const sessions=new Set([execution.current?.sessionId,...execution.sessions?.map(row=>row.sessionId)??[],...execution.history.map(row=>row.sessionId)].filter((id):id is string=>!!id));
    for(const session of sessions){
        if(session===management?.sessionId||management?.resourceId&&await options.executionResource?.(session,'main')===management.resourceId)continue;
        try{await options.archiveSession?.(session,operationId+'-archive-'+sha256HexSync(session).slice(0,12));}
        catch(error){if(['SESSION_ARCHIVE_STILL_RUNNING','SESSION_ARCHIVE_OUTCOME_UNKNOWN'].includes((error as {code:string}).code))return false;throw error;}
    }
    return true;
}
