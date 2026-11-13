import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {memoryChannels} from './helpers/session-channels';
import {sha256HexSync} from '@nestos/common';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {readPrompt} from '../src/run/prompt-bundle';
import {developmentReviewAdapter} from '../src/presets/kanban-development-review';
import {managementReviewAdapter} from '../src/presets/kanban-management-review';
const mock = vi.hoisted(() => ({dirty: false, busy: false, context: true, rejectGit:false, ancestry:0, process: {}}));
vi.mock('../src/presets/kanban-development-workspace', () => ({developmentWorkspace: async (_remote, _provider, _project, work) => work(mock.process)}));
vi.mock('../src/presets/kanban-work-resource-execution', () => ({workResourceExecution: async () => mock.busy ? ['OPERATION_ORIGINAL_SESSION_BUSY'] : []}));
vi.mock('@nestos/git-delivery/inspection', () => ({inspectWorktree: async () => ({exists: true, head: 'source-head', targetHead: 'target-head', targetBranch: 'main'})}));
vi.mock('@nestos/git-delivery/repositories', () => ({gitWorkspace: async (_process,_directory,args) => {if(mock.rejectGit)throw Object.assign(new Error('Git should only run at execution boundaries'),{code:'TEST_GIT_DURING_OBSERVATION'});return {stdout: mock.dirty ? ' M file' : '',code:args[0]==='merge-base'&&args[2]==='source-head'?mock.ancestry:0};}, verifyWorktreeDelivery: async () => [{path: '.', fingerprint: 'delivery'}]}));
vi.mock('../src/projects/harness-context-catalog', () => ({readContextCatalog: async () => ({value: {bindings: {original: {id: 'binding', branchId: 'main', connectionId: 'work-original', validity: mock.context ? 'valid' : 'invalid', nativeRef: {profileId: 'codex', sessionId: 'original-native'}, revision: 7, generation: 2}}}})}));
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); mock.dirty = mock.busy = mock.rejectGit = false; mock.context = true;mock.ancestry=0;});
async function fixture(withExchange = false,serviceControl?:import('@nestos/app-contracts/services').RuntimeServiceControl) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    const journal = new KanbanAutomationJournal(fs, kanbanJournalOptions); await journal.open();
    await journal.update('worktree:original', () => ({id: 'original', directory: '/workspace/_nestos/worktrees/original', branch: 'work/original', phase: 'ready'}));
    await journal.update('development-workspace:original', () => ({directory: '/workspace/_nestos/worktrees/original', projectId: 'project', context: {board: {id: 'board'}, task: {id: 'task'}}, policy: {profile: 'development', commit: 'changes', modules: []}}));
    const workflow={dispatches:{}};
    const item = {id: 'task', title: 'Task', responsibility: 'Work', acceptance: 'Verify', externalRefs: [{system: 'nestos-worktree', id: 'original'}, {system: 'nestos-remote-project', id: 'project'}]}, board = {id: 'board'};
    const target = {kind: 'agent', id: 'original-agent', version: '1', digest: 'original-digest'};
    const calls = {list: vi.fn(async () => [{receipt: {executionSessionId: 'original-session'}, callerState: {settled: true}, executionTree: {settled: true}, input: {request: {expectedTarget: target, expectedBranch: 'main', overrides: {connection: 'original-connection'}}}}])};
    let outcome: 'running' | 'succeeded' = 'running';
    const submission = {start: vi.fn(async () => ({sessionId: 'original-session', outcome})), inspect: vi.fn(async () => ({sessionId: 'original-session', outcome}))};
    const channels=memoryChannels();
    const stop = vi.fn(), close = vi.fn(async () => {}), remote = {sessionChannel:channels.channel,projectHarness: async () => ({subscribeChannel: () => stop, close})};
    const execute = vi.fn(async () => {});
    const options={serviceControl,fs, journal, calls, remote, submission: withExchange ? submission : undefined, kernel: {sessionActivity: async () => ({counts: {}})}, projects: {get: async () => ({path: '/project'}), openWorkspace: async () => ({fs, dispose: async () => {}})}, runningVersion: 'running', service: {execute, workflow: async () => workflow, read: async () => board, item: async (_board,id) => ({item:id==='manager'?(board as any).items[0]:item}),executionSession:async()=>({current:{sessionId:'original-session'}})}};
    const api=developmentReviewAdapter(options as never);
    closes.push(() => api.close!());
    return {api, execute, options,journal, fs, workflow, channels, submission, stop, close, complete: () => {outcome = 'succeeded';}, item: item as never, board: board as never, target, calls};
}
it('registers analysis learnings on the retained Session and recovers writes without replaying native work', async () => {
    const f = await fixture();
    Object.assign(f.workflow.dispatches, {original: {id: 'original', itemId: 'task', attempt: 1}});
    (f.item as {externalRefs: unknown[]}).externalRefs.push({system: 'nestos-execution-session', id: 'original-session', revision: 'original'});
    const snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareAnalysis({id: 'analysis-learning', board: f.board, item: f.item, snapshot});
    const payload = {summary: 'Analysis complete', learnings: [{id: 'receipt', itemId: 'task', event: 'Lost reply', handling: 'Inspect receipt',
        reason: 'Avoid replay', result: 'Recovered', conditions: 'Stable identity'}]};
    f.channels.report('analysis-learning', 'result', {type: 'result', content: 'Complete', payload});
    const job = {id: 'analysis-learning', action: 'analyze', boardId: 'board', itemId: 'task', request, snapshot} as never;
    f.execute.mockRejectedValueOnce(Object.assign(Error('private details'), {code: 'EIO'}));
    await expect(f.api.readAnalysis(job)).rejects.toMatchObject({code: 'EIO'});
    expect(await f.api.readAnalysis(job)).toEqual(payload);
    expect(await f.api.readAnalysis(job)).toEqual(payload);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.submission.start).not.toHaveBeenCalled();
});
it('prepares merge analysis in the original logical Session and exact native context without executing it', async () => {
    const f = await fixture(), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareAnalysis({id: 'analysis', board: f.board, item: f.item, snapshot});
    expect(request).toMatchObject({expectedSessionId: 'original-session', expectedTarget: f.target, overrides: {branchMode: 'continue', harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 7, expectedGeneration: 2}}});
    expect(request.source).toMatchObject({kind: 'composer', text: expect.stringContaining('`task-merge-pre.md`')});
    expect(await f.journal.get('worktree:analysis')).toMatchObject({id: 'original'});
    const bundle = (await f.journal.get<{prompts: {files: Array<{name: string}>}}>('development-policy:analysis'))!;
    expect(bundle.prompts.files.map(row => row.name)).toContain('task-merge-pre.md'); expect(bundle.prompts.files.map(row => row.name)).toContain('task-merge-post.md');
    expect(await f.fs.driver.exists('/workspace/_nestos/worktrees/original/_nestos/kanban/review/analysis/manifest.json')).toBe(true);
    expect(f.calls.list).toHaveBeenCalledWith({sessionId: 'original'});
});
it('allows unrelated target changes while refusing a busy original session or invalid native binding', async () => {
    const f = await fixture(), clean = await f.api.snapshot(f.board, f.item); mock.dirty = true;
    const snapshot = await f.api.snapshot(f.board, f.item);
    expect(snapshot.version).toBe(clean.version);expect(snapshot.sourceVersion).toBe(clean.sourceVersion);
    expect(snapshot.context).toMatchObject({targetWorktree:{dirty:true,statusDigest:expect.any(String)}});
    mock.busy = true; await expect(f.api.prepareAnalysis({id: 'busy', board: f.board, item: f.item, snapshot})).rejects.toMatchObject({code: 'OPERATION_ORIGINAL_SESSION_BUSY'});
    mock.busy = false; mock.context = false; await expect(f.api.prepareAnalysis({id: 'invalid', board: f.board, item: f.item, snapshot})).rejects.toMatchObject({code: 'OPERATION_ORIGINAL_CONTEXT_UNAVAILABLE'});
    expect(await f.journal.get('worktree:busy')).toBeUndefined();
});

