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
