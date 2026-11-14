import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import {channelDigest} from './channel-protocol';
import {failure, type PromptJournal} from './prompt-bundle';
export interface ChannelMessage {id: string; message: {type: string; content: string; payload?: unknown; replyTo?: string}}
/** Values come from the fixed Cells API; no workspace I/O participates in communication. */
export async function channelMessages(remote: Pick<ProjectRemoteMountService, 'sessionChannel'>, projectId: string, scopeId: string): Promise<ChannelMessage[]> {
    const value = await remote.sessionChannel(projectId, 'messages', {scopeId}) as {messages?: ChannelMessage[]};
    if (!Array.isArray(value?.messages) || value.messages.length > 200) throw failure('CHANNEL_MESSAGES_INVALID');
    if (value.messages.some(row => !row || typeof row.id !== 'string' || !row.message || typeof row.message.type !== 'string')) throw failure('CHANNEL_MESSAGES_INVALID');
    return value.messages;
}
export async function readChannelResult(remote: Pick<ProjectRemoteMountService, 'sessionChannel'>, projectId: string, scopeId: string, journal: PromptJournal, options:{reportErrors?:boolean}={}): Promise<unknown | undefined> {
    const messages=await channelMessages(remote,projectId,scopeId),results=messages.filter(row => row.message.type === 'result');
    if (!results.length) {
        const error=options.reportErrors?messages.filter(row=>row.message.type==='error').map(row=>row.message.payload as {operationId?:unknown;code?:unknown}|undefined)
            .reverse().find(value=>value?.operationId===scopeId&&typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)):undefined;
        if(error)throw failure(error.code as string);
        return undefined;
    }
    if (results.length !== 1 || !Object.hasOwn(results[0].message, 'payload')) throw failure('CHANNEL_RESULT_INVALID');
    const payload = results[0].message.payload, digest = channelDigest(payload);
    const saved = await journal.update<{digest: string; payload: unknown}>('channel-result:' + scopeId, old => {
        if (old && old.digest !== digest) throw failure('CHANNEL_RESULT_CHANGED');
        return old ?? {digest, payload};
    });
    return saved.payload;
}
export const channelResultInstruction = 'Publish the structured payload through session_report({id:<stable-id>,message:{type:"result",content:<short summary>,payload:<required structured result>}}). Publish exactly one final result and preserve its id and content on retries. The host validates it after the native turn ends.';
