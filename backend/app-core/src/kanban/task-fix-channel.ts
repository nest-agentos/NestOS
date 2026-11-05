import type {Options} from './task-fix-contracts';
import type {Definition,SavedFix} from '@nestos/kanban/integration';
import {requireValue} from './validation';
import type {ChannelMessage} from '../run/channel-results';
export function parseDefinition(input:unknown,originalId:string):Definition {
    const value=input as Definition&{schema:string};
    requireValue(value?.schema==='kanban.fix-proposal/1'&&value.type==='fix','FIX_DEFINITION_INVALID');
    requireValue(['title','responsibility','acceptance'].every(key=>typeof value[key as keyof Definition]==='string'&&String(value[key as keyof Definition]).trim().length>0&&String(value[key as keyof Definition]).length<=8000),'FIX_DEFINITION_INVALID');
    requireValue(Array.isArray(value.dependencies)&&value.dependencies.length===1&&value.dependencies[0]===originalId,'FIX_DEPENDENCY_REQUIRED');
    return {title:value.title,responsibility:value.responsibility,acceptance:value.acceptance,type:'fix',dependencies:[originalId]};
}
export async function fixMessages(options:Options,fix:SavedFix):Promise<ChannelMessage[]> {
    requireValue(options.automation.sessionChannel,'SESSION_CHANNEL_REQUIRED');
    const value=await options.automation.sessionChannel(fix.resourceId,'messages',{scopeId:fix.id}) as {messages?:ChannelMessage[]};
    requireValue(Array.isArray(value?.messages)&&value.messages.length<=200,'CHANNEL_MESSAGES_INVALID');
    return value.messages;
}
