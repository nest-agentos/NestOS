import {channelDigest} from './channel-protocol';
import {failure, type PromptJournal} from './prompt-bundle';
import {parseWorkMessage, type WorkMessage, type WorkMessageScope} from '@nestos/kanban/execution';
import {createModuleLogger} from '@nestos/common';
interface Row {id:string;message:unknown}
interface Receipt {digest:string;delivered:boolean;acknowledged?:boolean;rejection?:string}
const log=createModuleLogger('kanban.channel');
/** Freeze every publication before delivery; receipts survive lost acknowledgements and restarts. */
export async function consumeChannelMessages(value: unknown, scope: WorkMessageScope, journal: PromptJournal,
    deliver: (message: WorkMessage) => Promise<void | {pending: true}>, acknowledge?: (message: WorkMessage, rejection?:string) => Promise<void>): Promise<WorkMessage[]> {
    const rows = (value as {messages?: Row[]})?.messages;
    if (!Array.isArray(rows) || rows.length > 200) throw failure('CHANNEL_MESSAGES_INVALID');
    const messages = parseMessages(rows,scope);
    await journal.update<string[]>('channel-message-index:' + scope.attemptId, old => {
        if (old?.some(id => !rows.some(row => row.id === id))) throw failure('CHANNEL_MESSAGE_MISSING');
        return rows.map(row => row.id);
    });
    const issues=new Set(messages.filter(message=>message.type==='error'||message.type==='clarification').map(message=>message.id));
    const invalid=new Set(messages.filter(message=>message.type==='resolved'&&!issues.has(message.replyTo!)).map(message=>message.id));
    for (const row of rows) await freezeMessage(journal,scope,row,invalid.has(row.id)?'WORKSPACE_RESOLUTION_INVALID':undefined);
    const accepted:WorkMessage[]=[];
    for (const message of messages) {
        const key = messageKey(scope,message.id),saved = (await journal.get<Receipt>(key))!;
        if(saved.rejection){
            if(!saved.acknowledged&&acknowledge)await acknowledgeMessage(journal,key,message,acknowledge,saved.rejection);
            continue;
        }
        accepted.push(message);
        let delivered = saved.delivered;
        if (!delivered && !(await deliver(message))?.pending) {
            await journal.update<Receipt>(key, old => ({...old!, delivered: true})); delivered = true;
        }
        if (delivered && acknowledge && !saved.acknowledged) {
            await acknowledgeMessage(journal,key,message,acknowledge);
        }
    }
    return accepted;
}
async function acknowledgeMessage(journal:PromptJournal,key:string,message:WorkMessage,
    acknowledge:(message:WorkMessage,rejection?:string)=>Promise<void>,rejection?:string):Promise<void>{
    await acknowledge(message,rejection);
    await journal.update<Receipt>(key,old=>({...old!,acknowledged:true}));
}
function parseMessages(rows:Row[],scope:WorkMessageScope):WorkMessage[] {
    const messages:WorkMessage[]=[];
    for(const row of rows) {
        if(!row||typeof row.id!=='string'||!row.message||typeof row.message!=='object'||Array.isArray(row.message))throw failure('CHANNEL_MESSAGE_INVALID');
        const {payload,...body}=row.message as Record<string,unknown>;
        if(Object.keys(body).some(key=>!['type','content','replyTo'].includes(key)))throw failure('CHANNEL_MESSAGE_INVALID');
        if(body.type==='proposal')continue;
        const handler=['error','clarification'].includes(String(body.type))?(payload as {handler?:unknown}|undefined)?.handler:undefined;
        messages.push(parseWorkMessage(JSON.stringify({...body,...(handler===undefined?{}:{handler}),schema:'work-message/2',...scope,id:row.id}),scope,JSON.parse));
    }
    if(new Set(rows.map(row=>row.id)).size!==rows.length)throw failure('CHANNEL_MESSAGE_INVALID');
    return messages.sort((a,b)=>Number(a.type==='resolved')-Number(b.type==='resolved'));
}
async function freezeMessage(journal:PromptJournal,scope:WorkMessageScope,row:Row,rejection?:string):Promise<void> {
    const started=Date.now();
    const digest=channelDigest({id:row.id,message:row.message});
    await journal.update<Receipt>(messageKey(scope,row.id),old=>{
        if(old&&old.digest!==digest)throw failure('CHANNEL_MESSAGE_CHANGED');
        if(!old&&rejection)log.warn('Workspace publication rejected',{operation:'kanban.channel',stage:'publication.validate',result:'failure',
            operationId:row.id,attemptId:scope.attemptId,code:rejection,durationMs:Date.now()-started});
        return old??{digest,delivered:false,...(rejection?{rejection}:{})};
    });
}
const messageKey=(scope:WorkMessageScope,id:string)=>'channel-message:'+scope.attemptId+':'+id;
