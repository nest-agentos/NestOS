import {requireValue} from './validation';
import type {DecisionConversation,DecisionConversationOptions} from './decision-conversation-ports';

/** Transport or permission failures cannot establish that a reference is absent. */
export async function unavailableDecisionReference(options:DecisionConversationOptions,value:DecisionConversation):Promise<boolean> {
    const binding=value.binding;if(!binding)return false;
    try {await options.projects.get(binding.projectId);}
    catch(error){if((error as {code?:string}).code==='ENOENT')return true;throw error;}
    if(!value.sessionId||!options.remote.list(binding.projectId).some(root=>root.at==='/'&&root.serverProjectId===binding.workspaceId))return false;
    const client=await options.remote.projectHarness(binding.projectId);
    try {if(!client.inspect)return false;await client.inspect(binding.profileId,value.sessionId);return false;}
    catch(error){if((error as {code?:string}).code==='ENOENT')return true;throw error;}
    finally {await client.close();}
}

/** A lost publication acknowledgement must not make a materialized decision removable. */
export async function verifyDecisionDraftRemoval(options:DecisionConversationOptions,value:DecisionConversation):Promise<void> {
    const [link,coordination,proposal]=await options.journal.getMany<{recordId?:string;record?:{id:string}}>([
        'decision-conversation-record:'+value.id,'record-coordination-scope:'+value.id,'decision-conversation-proposal:'+value.id]);
    requireValue(!link?.recordId&&!coordination?.recordId,'CONVERSATION_HAS_RECORD');
    if(!proposal?.record?.id)return;
    try {await options.service.record(value.boardId,proposal.record.id);}
    catch(error){if((error as {code?:string})?.code==='RECORD_NOT_FOUND')return;throw error;}
    requireValue(false,'CONVERSATION_HAS_RECORD');
}
