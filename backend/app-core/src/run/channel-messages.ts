import {channelDigest} from './channel-protocol';
import {failure, type PromptJournal} from './prompt-bundle';
import {unresolvedWorkIssues, parseWorkMessage, type WorkMessage, type WorkMessageScope} from '@nestos/kanban/execution';
interface Row {id:string;message:unknown}
interface Receipt {digest:string;delivered:boolean;acknowledged?:boolean}
/** Freeze every publication before delivery; receipts survive lost acknowledgements and restarts. */
export async function consumeChannelMessages(value: unknown, scope: WorkMessageScope, journal: PromptJournal,
    deliver: (message: WorkMessage) => Promise<void | {pending: true}>, acknowledge?: (message: WorkMessage) => Promise<void>): Promise<WorkMessage[]> {
    const rows = (value as {messages?: Row[]})?.messages;
    if (!Array.isArray(rows) || rows.length > 200) throw failure('CHANNEL_MESSAGES_INVALID');
    const messages = parseMessages(rows,scope);
    await journal.update<string[]>('channel-message-index:' + scope.attemptId, old => {
        if (old?.some(id => !rows.some(row => row.id === id))) throw failure('CHANNEL_MESSAGE_MISSING');
        return rows.map(row => row.id);
    });
    for (const row of rows) await freezeMessage(journal,scope,row);
    for (const message of messages) {
        const key = messageKey(scope,message.id),saved = (await journal.get<Receipt>(key))!;
        let delivered = saved.delivered;
        if (!delivered && !(await deliver(message))?.pending) {
            await journal.update<Receipt>(key, old => ({...old!, delivered: true})); delivered = true;
        }
        if (delivered && acknowledge && !saved.acknowledged) {
            await acknowledge(message);
            await journal.update<Receipt>(key,old=>({...old!,acknowledged:true}));
        }
    }
    return messages;
}
function parseMessages(rows:Row[],scope:WorkMessageScope):WorkMessage[] {
    const messages:WorkMessage[]=[];
    for(const row of rows) {
        if(!row||typeof row.id!=='string'||!row.message||typeof row.message!=='object'||Array.isArray(row.message))throw failure('CHANNEL_MESSAGE_INVALID');
        const {payload:_payload,...body}=row.message as Record<string,unknown>;
        if(Object.keys(body).some(key=>!['type','content','replyTo'].includes(key)))throw failure('CHANNEL_MESSAGE_INVALID');
        if(body.type==='proposal')continue;
        messages.push(parseWorkMessage(JSON.stringify({...body,schema:'work-message/2',...scope,id:row.id}),scope,JSON.parse));
    }
    if(new Set(rows.map(row=>row.id)).size!==rows.length)throw failure('CHANNEL_MESSAGE_INVALID');
    unresolvedWorkIssues(messages);
    return messages.sort((a,b)=>Number(a.type==='resolved')-Number(b.type==='resolved'));
}
async function freezeMessage(journal:PromptJournal,scope:WorkMessageScope,row:Row):Promise<void> {
    const digest=channelDigest({id:row.id,message:row.message});
    await journal.update<Receipt>(messageKey(scope,row.id),old=>{
        if(old&&old.digest!==digest)throw failure('CHANNEL_MESSAGE_CHANGED');
        return old??{digest,delivered:false};
    });
}
const messageKey=(scope:WorkMessageScope,id:string)=>'channel-message:'+scope.attemptId+':'+id;
