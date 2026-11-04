import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {consumeWorkspaceMessages, initializeWorkspaceMessages, parseWorkspaceMessage} from '../src/run/workspace-messages';

const scope = {runId: 'run', itemId: 'item', attemptId: 'attempt'}, directory = '/workspace/_nestos/kanban';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), journal = new KanbanAutomationJournal(fs); await journal.open();
    await initializeWorkspaceMessages(fs, directory, scope);
    const message = {schema: 'work-message/1', ...scope, id: 'message', type: 'clarification', content: 'Need acceptance details'};
    const publish = (value = message, name = 'message.json') => fs.driver.createFile({parentPath: directory + '/inbox', name, content: JSON.stringify(value)});
    return {fs, journal, message, publish};
}
it('consumes atomic publications once across reopening and detects rewritten IDs', async () => {
    const f = await fixture(), deliver = vi.fn(async () => {}); await f.publish(); await f.publish(f.message, 'unfinished.tmp');
    expect(await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).toHaveLength(1);
    await consumeWorkspaceMessages(f.fs, directory, scope, new KanbanAutomationJournal(f.fs), deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    await f.fs.driver.writeContent(directory + '/inbox/message.json', JSON.stringify({...f.message, content: 'Changed'}));
    await expect(consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).rejects.toMatchObject({code: 'ECONFLICT'});
});
it('rejects scope changes, malformed and oversized messages without marking them delivered', async () => {
    const f = await fixture(), deliver = vi.fn(async () => {});
    expect(() => parseWorkspaceMessage(JSON.stringify({...f.message, attemptId: 'other'}), scope)).toThrow('scope');
    await f.publish({...f.message, content: 'x'.repeat(65537)});
    await expect(consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).rejects.toThrow('64 KiB');
    expect(deliver).not.toHaveBeenCalled();
    await expect(initializeWorkspaceMessages(f.fs, directory, {...scope, attemptId: 'other'})).rejects.toMatchObject({code: 'ECONFLICT'});
});
it('retries delivery with the same stable message after an interrupted handler', async () => {
    const f = await fixture(); await f.publish();
    const deliver = vi.fn().mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue(undefined);
    await expect(consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver)).rejects.toThrow('Response lost');
    await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver);
    expect(deliver.mock.calls[0][0]).toEqual(deliver.mock.calls[1][0]);
});

it('documents the message fields and accepts the original body spelling without ambiguity', async () => {
    const f = await fixture();
    const protocol = JSON.parse(await f.fs.driver.readContent(directory + '/protocol.json', {encoding: 'utf-8'}));
    expect(protocol.message).toMatchObject({schema: 'work-message/1', ...scope, type: 'progress'});
    const {content, ...message} = f.message;
    expect(parseWorkspaceMessage(JSON.stringify({...message, body: content}), scope).content).toBe(content);
    expect(() => parseWorkspaceMessage(JSON.stringify({...f.message, body: content}), scope)).toThrow('both');
});

it('fits remote range reads to the file size instead of treating a maximum as an exact range', async () => {
    const f = await fixture(); await f.publish();
    const original = f.fs.driver.readContent.bind(f.fs.driver);
    vi.spyOn(f.fs.driver, 'readContent').mockImplementation((async (path: string, options?: {length?: number}) => {
        const node = await f.fs.driver.getNode(path);
        if (options?.length && node?.type === 'file' && options.length > node.size) throw new Error('Short remote range');
        return original(path, options);
    }) as typeof f.fs.driver.readContent);
    const deliver = vi.fn(async () => {});
    await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver);
    await initializeWorkspaceMessages(f.fs, directory, scope);
    expect(deliver).toHaveBeenCalledTimes(1);
});
it('uses the same bounded YAML decoder for new messages and legacy JSON files',async()=>{
    const f=await fixture(),deliver=vi.fn(async()=>{});
    await f.fs.driver.createFile({parentPath:directory+'/inbox',name:'yaml-message.yaml',content:'schema: work-message/1\nrunId: run\nitemId: item\nattemptId: attempt\nid: yaml-message\ntype: progress\ncontent: YAML progress'});
    await f.publish();
    expect(await consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver)).toHaveLength(2);
    await consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver);expect(deliver).toHaveBeenCalledTimes(2);
});

