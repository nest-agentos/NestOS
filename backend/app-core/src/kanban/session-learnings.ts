import {createModuleLogger} from '@nestos/common';
import {registerSessionLearnings as register,type SessionLearningInput} from '@nestos/kanban/integration';
import {channelDigest} from '../run/channel-protocol';
const log=createModuleLogger('KanbanLearnings');
/** Supply authorized channel facts and host diagnostics to the Kanban record mechanism. */
export function registerSessionLearnings(input:Omit<SessionLearningInput,'digest'|'diagnostic'>):Promise<void> {
    return register({...input,digest:channelDigest,diagnostic:event=>{
        if(event.result==='failure')log.warn('Session learning',event);else log.info('Session learning',event);
    }});
}