it('publishes context replies and resumes merge analysis in the original Session through the real adapter', async () => {
    const f = await fixture(true), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareAnalysis({id: 'analysis', board: f.board, item: f.item, snapshot});
    const job = {id: 'analysis', boardId: 'board', itemId: 'task', request, snapshot} as never;
    f.channels.request('analysis','request','unsupported.context',{});
    expect(await f.api.exchange!(job, {sessionId: 'original-session', outcome: 'succeeded'})).toMatchObject({outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'});
    expect(f.channels.ensure('analysis').requests[0].response).toMatchObject({id:'request',status:'error',error:{code:'CHANNEL_METHOD_UNSUPPORTED'}});
    expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId: 'original-session', overrides: expect.objectContaining({harnessConversation: expect.objectContaining({mode: 'resume', bindingId: 'binding', expectedGeneration: 2})})}));
    f.complete(); expect(await f.api.exchange!(job, {sessionId: 'original-session', outcome: 'succeeded'})).toMatchObject({outcome: 'succeeded'});
    await f.api.exchange!(job, {sessionId: 'original-session', outcome: 'succeeded'}); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('prepares project-discovered builds in the original Session and freezes maintenance prompts', async () => {
    const f = await fixture(), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareOperation!({id: 'build', action: 'build', board: f.board, item: f.item, snapshot});
    expect(request.expectedSessionId).toBe('original-session'); expect((request.source as {text:string}).text).toContain('`task-build-pre.md`');
    expect(f.channels.channel).toHaveBeenCalledWith('project','open',expect.objectContaining({scopeId:'build',sessionId:'original-native'}));
    const path = '/workspace/_nestos/worktrees/original/_nestos/kanban/review/build';
    const manifest = JSON.parse(await readPrompt(f.fs, path + '/manifest.json'));
    expect(manifest.context.phase).toBe('build');expect(manifest.context.receiptPath).toBe('_nestos/kanban/review/build/result.json'); expect(manifest.files.map(row => row.name)).toContain('task-build-pre.md');
    const job = {id: 'build', action: 'build', boardId: 'board', itemId: 'task', request, snapshot} as never;
    f.channels.report('build','result',{type:'result',content:'Build result',payload:{status:'succeeded'}});
    await expect(f.api.readOperation!(job)).rejects.toMatchObject({code: 'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
});

it('accepts a verified build receipt despite unrelated target edits', async () => {
    const f = await fixture(), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareOperation!({id: 'build-ok', action: 'build', board: f.board, item: f.item, snapshot});
    const directory = '/workspace/_nestos/worktrees/original';
    const receipt = JSON.stringify({version: 'candidate', checks: ['project build completed'], entries: Array.from({length: 1000}, (_, index) => ({path: 'dependency/' + index, sha256: 'a'.repeat(64)}))});
    expect(new TextEncoder().encode(receipt).byteLength).toBeGreaterThan(65536);
    await f.fs.driver.createFile({parentPath: directory, name: 'build-receipt.json', content: receipt});
    const payload = {schema: 'nestos.kanban.operation-result/1', operationId: 'build-ok', status: 'succeeded', sourceVersion: snapshot.sourceVersion, targetVersion: snapshot.targetVersion, version: 'candidate', evidence: {path: 'build-receipt.json', sha256: sha256HexSync(receipt)}};
    f.channels.report('build-ok','result',{type:'result',content:'Build result',payload});
    mock.dirty = true;
    expect(await f.api.readOperation!({id: 'build-ok', action: 'build', boardId: 'board', itemId: 'task', request, snapshot} as never)).toEqual(payload);
});

it('accepts already-integrated delivery without inventing a target commit and rejects an unrelated target',async()=>{
 const f=await fixture(),snapshot=await f.api.snapshot(f.board,f.item),request=await f.api.prepareOperation!({id:'merge-confirm',action:'merge',board:f.board,item:f.item,snapshot});
 const payload={schema:'nestos.kanban.operation-result/1',operationId:'merge-confirm',status:'succeeded',sourceVersion:snapshot.sourceVersion,targetVersion:snapshot.targetVersion,targetHead:'target-head'};
 f.channels.report('merge-confirm','result',{type:'result',content:'Already integrated',payload});
 const job={id:'merge-confirm',action:'merge',boardId:'board',itemId:'task',request,snapshot} as never;
 expect(await f.api.readOperation!(job)).toEqual(payload);mock.ancestry=1;
 await expect(f.api.readOperation!(job)).rejects.toMatchObject({code:'OPERATION_RESULT_MERGE_UNCONFIRMED'});
});

it('resolves the canonical dispatch workspace without requiring a duplicate card reference',async()=>{
 const f=await fixture();(f.item as any).externalRefs=(f.item as any).externalRefs.filter(row=>row.system!=='nestos-worktree');
 (f.board as any).automation={preparation:{system:'nestos-work-preparation',id:'git-worktree'}};
 (f.workflow.dispatches as any).original={id:'original',itemId:'task',attempt:1};
 expect(f.api.supports!(f.board,f.item)).toBe(true);expect((await f.api.snapshot(f.board,f.item)).context).toMatchObject({worktreeId:'original'});
});

it('accepts archived artifact evidence but refuses protocol receipts as build evidence',async()=>{
 const f=await fixture(),snapshot=await f.api.snapshot(f.board,f.item),request=await f.api.prepareOperation!({id:'archive-build',action:'build',board:f.board,item:f.item,snapshot});
 const content='real artifact manifest',path='_nestos/kanban/artifacts/build/manifest.json';await f.fs.driver.createFile({parentPath:'/workspace/_nestos/worktrees/original/_nestos/kanban/artifacts/build',name:'manifest.json',content,recursive:true});
 const payload={status:'succeeded',evidence:{path,sha256:sha256HexSync(content)}};f.channels.report('archive-build','proof',{type:'result',content:'Build',payload});
 expect(await f.api.readOperation!({id:'archive-build',action:'build',boardId:'board',itemId:'task',request,snapshot} as never)).toEqual(payload);
 const bad=await f.api.prepareOperation!({id:'protocol-proof',action:'build',board:f.board,item:f.item,snapshot});
 f.channels.report('protocol-proof','proof',{type:'result',content:'Protocol is not an artifact',payload:{status:'succeeded',evidence:{path:'_nestos/kanban/review/protocol-proof/result.json',sha256:sha256HexSync(content)}}});
 await expect(f.api.readOperation!({id:'protocol-proof',action:'build',boardId:'board',itemId:'task',request:bad,snapshot} as never)).rejects.toMatchObject({code:'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
});

it('freezes the declared service artifact requirements into the build Session context',async()=>{
 const deployment={id:'service',version:'running',artifact:{format:'service-release/1',manifest:'release.json',store:{base:'source-checkout' as const,path:'release/httpd'}}};
 const f=await fixture(false,{describe:async()=>deployment,submit:async()=>{},inspect:async()=>({state:'running'})});
 await f.fs.driver.createFile({parentPath:'/workspace/_nestos/etc',name:'deployment.json',content:JSON.stringify({schema:1,serviceId:'service'}),recursive:true});
 const snapshot=await f.api.snapshot(f.board,f.item);await f.api.prepareOperation!({id:'service-build',action:'build',board:f.board,item:f.item,snapshot});
 expect((await f.journal.get<any>('development-workspace:service-build')).context.operation.deployment).toEqual(deployment);
 const manifest=JSON.parse(await readPrompt(f.fs,'/workspace/_nestos/worktrees/original/_nestos/kanban/review/service-build/manifest.json'));
 expect(manifest.context.deployment).toEqual(deployment);
});

it('accepts current continuation evidence without changing the original workspace history', async () => {
    const f = await fixture(), tree = await f.journal.get('worktree:original');
    const original = await f.journal.get<any>('development-workspace:original');
    await f.journal.update('development-workspace:original', () => ({...original, context: {...original.context, delivery: {readOnly: true, evidence: {result: {version: 'old'}}}}}));
    await f.journal.update('worktree:retry', () => tree);
    await f.journal.update('development-workspace:retry', () => ({...original, context: {...original.context, delivery: {readOnly: true, evidence: {result: {version: 'running'}}}}}));
    Object.assign(f.workflow.dispatches, {retry: {id: 'retry', itemId: 'task', attempt: 2}});
    await expect(f.api.snapshot(f.board, f.item)).resolves.toMatchObject({context: {worktreeId: 'original'}});
    expect((await f.journal.get<any>('development-workspace:original')).context.delivery.evidence.result.version).toBe('old');
    await f.journal.update('development-workspace:retry', old => ({...old as any, context: {...original.context, delivery: {readOnly: true, evidence: {result: {version: 'different'}}}}}));
    await expect(f.api.snapshot(f.board, f.item)).rejects.toMatchObject({code: 'VERIFICATION_RUNNING_VERSION_MISMATCH'});
});

it('prepares a new analysis channel for the same Session when its previous channel is closed without any view',async()=>{
 const f=await fixture(),snapshot=await f.api.snapshot(f.board,f.item),original=f.channels.channel.getMockImplementation()!;
 f.channels.channel.mockImplementation(async(...args)=>{if(args[1]==='current')throw Object.assign(new Error('closed'),{code:'EIO',remoteCode:'CHANNEL_SCOPE_UNKNOWN',outcome:'not-committed'});return original(...args);});
 const request=await f.api.prepareAnalysis({id:'after-close',board:f.board,item:f.item,snapshot});
 expect(request).toMatchObject({expectedSessionId:'original-session',overrides:{harnessConversation:{mode:'resume',bindingId:'binding'}}});
 expect(f.channels.channel).toHaveBeenCalledWith('project','open',expect.objectContaining({scopeId:'after-close'}));
 const opened=f.channels.channel.mock.calls.find(row=>row[1]==='open')![2];expect(opened).not.toHaveProperty('previousScopeId');
 expect(f.submission.start).not.toHaveBeenCalled();
});
it.each(['EACCES','CHANNEL_EXECUTION_UNKNOWN'])('does not reinterpret %s as an absent predecessor',async code=>{
 const f=await fixture(),snapshot=await f.api.snapshot(f.board,f.item);
 f.channels.channel.mockRejectedValueOnce(Object.assign(new Error(code),{code}));
 await expect(f.api.prepareAnalysis({id:'blocked-channel',board:f.board,item:f.item,snapshot})).rejects.toMatchObject({code});
 expect(f.channels.channel.mock.calls.some(row=>row[1]==='open')).toBe(false);
});

it('preserves an unknown channel lookup outcome rather than opening a replacement channel',async()=>{
 const f=await fixture(),snapshot=await f.api.snapshot(f.board,f.item);
 f.channels.channel.mockRejectedValueOnce(Object.assign(new Error('uncertain'),{code:'EIO',remoteCode:'CHANNEL_SCOPE_UNKNOWN',outcome:'unknown'}));
 await expect(f.api.prepareAnalysis({id:'unknown-channel',board:f.board,item:f.item,snapshot})).rejects.toMatchObject({code:'EIO',outcome:'unknown'});
 expect(f.channels.channel.mock.calls.some(row=>row[1]==='open')).toBe(false);
});

it('keeps maintenance entry messages bounded while retaining full task and version context in the channel',async()=>{
 const f=await fixture();Object.assign(f.item,{responsibility:'Detailed original work '.repeat(300),acceptance:'Actual acceptance '.repeat(200)});
 const snapshot=await f.api.snapshot(f.board,f.item);
 for(const action of ['analyze','build','deploy','merge'] as const){
  const input={id:'compact-'+action,action,board:f.board,item:f.item,snapshot};
  const request=action==='analyze'?await f.api.prepareAnalysis(input):await f.api.prepareOperation!(input);
  const text=(request.source as {text:string}).text;
  expect(Buffer.byteLength(text)).toBeLessThan(240);expect(text).not.toContain('Detailed original work');expect(text).not.toContain(snapshot.sourceVersion);expect(text.startsWith('{')).toBe(false);expect(text).not.toContain('-post.md');expect(text).not.toContain('`context`');
  const open=f.channels.channel.mock.calls.find(([,op,args])=>op==='open'&&args.scopeId===input.id)!;
  expect(open[2].snapshot.task).toMatchObject({responsibility:'Detailed original work '.repeat(300)});
  expect(open[2].snapshot.context.operation).toMatchObject({operationId:input.id,sourceVersion:snapshot.sourceVersion,targetVersion:snapshot.targetVersion});
 }
});

it('runs management scope phases in the retained contributor Session and keeps aggregate channel context across a resume',async()=>{
 const f=await fixture(true),owner={id:'manager',title:'Manage',status:'inProgress',planning:{execution:'children'}};
 Object.assign(f.item,{status:'completed',planning:{parentId:'manager'}});Object.assign(f.board,{items:[owner,f.item]});
 (f.workflow.dispatches as any).d={id:'d',itemId:'task',attempt:1,outcome:'accepted',executionSessionId:'original-session'};
 const scope={schema:1,id:'repository-one',boardId:'board',ownerId:'manager',projectId:'project',label:'Project',contributors:[{itemId:'task',title:'Task',dispatchId:'d',worktreeId:'original'}]};
 const api=managementReviewAdapter(f.options as never,scope as never);closes.push(()=>api.close!());
 const snapshot=await api.snapshot(f.board,owner as never),request=await api.prepareOperation!({id:'batch-analysis',action:'analyze',board:f.board,item:owner as never,snapshot});
 expect(request.expectedSessionId).toBe('original-session');expect((request.source as any).text).toContain('management-integration-pre.md');
 const manifest=JSON.parse(await readPrompt(f.fs,'/workspace/_nestos/worktrees/original/_nestos/kanban/review/batch-analysis/manifest.json'));
 expect(manifest.context.resources.management).toMatchObject({ownerId:'manager',sources:[{itemId:'task'}]});
 f.channels.request('batch-analysis','request','unsupported.context',{});
 expect(await api.exchange!({id:'batch-analysis',boardId:'board',itemId:'manager',scopeId:scope.id,request,snapshot} as never,{sessionId:'original-session',outcome:'succeeded'})).toMatchObject({outcome:'running'});
 expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId:'original-session'}));
 expect(await api.relatedSession!(f.board,owner as never)).toBe('original-session');
});

it('observes active management and continuation turns without acquiring Git execution, then rechecks before resuming',async()=>{
 const f=await fixture(true),owner={id:'manager',title:'Manage',status:'inProgress',planning:{execution:'children'}};
 Object.assign(f.item,{status:'completed',planning:{parentId:'manager'}});Object.assign(f.board,{items:[owner,f.item]});
 (f.workflow.dispatches as any).d={id:'d',itemId:'task',attempt:1,outcome:'accepted',executionSessionId:'original-session'};
 const scope={schema:1,id:'repository-one',boardId:'board',ownerId:'manager',projectId:'project',label:'Project',contributors:[{itemId:'task',title:'Task',dispatchId:'d',worktreeId:'original'}]};
 const api=managementReviewAdapter(f.options as never,scope as never);closes.push(()=>api.close!());
 const snapshot=await api.snapshot(f.board,owner as never),request=await api.prepareOperation!({id:'batch-observe',action:'analyze',board:f.board,item:owner as never,snapshot});
 const job={id:'batch-observe',boardId:'board',itemId:'manager',scopeId:scope.id,request,snapshot} as never;
 mock.rejectGit=true;
 expect(await api.exchange!(job,{sessionId:'original-session',outcome:'running'})).toMatchObject({outcome:'running'});
 f.channels.request('batch-observe','request','unsupported.context',{});
 await expect(api.exchange!(job,{sessionId:'original-session',outcome:'succeeded'})).rejects.toMatchObject({code:'TEST_GIT_DURING_OBSERVATION'});
 expect(f.submission.start).not.toHaveBeenCalled();
 mock.rejectGit=false;
 expect(await api.exchange!(job,{sessionId:'original-session',outcome:'succeeded'})).toMatchObject({outcome:'running'});
 mock.rejectGit=true;
 expect(await api.exchange!(job,{sessionId:'original-session',outcome:'succeeded'})).toMatchObject({outcome:'running'});
 expect(f.submission.start).toHaveBeenCalledOnce();
});

it('verifies source-checkout artifacts through the frozen service capability rather than the execution worktree',async()=>{
 const deployment={id:'service',version:'running',artifact:{format:'service-release/1',manifest:'release.json',store:{base:'source-checkout' as const,path:'release/httpd'}}};
 const verifyArtifact=vi.fn(async()=>{}),control={describe:async()=>deployment,verifyArtifact,submit:async()=>{},inspect:async()=>({state:'running' as const})};
 const f=await fixture(false,control);await f.fs.driver.createFile({parentPath:'/workspace/_nestos/etc',name:'deployment.json',content:JSON.stringify({schema:1,serviceId:'service'}),recursive:true});
 const snapshot=await f.api.snapshot(f.board,f.item),request=await f.api.prepareOperation!({id:'service-proof',action:'build',board:f.board,item:f.item,snapshot});
 const payload={operationId:'service-proof',status:'succeeded',version:'candidate',evidence:{path:'release/httpd/candidate/release.json',sha256:'a'.repeat(64)}};
 f.channels.report('service-proof','result',{type:'result',content:'Built',payload});
 const job={id:'service-proof',action:'build',boardId:'board',itemId:'task',request,snapshot} as never;
 expect(await f.api.readOperation!(job)).toEqual(payload);
 expect(verifyArtifact).toHaveBeenCalledWith({operationId:'service-proof',serviceId:'service',version:'candidate',sha256:'a'.repeat(64)});
 verifyArtifact.mockRejectedValueOnce(Object.assign(Error('digest mismatch'),{code:'OPERATION_RESULT_ARTIFACT_UNVERIFIED'}));
 await expect(f.api.readOperation!(job)).rejects.toMatchObject({code:'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
});
it('does not let a build receipt redirect the frozen service artifact path',async()=>{
 const {verifyManagedBuildArtifact}=await import('../src/presets/managed-service-deployment');
 const verifyArtifact=vi.fn(),control={verifyArtifact} as any,deployment={id:'service',version:'running',artifact:{format:'release',manifest:'release.json',store:{base:'source-checkout' as const,path:'release/httpd'}}};
 await expect(verifyManagedBuildArtifact(control,deployment,{operationId:'build',version:'candidate',evidence:{path:'other/candidate/release.json',sha256:'a'.repeat(64)}})).rejects.toMatchObject({code:'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
 expect(verifyArtifact).not.toHaveBeenCalled();
});

it('keeps customized management acceptance prompts when adding plugin defaults',async()=>{
 const f=await fixture(),snapshot=await f.api.snapshot(f.board,f.item);
 const {ensureKanbanConfiguration}=await import('../src/presets/kanban-global-configuration');await ensureKanbanConfiguration(f.fs);
 const path='/workspace/_nestos/etc/kanban/development';
 const manifest=JSON.parse(await readPrompt(f.fs,'/etc/kanban/development/profile.json'));manifest.files.push('management-integration-pre.md');
 await f.fs.driver.createFile({parentPath:path,name:'profile.json',content:JSON.stringify(manifest),recursive:true});
 await f.fs.driver.createFile({parentPath:path,name:'management-integration-pre.md',content:'Project acceptance rules',recursive:true});
 await f.api.prepareOperation!({id:'custom-acceptance',action:'build',board:f.board,item:f.item,snapshot,extraPrompts:[{name:'management-integration-pre.md',content:'Plugin default',sha256:sha256HexSync('Plugin default'),source:'plugin'}]} as never);
 const policy=await f.journal.get<any>('development-policy:custom-acceptance');
 expect(policy.prompts.files.filter(file=>file.name==='management-integration-pre.md')).toMatchObject([{content:'Project acceptance rules'}]);
 const published=await readPrompt(f.fs,'/workspace/_nestos/worktrees/original/_nestos/kanban/review/custom-acceptance/prompts/management-integration-pre.md');expect(published).toBe('Project acceptance rules');
});
