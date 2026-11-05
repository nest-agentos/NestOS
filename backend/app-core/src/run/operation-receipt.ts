import type {IFileSystem} from '@nestos/vfs-core';
import {readPrompt,failure,type PromptJournal} from './prompt-bundle';
import {channelDigest} from './channel-protocol';
/** A scoped durable receipt survives losing the host connection during self replacement. */
export async function operationReceipt(fs:IFileSystem,directory:string,published:unknown,journal:PromptJournal,operationId:string):Promise<unknown|undefined> {
    const path=directory+'/result.json';if(!await fs.driver.exists(path))return published;
    let receipt:unknown;try{receipt=JSON.parse(await readPrompt(fs,path));}catch{throw failure('OPERATION_RESULT_RECEIPT_INVALID');}
    if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw failure('OPERATION_RESULT_RECEIPT_INVALID');
    if(published!==undefined&&channelDigest(published)!==channelDigest(receipt))throw failure('OPERATION_RESULT_RECEIPT_CONFLICT');
    const digest=channelDigest(receipt);
    const saved=await journal.update<{digest:string;payload:unknown}>('operation-receipt:'+operationId,old=>{if(old&&old.digest!==digest)throw failure('OPERATION_RESULT_RECEIPT_CONFLICT');return old??{digest,payload:receipt};});
    return saved.payload;
}
