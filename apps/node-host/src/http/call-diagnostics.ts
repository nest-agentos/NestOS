import { conversationOpenSources, InputAssetCommand, resolveBrowserTarget } from '@nestos/app-contracts';
import type { Call, Reply } from '@nestos/app-transport/rpc';

/** Only registered operations and bounded metadata may enter the audit log. */
export function callDiagnostics(calls: Call[], operations: string[], commands: ReadonlySet<string>) {
    const rpcCommands = calls.flatMap((call, index) => operations[index] === 'ICommandBus.execute'
        && typeof call.args[0] === 'string' && commands.has(call.args[0]) ? [call.args[0]] : []);
    const uploads = calls.flatMap((call, index) => {
        if (operations[index] !== 'ICommandBus.execute') return [];
        if (call.args[0] === InputAssetCommand.ImportFile) return [fileMetadata(call.args[1])];
        if (call.args[0] !== InputAssetCommand.Import) return [];
        const argument = call.args[1] as {$object?: {url?: unknown}; url?: unknown} | undefined;
        const url = (argument?.$object ?? argument)?.url;
        const prefix = typeof url === 'string' && /^data:(image\/[a-z0-9.+-]{1,32});base64,/i.exec(url.slice(0, 128));
        if (!prefix || typeof url !== 'string') return [{mimeType: 'unknown'}];
        const encoded = url.length - prefix[0].length;
        return [{mimeType: prefix[1].toLowerCase(), bytes: Math.max(0, Math.floor(encoded * 3 / 4) - (url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0))}];
    });
    const rpcUnavailable = calls.flatMap((call, index) => operations[index]?.startsWith('unknown.') && /^(?:client|server):(?:[a-f0-9-]{36}:)?[0-9]{1,10}$/.test(call.target)
        ? [{target: call.target, method: operations[index].slice(8)}] : []);
    const conversationOpens = calls.flatMap((call,index)=>{
        const rpc=operations[index];
        if(rpc==='ConversationWorkbenchView.openConversation')return conversationOpen(call.args[0],call.args[1]);
        if(rpc==='ApplicationBackend.openWorkbench'||rpc==='ApplicationBackend.openConversationWorkbench'){
            const request=call.args[0] as {$object?:{resourceId?:unknown;trace?:unknown}}|undefined;
            return conversationOpen(request?.$object?.resourceId,request?.$object?.trace);
        }
        return [];
    });
    return {...(rpcUnavailable.length ? {rpcUnavailable} : {}), ...(rpcCommands.length ? {rpcCommands} : {}), ...(uploads.length ? {uploads} : {}),
        ...(conversationOpens.length?{conversationOpens}:{})};
}

function conversationOpen(resource:unknown,wire:unknown) {
    if(typeof resource!=='string'||resource.length>4096)return [];
    const envelope=wire as {$object?:{operationId?:unknown;parentOperationId?:unknown;source?:unknown}}|undefined;
    const trace=envelope?.$object;
    if(!trace||!traceId(trace.operationId)||!conversationOpenSources.some(source=>source===trace.source))return [];
    try {
        const target=resolveBrowserTarget(resource);
        if(target.kind!=='remote'||!target.nativeSessionId||!/^[a-zA-Z0-9_-]{1,128}$/.test(target.nativeSessionId))return [];
        return [{operationId:trace.operationId,source:trace.source,sessionId:target.nativeSessionId,
            ...(traceId(trace.parentOperationId)?{parentOperationId:trace.parentOperationId}:{})}];
    } catch {return [];}
}
function traceId(value:unknown):value is string {
    return typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

function fileMetadata(value: unknown): {mimeType: string; bytes?: number} {
    const argument = value as {$object?: {mimeType?: unknown; bytes?: unknown}; mimeType?: unknown; bytes?: unknown} | undefined;
    const input = argument?.$object ?? argument;
    const mimeType = typeof input?.mimeType === 'string' && /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/i.test(input.mimeType) ? input.mimeType.toLowerCase() : 'unknown';
    const bytes = typeof input?.bytes === 'number' && Number.isSafeInteger(input.bytes) && input.bytes >= 0 ? input.bytes : undefined;
    return {mimeType, ...(bytes !== undefined ? {bytes} : {})};
}

export function replyDiagnostics(replies: Reply[]) {
    const errors = replies.flatMap(reply => reply.error ? [reply.error] : []);
    const rpcErrorCodes = [...new Set(errors.flatMap(error => [error.code, error.remoteCode]
        .filter((code): code is string => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))))];
    return {rpcErrorCount: errors.length, ...(errors.length ? {rpcErrorCodes: rpcErrorCodes.length ? rpcErrorCodes : ['UNCLASSIFIED']} : {})};
}
