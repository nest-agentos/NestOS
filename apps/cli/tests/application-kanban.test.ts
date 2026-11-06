import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ApplicationClient} from '@nestos/app-contracts/services';
import {kanbanCommand} from '../src/application-kanban';
const paths: string[] = [];
afterEach(async () => {for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});});
it('passes frozen mutations unchanged and never retries an unknown outcome', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kanban-cli-')); paths.push(directory);
    const file = join(directory, 'request.json'), request = {operationId: 'original', expectedRevision: 4,
        command: {type: 'append-record', record: {id: 'decision'}}};
    await writeFile(file, JSON.stringify(request));
    const execute = vi.fn(async () => {throw Object.assign(new Error('Unknown'), {outcome: 'unknown'});});
    const client = {services: {kanban: {execute}}} as unknown as ApplicationClient;
    await expect(kanbanCommand(client, ['execute', 'board'], {file})).rejects.toMatchObject({outcome: 'unknown'});
    expect(execute).toHaveBeenCalledExactlyOnceWith('board', request);
});
it('fails explicitly when the host has no Kanban service', async () => {
    await expect(kanbanCommand({services: {}} as ApplicationClient, ['list'], {})).rejects.toMatchObject({code: 'ECAPABILITY'});
});
it('queries the complete Session association list without sending or activating any Session', async () => {
    const executionSession=vi.fn(async()=>({sessions:[],history:[]})),execute=vi.fn();
    const client={services:{kanban:{executionSession,execute}}} as unknown as ApplicationClient;
    expect(await kanbanCommand(client,['sessions','board','task'],{})).toEqual({sessions:[],history:[]});
    expect(executionSession).toHaveBeenCalledExactlyOnceWith('board','task',{includeRelated:true}); expect(execute).not.toHaveBeenCalled();
});
it('passes an explicit continuation identity through the normal durable command path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kanban-continue-')); paths.push(directory);
    const file = join(directory, 'request.json'), request = {operationId: 'intent', expectedRevision: 5,
        command: {type: 'continue-execution', previousDispatchId: 'failed', dispatchId: 'continuation'}};
    await writeFile(file, JSON.stringify(request));
    const execute = vi.fn(async () => ({})), client = {services: {kanban: {execute}}} as unknown as ApplicationClient;
    await kanbanCommand(client, ['continue', 'board'], {file});
    expect(execute).toHaveBeenCalledExactlyOnceWith('board', request);
});

it('uses the shared task projection query and keeps fix/reply operation identities on their host ports',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'kanban-task-cli-'));paths.push(directory);const file=join(directory,'request.json');
    const request={itemId:'original',operationId:'fix-stable'},fixTask=vi.fn(async()=>({sessionId:'fix-session'})),replyTask=vi.fn(async()=>{}),query=vi.fn(async()=>({items:[{task:{phase:'waiting-start',startAt:300000}}]}));
    const client={services:{kanban:{fixTask,replyTask,query}}} as unknown as ApplicationClient;
    await writeFile(file,JSON.stringify(request));await kanbanCommand(client,['fix','development'],{file});expect(fixTask).toHaveBeenCalledExactlyOnceWith('development',request);
    await kanbanCommand(client,['reply','development'],{file});expect(replyTask).toHaveBeenCalledExactlyOnceWith('development',request);
    expect(await kanbanCommand(client,['query','development'],{})).toMatchObject({items:[{task:{phase:'waiting-start'}}]});
});

it('freezes task resume identity before dispatch and supports replaying that exact request', async () => {
    const {readFile, stat} = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'kanban-resume-')); paths.push(directory);
    const file = join(directory, 'resume.json'), read = vi.fn(async () => ({revision: 7, items: [{id: 'task'}]}));
    const execute = vi.fn(async (_board: string, request: unknown) => {
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(request); return {accepted: true};
    });
    const client = {services: {kanban: {read, execute}}} as unknown as ApplicationClient;
    await kanbanCommand(client, ['task', 'resume', 'board', 'task'], {submissionFile: file});
    const request = JSON.parse(await readFile(file, 'utf8'));
    expect(request).toMatchObject({expectedRevision: 7, command: {type: 'request-control', action: 'resume', itemId: 'task'}});
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await kanbanCommand(client, ['task', 'resume', 'board', 'task'], {file});
    expect(read).toHaveBeenCalledOnce(); expect(execute).toHaveBeenLastCalledWith('board', request);
});
it('does not dispatch when freezing fails or a frozen task/action does not match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kanban-task-frozen-')); paths.push(directory);
    const file = join(directory, 'existing.json'); await writeFile(file, JSON.stringify({command: {type: 'request-control', itemId: 'other', action: 'pause'}}));
    const execute = vi.fn(), read = vi.fn(async () => ({revision: 7, items: [{id: 'task'}]}));
    const client = {services: {kanban: {read, execute}}} as unknown as ApplicationClient;
    await expect(kanbanCommand(client, ['task', 'resume', 'board', 'task'], {submissionFile: file})).rejects.toThrow('already exists');
    await expect(kanbanCommand(client, ['task', 'resume', 'board', 'task'], {file})).rejects.toThrow('does not match');
    expect(execute).not.toHaveBeenCalled();
});

it('freezes a restart into a distinct successor and rejects replay against another successor', async () => {
    const directory = await mkdtemp(join(tmpdir(),'kanban-restart-')); paths.push(directory);
    const file = join(directory,'request.json'), execute = vi.fn(async () => ({id:'board'}));
    const client = {services:{kanban:{read:async()=>({revision:7,items:[{id:'old'}]}),execute}}} as unknown as ApplicationClient;
    await kanbanCommand(client,['task','restart','board','old','fresh'],{submissionFile:file});
    expect(execute).toHaveBeenCalledWith('board',expect.objectContaining({expectedRevision:7,command:{type:'restart-item',itemId:'old',replacementId:'fresh'}}));
    await expect(kanbanCommand(client,['task','restart','board','old','other'],{file})).rejects.toThrow('replacement task');
    expect(execute).toHaveBeenCalledTimes(1);
});

it('resolves a board-scoped human reference without mutating work', async () => {
    const resolve=vi.fn(async()=>({boardId:'development',itemId:'meaningful-task',reference:'KB-3#12'}));
    const client={services:{kanban:{resolve}}} as unknown as ApplicationClient;
    expect(await kanbanCommand(client,['resolve','KB-3#12'],{})).toMatchObject({itemId:'meaningful-task'});
    expect(resolve).toHaveBeenCalledExactlyOnceWith('KB-3#12');
});

it('freezes a dependency restart against the reviewed scope and reuses the operation after response loss',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kanban-dag-restart-'));paths.push(directory);const file=join(directory,'request.json');
 const previewTaskRestart=vi.fn(async()=>({itemId:'source',version:'scope-version',affected:[{id:'source'},{id:'verify'}]})),restartTask=vi.fn(async()=>({state:'stopping'}));
 const client={services:{kanban:{previewTaskRestart,restartTask}}} as unknown as ApplicationClient;
 await kanbanCommand(client,['task','restart','board','source'],{submissionFile:file});const first=restartTask.mock.calls[0];
 await kanbanCommand(client,['task','restart','board','source'],{file});expect(restartTask.mock.calls[1]).toEqual(first);
 expect(first).toEqual(['board',expect.objectContaining({itemId:'source',version:'scope-version',confirmed:true})]);expect(previewTaskRestart).toHaveBeenCalledTimes(1);
});
