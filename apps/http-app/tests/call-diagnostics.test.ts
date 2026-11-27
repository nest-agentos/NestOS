import { expect, it } from 'vitest';
import { callDiagnostics, replyDiagnostics } from '../../node-host/src/http/call-diagnostics';

it('records only registered command names and bounded upload metadata', () => {
    const calls = [{target: 'bus', method: 'execute', args: ['app.assets.import', {$object: {url: 'data:image/png;base64,AQID', name: 'private.png'}}]},
        {target: 'bus', method: 'execute', args: ['unregistered-secret', {token: 'private-token'}]}];
    const details = callDiagnostics(calls, ['ICommandBus.execute', 'ICommandBus.execute'], new Set(['app.assets.import']));
    expect(details).toEqual({rpcCommands: ['app.assets.import'], uploads: [{mimeType: 'image/png', bytes: 3}]});
    expect(JSON.stringify(details)).not.toMatch(/AQID|private|secret/);
});

it('distinguishes business errors from HTTP success without logging exception messages', () => {
    expect(replyDiagnostics([{error: {name: 'Error', message: 'private document text', code: 'INPUT_ASSET_PERSISTENCE', remoteCode: 'EACCES'}}, {value: true}]))
        .toEqual({rpcErrorCount: 1, rpcErrorCodes: ['INPUT_ASSET_PERSISTENCE', 'EACCES']});
    expect(replyDiagnostics([{error: {name: 'Error', message: 'secret', code: 'invalid\nprivate'}}])).toEqual({rpcErrorCount: 1, rpcErrorCodes: ['UNCLASSIFIED']});
});

it('records only bounded capability IDs and registered missing methods for stale handles', () => {
    const details = callDiagnostics([{target:'server:123',method:'dispose',args:[{text:'PRIVATE'}]},
        {target:'PRIVATE target',method:'dispose',args:[]}], ['unknown.dispose','unknown.dispose'],new Set());
    expect(details).toEqual({rpcUnavailable:[{target:'server:123',method:'dispose'}]});
    expect(JSON.stringify(details)).not.toContain('PRIVATE');
});

it('correlates native conversation opens without recording full resource paths or other arguments',()=>{
    const operationId='0a6f924f-3bb1-4a52-b359-9fcf7ecd1711',parentOperationId='83b11ee8-a946-4ce3-9d95-00078a7d86aa';
    const sessionId='01a217c8-6027-7802-8c47-2cf6e6134ed8',resource='/folder:private-project/@harness/codex/'+sessionId;
    const call={target:'workbench',method:'openConversation',args:[resource,{$object:{operationId,parentOperationId,source:'visibility-resume',content:'PRIVATE'}}]};
    const invalid={...call,args:[resource,{$object:{operationId,source:'PRIVATE'}}]};
    const initial={target:'backend',method:'openWorkbench',args:[{$object:{resourceId:resource,trace:{$object:{operationId,source:'kanban-link'}},content:'PRIVATE'}}]};
    const operations=['ConversationWorkbenchView.openConversation','ConversationWorkbenchView.openConversation'];
    const details=callDiagnostics([call,invalid],operations,new Set());
    expect(details).toEqual({conversationOpens:[{operationId,parentOperationId,source:'visibility-resume',sessionId}]});
    expect(JSON.stringify(details)).not.toMatch(/private-project|PRIVATE/);
    expect(callDiagnostics([initial],['ApplicationBackend.openWorkbench'],new Set())).toEqual({
        conversationOpens:[{operationId,source:'kanban-link',sessionId}],
    });
});
