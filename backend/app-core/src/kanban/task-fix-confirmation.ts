import fixPolicy from '../presets/kanban-fix.json';
import {sha256HexSync} from '@nestos/common';
import type {SessionInstruction} from '@nestos/llm-session/contracts';
import type {Options,SavedFix,Snapshot} from './task-fix-contracts';
import {parseDefinition,fixMessages} from './task-fix-channel';
import {acceptSnapshot} from './task-fix-acceptance';
import {requireValue} from './validation';
export async function confirmFix(options:Options,fix:SavedFix,input:SessionInstruction):Promise<boolean> {
    const id=fix.id;
    await options.service.read(fix.boardId);
    const digest=sha256HexSync(JSON.stringify({id:input.id,text:input.text,files:input.files,source:input.source}));
    if(fix.snapshot) {
        requireValue(fix.snapshot.messageId===input.id&&fix.snapshot.digest===digest,'FIX_INPUT_CLOSED');
        await acceptSnapshot(options,fix);return true;
    }
    if(input.text.trim()!==fixPolicy.confirmation||input.files.length||input.origin&&input.origin!=='user'||input.source&&(input.source.kind!=='composer'||input.source.attachments.length>0))return false;
    const proposal=(await fixMessages(options,fix)).filter(row=>row.message.type==='proposal').at(-1);
    requireValue(proposal,'FIX_PROPOSAL_REQUIRED');
    const definition=parseDefinition(proposal.message.payload,fix.item.id);
    const snapshot:Snapshot={proposalId:proposal.id,messageId:input.id,content:fixPolicy.confirmation,definition,digest,operationId:'fix-'+sha256HexSync(JSON.stringify([id,input.id])).slice(0,48)};
    const frozen=await options.journal.update<SavedFix>('fix:'+id,old=>{
        requireValue(!old?.snapshot||old.snapshot.messageId===snapshot.messageId&&old.snapshot.digest===digest,'FIX_INPUT_CLOSED');
        return old?.snapshot?old:{...old!,snapshot,state:'frozen'};
    });
    await acceptSnapshot(options,frozen);return true;
}
