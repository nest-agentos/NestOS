import {FSError,type IFileSystem} from '@itookit/vfs-core';
import {parseSessionFile} from './session-file-result';
import {publishImmutableFile as publishFile, readPrompt} from './prompt-bundle';
import {consumeWorkMessages,parseWorkMessage,unresolvedWorkIssues} from '@itookit/kanban/execution';
import type {WorkMessage,WorkMessageScope} from '@itookit/kanban/execution';
export type WorkspaceMessage=WorkMessage;
export type WorkspaceMessageScope=WorkMessageScope;
interface Journal {get<T>(key:string):Promise<T|undefined>;update<T>(key:string,change:(old:T|undefined)=>T):Promise<T>}
export async function initializeWorkspaceMessages(fs: IFileSystem, directory: string, scope: WorkspaceMessageScope): Promise<void> {
    for (const name of ['inbox', 'outbox', 'artifacts']) {
        try {await fs.driver.createDirectory({parentPath: directory, name, recursive: true});}
        catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
    }
    const base = {schema: 'work-message/1', ...scope, types: ['progress', 'clarification', 'error', 'result'],
        publication: 'Write YAML to a temporary file, then atomically rename to inbox/<id>.yaml. Published messages are immutable.', maxBytes: 65536};
    const protocol = JSON.stringify({...base, extensions: {schema:'work-message/2', types:['resolved'], replyTo:'Required for resolved; references one clarification/error in the same attempt'},
        paths:{agent:'inbox/<event-id>.yaml', host:'outbox/<reply-id>.yaml'}, directions:{agent:['progress','clarification','error','result','resolved'],host:['accepted','user-response','control']}, limits:{contentChars:8000,entries:200,depth:20,nodes:5000},
        receipts:'A durable business commit and notification precede outbox/ack-<id>.yaml; duplicate wakes repair pending delivery.',
        fix:{schema:'kanban.fix/1',directory:'fix/<fix-session-id>',definition:'kanban.yaml',confirmation:'host-frozen snapshot required'}, message: {schema: 'work-message/1', ...scope, id: '<unique-id>',
        type: 'progress', content: '<message text, at most 8000 characters>'}, bodyAlias: 'Legacy body is accepted only when content is absent.'});
    if (await fs.driver.exists(directory + '/protocol.json')) {
        const existing = await readPrompt(fs, directory + '/protocol.json');
        const legacyBase={...base,publication:'Write a temporary file, then atomically rename to inbox/<id>.json. Published messages are immutable.'};
        const legacyProtocol={...legacyBase,message:{schema:'work-message/1',...scope,id:'<unique-id>',type:'progress',content:'<message text, at most 8000 characters>'},bodyAlias:'Legacy body is accepted only when content is absent.'};
        if (existing !== protocol && !legacyMessageProtocol(existing, scope) && existing !== JSON.stringify(base) && existing !== JSON.stringify(legacyBase) && existing !== JSON.stringify(legacyProtocol)) throw new FSError('ECONFLICT', 'Workspace protocol identity changed');
    } else await fs.driver.createFile({parentPath: directory, name: 'protocol.json', content: protocol});
}

function legacyMessageProtocol(raw: string, scope: WorkspaceMessageScope): boolean {
    const base = {schema: 'work-message/1', ...scope, types: ['progress', 'clarification', 'error', 'result'],
        publication: 'Write YAML to a temporary file, then atomically rename to inbox/<id>.yaml. Published messages are immutable.', maxBytes: 65536};
    return raw === JSON.stringify({...base, message: {schema: 'work-message/1', ...scope, id: '<unique-id>',
        type: 'progress', content: '<message text, at most 8000 characters>'}, bodyAlias: 'Legacy body is accepted only when content is absent.'});
}

export function consumeWorkspaceMessages(fs:IFileSystem,directory:string,scope:WorkspaceMessageScope,journal:Journal,deliver:(message:WorkspaceMessage)=>Promise<void|{pending:true}>) {
    return consumeWorkMessages(fs,directory,scope,journal,deliver,parseSessionFile,(directory,name,content)=>publishFile(fs,directory,name,content));
}
export function parseWorkspaceMessage(text:string,scope:WorkspaceMessageScope):WorkspaceMessage {return parseWorkMessage(text,scope,parseSessionFile);}

export const unresolvedWorkspaceIssues=unresolvedWorkIssues;