it('publishes durable acceptance replies, repairs missing replies and does not repeat committed delivery',async()=>{
    const f=await fixture();await f.publish();const deliver=vi.fn(async()=>{});
    await consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver);
    const path=directory+'/outbox/ack-message.yaml';
    expect(JSON.parse(await f.fs.driver.readContent(path,{encoding:'utf-8'}))).toMatchObject({schema:'work-reply/1',type:'accepted',replyTo:'message'});
    await f.fs.driver.delete([path]);
    await consumeWorkspaceMessages(f.fs,directory,scope,new KanbanAutomationJournal(f.fs),deliver);
    expect(await f.fs.driver.exists(path)).toBe(true);expect(deliver).toHaveBeenCalledTimes(1);
});
it('requires a v2 linked resolution and delivers its issue first regardless of filenames',async()=>{
    const f=await fixture(),deliver=vi.fn(async()=>{});
    await f.publish({...f.message,id:'z-question'},'z-question.yaml');
    await f.fs.driver.createFile({parentPath:directory+'/inbox',name:'a-resolution.yaml',content:JSON.stringify({...f.message,schema:'work-message/2',id:'a-resolution',type:'resolved',replyTo:'z-question'})});
    const messages=await consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver);
    expect(messages.map(m=>m.id)).toEqual(['z-question','a-resolution']);
    expect(()=>parseWorkspaceMessage(JSON.stringify({...f.message,type:'resolved',replyTo:'z-question'}),scope)).toThrow('schema');
});
it('rejects missing resolution targets before committing other messages',async()=>{
    const f=await fixture(),deliver=vi.fn(async()=>{});
    await f.publish();await f.fs.driver.createFile({parentPath:directory+'/inbox',name:'bad.yaml',content:JSON.stringify({...f.message,schema:'work-message/2',id:'bad',type:'resolved',replyTo:'missing'})});
    await expect(consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver)).rejects.toMatchObject({code:'WORKSPACE_RESOLUTION_INVALID'});
    expect(deliver).not.toHaveBeenCalled();
});
it.each(['runId','itemId','attemptId'])('rejects changed %s and a stale attempt without an acceptance reply',async key=>{
    const f=await fixture(),deliver=vi.fn(async()=>{});
    await f.publish({...f.message,[key]:'wrong'});
    await expect(consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver)).rejects.toThrow('scope');
    expect(await f.fs.driver.exists(directory+'/outbox/ack-message.yaml')).toBe(false);expect(deliver).not.toHaveBeenCalled();
});
it.each(['a: [','x: &loop [*loop]','schema: work-message/1\nschema: work-message/2'])('rejects malformed or unbounded YAML without delivery: %s',async content=>{
    const f=await fixture(),deliver=vi.fn(async()=>{});
    await f.fs.driver.createFile({parentPath:directory+'/inbox',name:'bad.yaml',content});
    await expect(consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver)).rejects.toBeDefined();expect(deliver).not.toHaveBeenCalled();
});

it('diagnoses deletion of a published file from the durable attempt index instead of losing its unresolved issue',async()=>{
    const f=await fixture(),deliver=vi.fn(async()=>{});await f.publish();await consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver);
    await f.fs.driver.delete([directory+'/inbox/message.json']);
    await expect(consumeWorkspaceMessages(f.fs,directory,scope,f.journal,deliver)).rejects.toMatchObject({code:'ECONFLICT',reasonCode:'WORK_MESSAGE_MISSING'});
    expect(deliver).toHaveBeenCalledTimes(1);
});
it('keeps current context requests and task issue resolution in separate lanes of one mailbox', async () => {
    const f = await fixture(), deliver = vi.fn(async () => {}); await f.publish();
    const write = (id: string, value: unknown) => f.fs.driver.createFile({parentPath: directory + '/inbox', name: id + '.yaml', content: JSON.stringify(value)});
    await write('resolved', {schema: 'work-message/2', ...scope, id: 'resolved', type: 'resolved', replyTo: 'message', content: 'Answer incorporated'});
    await write('context', {schema: 'work-message/2', scopeId: scope.attemptId, id: 'context', type: 'request', method: 'kanban.context.resolve', waitForResponse: true, params: {}});
    const business = await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver);
    expect(business.map(message => message.id)).toEqual(['message', 'resolved']); expect(deliver).toHaveBeenCalledTimes(2);
    const {readFileRequests} = await import('../src/run/file-exchange-protocol');
    expect((await readFileRequests(f.fs, directory, scope.attemptId)).map(request => request.id)).toEqual(['context']);
    await consumeWorkspaceMessages(f.fs, directory, scope, f.journal, deliver); expect(deliver).toHaveBeenCalledTimes(2);
    await f.fs.driver.writeContent(directory + '/inbox/context.yaml', JSON.stringify({schema: 'work-message/2', scopeId: 'other', id: 'context', type: 'request', method: 'kanban.context.resolve', waitForResponse: true, params: {}}));
    await expect(readFileRequests(f.fs, directory, scope.attemptId)).rejects.toMatchObject({code: 'FILE_EXCHANGE_SCOPE_INVALID'});
});
