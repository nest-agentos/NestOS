import {kanbanConversationPolicy as defaults} from '../resources/catalog';
import type {IFileSystem} from '@nestos/vfs-core';
import {readPrompt} from '../run/prompt-bundle';
import {requireValue} from './validation';
/** Confirmation words and small communication prompts use the same managed global resource. */
export async function conversationPolicy(fs:IFileSystem):Promise<typeof defaults> {
    const path='/etc/kanban/development/conversation-policy.json';
    const saved=await fs.driver.exists(path)?JSON.parse(await readPrompt(fs,path)) as typeof defaults:defaults;
    const policy={...defaults,...saved};
    requireValue(policy?.schema===1&&Object.keys(defaults).filter(key=>key!=='schema').every(key=>typeof policy[key as keyof typeof defaults]==='string'&&String(policy[key as keyof typeof defaults]).length>0&&String(policy[key as keyof typeof defaults]).length<=2000),'CONVERSATION_POLICY_INVALID');
    return policy;
}
export function conversationInstruction(template:string,requestId:string):string {return template.replaceAll('{{requestId}}',requestId);}
