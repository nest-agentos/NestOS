import {promptData} from './helpers/prompt-data';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {readChannelResult} from '../src/run/channel-results';
import {memoryChannels} from './helpers/session-channels';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {afterEach, expect, it, vi} from 'vitest';
import {randomUUID} from '@nestos/common';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import type {KanbanCommand, KanbanAutomationSettings} from '@nestos/kanban/contracts';
import type {IndependentCallInput, IndependentCallView, RootTargetCatalog} from '@nestos/llm-session/contracts';
import type {TaskRecord} from '@nestos/durable-kernel';
import {UserEventService} from '../src/events/service';
import {DiagnosticJournal} from '../src/diagnostics/journal';
import {createPersonalKanban} from '../src/kanban/personal';
import {parseAnalysis} from '@nestos/kanban/integration';
import type {PersonalKanbanAutomationOptions} from '../src/kanban/personal-automation';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of disposers.splice(0)) await close(); vi.useRealTimers();});
async function fixture(autoAccept = false, analysis?:unknown, prepareFailure?: Error) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); disposers.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), events = await UserEventService.open(fs);
    const channels=memoryChannels();
    const submitted = new Map<string, IndependentCallInput>(), completed = new Set<string>();
    const targets: RootTargetCatalog = {entries: ['planner', 'executor'].map(id => ({name: id,
        target: {kind: 'agent', id, version: '1', digest: id === 'planner' ? 'a'.repeat(64) : 'b'.repeat(64)}})), issues: []};
    let loseReply = false, hideAdmission = false, invalid = false;
    type Calls = PersonalKanbanAutomationOptions['calls'];
    const calls = {prepareTaskCall: vi.fn(async () => ({})),
        submitPreparedTaskCall: vi.fn(async (input: IndependentCallInput) => {
            submitted.set(input.request.submission!.id, input);
            if(input.request.expectedTarget!.id==='planner') {
                const item=promptData(input.request.source.text,'Snapshot').item,id=input.request.submission!.id;
                const payload=invalid?{}:analysis??{ready:true,dependencies:item.id==='second'?['first']:[],reason:'Uses the prerequisite result',estimate:{complexity:1,workUnits:1,durationMs:60000,confidence:'high'}};
                channels.report(id,'result',{type:'result',content:'Planning result',payload});
            }
            if (loseReply) {loseReply = false; throw new Error('reply lost PRIVATE');}
            return {};
        }),
        inspectTaskCallSubmission: vi.fn(async (input: IndependentCallInput) => !hideAdmission && submitted.has(input.request.submission!.id)
            ? {executionSessionId: 'execution-' + input.request.submission!.id, submission: {task: {sessionId: input.request.expectedSessionId, taskId: input.request.submission!.id}}} : undefined),
        list: vi.fn(async (query: {sessionId: string}) => [...submitted.values()].filter(input => input.request.expectedSessionId === query.sessionId).map(input => ({input,
            callerState: {settled: input.request.expectedTarget!.id === 'planner' || completed.has(input.request.submission!.id)}, executionTree: {settled: true}} as IndependentCallView))),
    } as unknown as Calls;
    const kernel = {task: vi.fn(async (_session: string, id: string) => {
        const input = submitted.get(id)!, planner = input.request.expectedTarget!.id === 'planner';
        const item = planner ? promptData(input.request.source.text,'Snapshot').item : undefined;
        const output = planner ? {message: {content: invalid ? 'INVALID PRIVATE' : JSON.stringify(analysis??{ready: true, dependencies: item.id === 'second' ? ['first'] : [], reason: 'Uses the prerequisite result',
            estimate: {complexity: 1, workUnits: 1, durationMs: 60000, confidence: 'high'}})}} : {message: {content: 'Verified result'}};
        return {id, sessionId: _session, version: 1, effects: {}, exit: {status: 'succeeded', output: {exit: {status: 'succeeded', output}}}} as unknown as TaskRecord;
    })} as unknown as PersonalKanbanAutomationOptions['kernel'];
    const fileJournal=new KanbanAutomationJournal(fs, kanbanJournalOptions);await fileJournal.open();
    const preparation = vi.fn<NonNullable<PersonalKanbanAutomationOptions['prepareAnalysis']>>(async () => {throw prepareFailure;});
    const options: PersonalKanbanAutomationOptions = {prepareAnalysis: prepareFailure ? preparation : undefined, observeWork:async input=>input.observation.outcome==='succeeded'?{...input.observation,outputs:await fileJournal.artifact(input.dispatch.id,{file:'result.yaml',content:'Verified result'})}:input.observation,readAnalysisOutput:vi.fn(async id=>{const output=await readChannelResult({sessionChannel:channels.channel},'project',id,fileJournal);return output===undefined?undefined:{state:'succeeded',output};}),calls, kernel, sessions: {ensureSession: vi.fn(async id => id), getManifest: vi.fn(async id => ({id, title: id})), listSummaries: async () => []} as unknown as PersonalKanbanAutomationOptions['sessions'],
        prepareSession: vi.fn(async () => true), catalog: vi.fn(async () => targets)};
    const diagnostics = new DiagnosticJournal();
    const open = () => createPersonalKanban(fs, events, diagnostics, options.sessions, kernel, options);
    const service = await open(); disposers.push(() => service.dispose());
    await service.create({id: 'board', title: 'Work', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'reviewer', 'coordinator']}], policy: {requireEstimate: true}});
    const command = async (value: KanbanCommand, api = service) => api.execute('board', {operationId: randomUUID(), expectedRevision: (await api.read('board')).revision, command: value});
    const catalog = await service.automationCatalog!();
    const settings: KanbanAutomationSettings = {enabled: true, autoAccept, planner: catalog.targets[0].reference, executor: catalog.targets[1].reference, coordinator: catalog.coordinator, worker: catalog.worker};
    await command({type: 'configure-automation', settings});
    const item = async (id: string) => {await command({type: 'create-item', item: {id, title: id, responsibility: 'Deliver ' + id, acceptance: 'Evidence verified'}});return command({type:'request-run',itemId:id});};
    return {options,journal:fileJournal,events,service, command, item, calls, kernel, preparation, analysisOutput:options.readAnalysisOutput!, submitted, completed, settings, open, diagnostics,
        lose: () => {loseReply = true; hideAdmission = true;}, reveal: () => {hideAdmission = false;}, invalid: () => {invalid = true;},
        executions: () => [...submitted.entries()].filter(([, input]) => input.request.expectedTarget!.id === 'executor')};
}

it('analyzes newly added work, waits for independent acceptance and passes prerequisite evidence to the next execution', async () => {
    const f = await fixture(); await f.item('first'); await f.item('second');
    await f.service.scan(); expect(f.executions()).toHaveLength(1);
    const first = f.executions()[0][0]; f.completed.add(first);
    await f.service.scan();
    expect((await f.service.item('board', 'first')).item.status).toBe('review');
    expect((await f.service.item('board', 'second')).item.planning?.dependencies).toEqual(['first']);
    expect(f.executions()).toHaveLength(1);
    await f.command({type: 'accept-execution', dispatchId: first, accept: true});
    await f.service.scan(); expect(f.executions()).toHaveLength(2);
    const second = f.executions()[1], request = promptData(second[1].request.source.text,'Task');
    expect(request.dependencies[0].outputs[0].value).toEqual({file:'result.yaml',content:'Verified result'});
    expect((await f.service.item('board', 'first')).item.id).toBe('first');
    f.completed.add(second[0]); await f.service.scan();
    expect((await f.service.item('board', 'second')).item.status).toBe('review');
});

it('persists an uncertain analysis and only inspects its original admission after reopening', async () => {
    const f = await fixture(); await f.item('first'); f.lose(); await f.service.scan();
    expect(await f.service.analysisStatus!('board', 'first')).toMatchObject({state: 'unknown', code: 'AUTOMATION_ADMISSION_UNKNOWN'});
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    await f.service.dispose(); const reopened = await f.open(); disposers.push(() => reopened.dispose());
    await reopened.scan(); expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    f.reveal(); await reopened.scan(); expect(f.executions()).toHaveLength(1);
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(2);
});

it('pauses new dispatches while observing existing execution, and auto-accepts only when explicitly configured', async () => {
    const f = await fixture(true); await f.item('first'); await f.service.scan(); const id = f.executions()[0][0];
    await expect(f.command({type: 'configure-automation', settings: {...f.settings, autoAccept: false}})).rejects.toMatchObject({code: 'PLAN_EXECUTION_UNSETTLED'});
    await f.command({type: 'configure-automation', settings: {...f.settings, enabled: false}});
    await f.item('second'); f.completed.add(id); await f.service.scan();
    expect((await f.service.item('board', 'first')).item.status).toBe('completed'); expect(f.executions()).toHaveLength(1);
    await f.command({type: 'configure-automation', settings: f.settings}); await f.service.scan(); expect(f.executions()).toHaveLength(2);
});

it('records invalid planner output without dispatching work or leaking its text into diagnostics', async () => {
    const f = await fixture(); await f.item('first'); f.invalid(); await f.service.scan();
    expect(await f.service.analysisStatus!('board', 'first')).toMatchObject({state: 'failed', code: 'AUTOMATION_ANALYSIS_INVALID'});
    expect(JSON.stringify(await f.diagnostics.query())).not.toContain('PRIVATE');
    expect(f.executions()).toHaveLength(0); await f.service.scan(); expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    expect(() => parseAnalysis({ready: true, dependencies: [12], reason: 'Invalid'})).toThrow('AUTOMATION_DEPENDENCIES_INVALID');
});

it('freezes the original definition at analysis admission and refuses a racing editor', async () => {
    const f = await fixture(); await f.item('first');
    const submit = vi.mocked(f.calls.submitPreparedTaskCall).getMockImplementation()!;
    vi.mocked(f.calls.submitPreparedTaskCall).mockImplementationOnce(async input => {
        await expect(f.command({type:'edit-item',itemId:'first',title:'Updated',responsibility:'Updated work',acceptance:'New checks'})).rejects.toMatchObject({code:'TASK_DEFINITION_FROZEN'});
        return submit(input);
    });
    await f.service.scan();expect(f.executions()).toHaveLength(1);
    expect((await f.service.item('board','first')).item.title).toBe('first');
});

it('admits one planning call when two observers reconcile the same durable item concurrently', async () => {
    const f = await fixture(); await f.item('first'); const second = await f.open(); disposers.push(() => second.dispose());
    await Promise.allSettled([f.service.scan(), second.scan()]);
    await f.service.scan();
    expect([...f.submitted.values()].filter(input => input.request.expectedTarget!.id === 'planner')).toHaveLength(1);
    expect(f.executions()).toHaveLength(1);
    expect(await f.service.analysisStatus!('board', 'first')).toMatchObject({state: 'ready'});
});

it('rejects a chat-only planning Flow without an authorized file result', async () => {
    const {createApplicationRuntime} = await import('../src/runtime/create-application-runtime');
    const {FlowLibraryCommand} = await import('@nestos/app-contracts');
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), startupMode: 'interactive', digitalTwinAutoStart: false});
    disposers.push(() => runtime.dispose());
    const flow = (id: string, value: unknown): import('@nestos/llm-flow/contracts').FlowDraft => ({id: id as never, name: id,
        exposure: 'global', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'}],
        nodes: [{id: 'return' as never, name: 'Return', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value} as never}],
        edges: [], outputs: {result: {value: '${nodes.return.outputs.result}'}}});
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow('planning', {ready: true, dependencies: [], reason: 'No prerequisites'}), flow('execution', 'Produced result')]});
    const service = runtime.kanban!, catalog = await service.automationCatalog!();
    const reference = (id: string) => catalog.targets.find(target => target.reference.id === id)!.reference;
    await service.create({id: 'automatic', title: 'Automatic', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'coordinator', 'reviewer']}], policy: {requireEstimate: false}});
    const execute = async (command: KanbanCommand) => service.execute('automatic', {operationId: randomUUID(), expectedRevision: (await service.read('automatic')).revision, command});
    await execute({type: 'configure-automation', settings: {enabled: true, autoAccept: true, planner: reference('planning'), executor: reference('execution'), coordinator: catalog.coordinator, worker: catalog.worker}});
    await execute({type: 'create-item', item: {id: 'work', title: 'Work', responsibility: 'Produce result', acceptance: 'Execution completes'}});
    await execute({type:'request-run',itemId:'work'});
    await vi.waitFor(async () => {
        await service.scan();
        expect((await service.analysisStatus!('automatic','work'))?.state).toBe('failed');
    },{timeout:10000,interval:50});
    expect(Object.values((await service.workflow('automatic')).dispatches)).toHaveLength(0);
    expect((await service.item('automatic','work')).item.status).toBe('backlog');
}, 15000);

it('never resubmits successful or accepted work during polling and host recovery',async()=>{
    const f=await fixture();await f.item('first');await f.service.scan();const dispatch=f.executions()[0][0];
    f.completed.add(dispatch);await f.service.scan();
    expect((await f.service.item('board','first')).item.status).toBe('review');
    const submissions=f.calls.submitPreparedTaskCall.mock.calls.length;
    for(let index=0;index<3;index++)await f.service.scan();
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(submissions);
    await f.command({type:'accept-execution',dispatchId:dispatch,accept:true});
    expect((await f.service.item('board','first')).item.status).toBe('completed');
    const workflow=await f.service.workflow('board');expect(workflow.ready).toEqual([]);
    await f.service.dispose();const reopened=await f.open();disposers.push(()=>reopened.dispose());
    for(let index=0;index<3;index++)await reopened.scan();
    expect(await reopened.workflow('board')).toEqual(workflow);expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(submissions);
});

it('decomposes complex work into single-project subtasks, gates dependencies on acceptance and completes only the parent aggregate',async()=>{
    const estimate={complexity:2,workUnits:1,durationMs:60000,confidence:'high'};
    const f=await fixture(false,{ready:true,dependencies:[],reason:'Separate verifiable outputs',estimate,
        subtasks:[{key:'parse',title:'Parser',responsibility:'Verify parser',acceptance:'Parser checks pass',dependsOn:[],estimate,projectId:'untrusted-other-project'},
            {key:'render',title:'Renderer',responsibility:'Verify display',acceptance:'Display checks pass',dependsOn:['parse'],estimate}]});
    const reference={system:'nestos-remote-project',id:'one'};
    await f.command({type:'create-item',item:{id:'parent',title:'Parent',responsibility:'Complex work',acceptance:'Children accepted',externalRefs:[reference]}});
    await f.command({type:'request-run',itemId:'parent'});
    await f.service.scan();const board=await f.service.read('board'),children=board.items.filter(item=>item.planning?.parentId==='parent');
    expect(children).toHaveLength(2);expect(children.every(item=>item.planning?.kind==='subtask'&&JSON.stringify(item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project'))===JSON.stringify([reference]))).toBe(true);
    for(const child of children)await f.command({type:'request-run',itemId:child.id});
    await f.service.scan();
    expect(f.executions()).toHaveLength(1);expect((await f.service.item('board','parent')).item.planning?.execution).toBe('children');
    const first=f.executions()[0][0];f.completed.add(first);await f.service.scan();expect(f.executions()).toHaveLength(1);
    expect((await f.service.item('board','parent')).item.status).not.toBe('completed');
    await f.command({type:'accept-execution',dispatchId:first,accept:true});await f.service.scan();expect(f.executions()).toHaveLength(2);
    const second=f.executions()[1][0];f.completed.add(second);await f.service.scan();
    expect((await f.service.item('board','parent')).item.status).not.toBe('completed');
    await f.command({type:'accept-execution',dispatchId:second,accept:true});await f.service.scan();
    expect((await f.service.item('board','parent')).item.status).toBe('completed');
    await f.service.dispose();const reopened=await f.open();disposers.push(()=>reopened.dispose());await reopened.scan();
    expect(f.executions()).toHaveLength(2);expect((await reopened.workflow('board')).ready).toEqual([]);
});
it('rejects cyclic model decomposition before creating any children or starting execution',async()=>{
    const estimate={complexity:2,workUnits:1,durationMs:60000,confidence:'high'};
    const f=await fixture(false,{ready:true,dependencies:[],reason:'Invalid cycle',subtasks:[
        {key:'a',title:'A',responsibility:'Work',acceptance:'Checked',dependsOn:['b'],estimate},
        {key:'b',title:'B',responsibility:'Work',acceptance:'Checked',dependsOn:['a'],estimate}]});
    await f.item('parent');await f.service.scan();expect((await f.service.read('board')).items).toHaveLength(1);expect(f.executions()).toHaveLength(0);
    expect(await f.service.analysisStatus!('board','parent')).toMatchObject({state:'failed',code:'DEPENDENCY_CYCLE'});
});

it('executes manually created subtasks and aggregates their accepted results without executing the parent',async()=>{
    const f=await fixture();await f.item('parent');
    await f.command({type:'create-item',item:{id:'child',title:'Child scope',responsibility:'Only child work',acceptance:'Child evidence'},
        planning:{kind:'subtask',parentId:'parent',priority:2,dependencies:[],references:[]}});
    await f.command({type:'request-run',itemId:'child'});
    await f.service.scan();expect(f.executions()).toHaveLength(1);
    const [dispatch,input]=f.executions()[0];
    expect(input.request.source.text).toContain('Only child work');
    f.completed.add(dispatch);await f.service.scan();
    expect((await f.service.item('board','parent')).item.status).toBe('backlog');
    await f.command({type:'accept-execution',dispatchId:dispatch,accept:true});
    await expect(f.command({type:'archive-items',itemIds:['child'],reason:'Verified'})).rejects.toThrow('SUBTASK_CLEANUP_VIA_GROUP');
    await f.service.scan();expect((await f.service.item('board','parent')).item.status).toBe('completed');
    await f.command({type:'archive-items',itemIds:['parent'],reason:'Verified group'});
    expect((await f.service.item('board','parent')).archive?.reason).toBe('Verified group');
    expect((await f.service.item('board','child')).archive?.reason).toBe('Verified group');
    expect(f.executions()).toHaveLength(1);
});

it('projects two explicit EFFECT_TIMEOUT analysis attempts to the root task, work log and notifications without dispatch or silent retry',async()=>{
    const f=await fixture();await f.item('timeout');
    vi.mocked(f.kernel.task).mockResolvedValue({id:'caller',sessionId:'session',version:1,effects:{},exit:{status:'failed',error:{code:'EFFECT_TIMEOUT'}}} as never);
    await f.service.scan();
    expect((await f.service.item('board','timeout')).item.analysis).toMatchObject({state:'failed',code:'EFFECT_TIMEOUT'});
    expect((await f.service.query('board',{view:'all',phase:'error'})).items.map(item=>item.id)).toContain('timeout');
    await f.service.scan();expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    await f.command({type:'retry-analysis',itemId:'timeout',retryId:'second-analysis'});await f.service.scan();
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(2);expect(f.executions()).toHaveLength(0);
    expect(f.calls.prepareTaskCall.mock.calls[0][1]).toMatchObject({timeoutMs:null});
    expect((await f.events.listNotifications()).items.filter(row=>row.event.value.type==='kanban.report-analysis')).toHaveLength(2);
    expect((await f.service.records('board',{itemId:'timeout'})).items.some(row=>row.activity?.code==='EFFECT_TIMEOUT')).toBe(true);
});


it.each(['ENOENT', 'EACCES'])('keeps a permanent Cells preparation fault %s as an error without cancelling the task', async code => {
    const f = await fixture(false, undefined, Object.assign(new Error('Cells unavailable'), {code}));
    await f.item('unavailable'); await f.service.scan(); await f.service.scan();
    const item = await f.service.item('board', 'unavailable');
    expect(item.item.status).toBe('backlog'); expect(item.task).toMatchObject({phase: 'error', reason: code});
    expect(item.item.analysis).toMatchObject({state: 'failed', code});
    expect(item.item.control).toBeUndefined(); expect(f.calls.submitPreparedTaskCall).not.toHaveBeenCalled();
    expect((await f.service.events('board')).some(event => event.kind === 'control-receipt')).toBe(false);
});

it('retains the analysis identity and retry budget across reopening, then reports an exhausted preparation timeout', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    const f = await fixture(false, undefined, Object.assign(new Error('Cells unavailable'), {code: 'ETIMEDOUT'}));
    await f.item('unavailable'); await f.service.scan();
    expect((await f.service.item('board', 'unavailable')).item.analysis).toMatchObject({state: 'analyzing',
        recovery: {attempt: 0, limit: 10, code: 'ETIMEDOUT'}});
    await f.service.dispose(); const reopened = await f.open(); disposers.push(() => reopened.dispose());
    await reopened.scan(); expect(f.preparation).toHaveBeenCalledTimes(1);
    for (let retry = 1; retry <= 10; retry++) {
        vi.setSystemTime(Date.now() + 30000); await reopened.scan();
        expect(f.preparation).toHaveBeenCalledTimes(retry + 1);
        if (retry < 10) expect((await reopened.item('board', 'unavailable')).item.analysis)
            .toMatchObject({state: 'analyzing', recovery: {attempt: retry, code: 'ETIMEDOUT'}});
    }
    const item = await reopened.item('board', 'unavailable');
    expect(item.item.status).toBe('backlog'); expect(item.task).toMatchObject({phase: 'error', reason: 'ETIMEDOUT'});
    expect(item.item.analysis).toMatchObject({state: 'failed', code: 'ETIMEDOUT'}); expect(item.item.control).toBeUndefined();
    expect(new Set(vi.mocked(f.preparation).mock.calls.map(([input]) => input.id)).size).toBe(1);
    await reopened.scan(); expect(f.preparation).toHaveBeenCalledTimes(11);
    expect(f.calls.submitPreparedTaskCall).not.toHaveBeenCalled();
});

it('retains one planning session while waiting for clarification and resumes the approved plan after host recovery',async()=>{
    const f=await fixture(false,{ready:false,reason:'Confirm scope',dependencies:[]});
    await f.item('first');await f.service.scan();
    const firstInput=[...f.submitted.values()][0],planningId=firstInput.request.submission!.id;
    expect(await f.service.analysisStatus!('board','first')).toMatchObject({state:'clarification'});
    expect(await f.service.planningSession!('board','first')).toMatchObject({analysisId:planningId,state:'waiting-input',sessionId:'execution-'+planningId});
    await expect(f.command({type:'retry-analysis',itemId:'first',retryId:randomUUID()})).rejects.toMatchObject({code:'ANALYSIS_CLARIFICATION_PENDING'});
    await f.service.scan();expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);expect(f.executions()).toHaveLength(0);
    await f.service.dispose();const reopened=await f.open();disposers.push(()=>reopened.dispose());
    await reopened.scan();expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    // Unrelated work must not invalidate this item's frozen planning definition.
    await f.command({type:'create-item',item:{id:'unrelated',title:'Other',responsibility:'Other',acceptance:'Other'}},reopened);
    vi.mocked(f.analysisOutput).mockResolvedValue({state:'succeeded',output:{ready:true,reason:'Confirmed scope',dependencies:[],estimate:{complexity:1,workUnits:1,durationMs:60000,confidence:'high'}}});
    await reopened.scan();expect(f.executions()).toHaveLength(1);
    expect(await reopened.planningSession!('board','first')).toMatchObject({analysisId:planningId,state:'completed'});
    await reopened.scan();expect(f.executions()).toHaveLength(1);
});

it('recovers clarification projection conflicts without restarting the planning session',async()=>{
    const f=await fixture(false,{ready:false,reason:'Confirm scope',dependencies:[]});
    await f.item('first');await f.service.scan();
    const session=await f.service.planningSession!('board','first');
    // The same durable report must be applicable again after an interrupted synchronization.
    await f.command({type:'report-analysis',itemId:'first',operationId:'sync-fault',status:{itemId:'first',state:'failed',code:'IDEMPOTENCY_CONFLICT'}});
    await f.service.scan();
    expect((await f.service.item('board','first')).task?.phase).toBe('waiting-input');
    expect(await f.service.planningSession!('board','first')).toMatchObject({sessionId:session!.sessionId,state:'waiting-input'});
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    expect(f.executions()).toHaveLength(0);
    await f.service.scan();expect((await f.service.item('board','first')).task?.phase).toBe('waiting-input');
});
it('does not create development subtasks from an unclarified planning result',async()=>{
    const tasks=['one','two'].map(key=>({key,title:key,responsibility:'Work '+key,acceptance:'Verify '+key,dependsOn:[]}));
    const f=await fixture(false,{ready:false,reason:'Confirm product scope',dependencies:[],subtasks:tasks});
    await f.item('first');await f.service.scan();await f.service.scan();
    expect((await f.service.item('board','first')).task?.phase).toBe('waiting-input');
    expect((await f.service.query('board',{view:'all',parentId:'first'})).total).toBe(0);
    expect(Object.keys((await f.service.workflow('board')).plans)).toHaveLength(0);
    expect(f.executions()).toHaveLength(0);
});

it('resumes a blocked planning conversation in the same session across host reopening without another admission',async()=>{
 const f=await fixture();vi.mocked(f.analysisOutput).mockResolvedValue({state:'blocked',code:'PLANNING_ERROR_REPORTED',reason:'Git needs repair'} as never);
 await f.item('first');await f.service.scan();
 const original=await f.service.planningSession!('board','first');
 expect(original).toMatchObject({state:'waiting-input'});
 expect((await f.service.item('board','first')).task).toMatchObject({phase:'error',reason:'PLANNING_ERROR_REPORTED'});
 expect(f.executions()).toHaveLength(0);
 await f.service.dispose();const reopened=await f.open();disposers.push(()=>reopened.dispose());
 await reopened.scan();expect(await reopened.planningSession!('board','first')).toMatchObject({sessionId:original!.sessionId,state:'waiting-input'});
 vi.mocked(f.analysisOutput).mockResolvedValue({state:'running'} as never);await reopened.scan();
 expect(await reopened.planningSession!('board','first')).toMatchObject({sessionId:original!.sessionId,state:'running'});
 expect(f.executions()).toHaveLength(0);
 vi.mocked(f.analysisOutput).mockResolvedValue({state:'succeeded',output:{ready:true,reason:'Git checked; scope confirmed',dependencies:[],estimate:{complexity:1,workUnits:1,durationMs:60000,confidence:'high'}}});
 await reopened.scan();expect(f.executions()).toHaveLength(1);
 expect(await reopened.planningSession!('board','first')).toMatchObject({sessionId:original!.sessionId,state:'completed'});
 expect([...f.submitted.values()].filter(input=>input.request.expectedTarget!.id==='planner')).toHaveLength(1);
});

it('ensures a persistent decision coordination Session before a worktree preparation failure',async()=>{
 const fault=Object.assign(new Error('Git baseline unavailable'),{code:'GIT_WORKTREE_CREATE_FAILED'}),f=await fixture(false,undefined,fault),stages:string[]=[];
 await f.item('first');
 await f.command({type:'append-record',record:{id:'decision',kind:'decision',title:'Decision',content:'Scope',rationale:'Checked',itemIds:['first'],sources:[]}});
 await f.command({type:'review-record',recordId:'decision',accept:true});
 await f.command({type:'link-reference',itemId:'first',reference:{system:'nestos-decision-run',id:'decision-run'}});
 const record=await f.service.record('board','decision');await f.journal.update('record-context:decision-run',()=>({sourceBoardId:'board',recordId:'decision',recordRevision:record.revision,runId:'decision-run'}));
 await f.service.dispose();
 const openRecordCoordination=vi.fn(async()=>{stages.push('communication');return {id:'retained',boardId:'board',recordId:'decision',sessionId:'native',resourceId:'/native/retained',state:'confirmed',createdAt:1};});
 f.options.decisionConversations=()=>({openRecordCoordination,startRecordConversation:vi.fn(),recordConversations:async()=>[],scan:async()=>{},quiesce:async()=>{}}) as any;
 vi.mocked(f.preparation).mockImplementation(async()=>{stages.push('worktree');throw fault;});
 const reopened=await f.open();disposers.push(()=>reopened.dispose());
 expect(stages.slice(0,2)).toEqual(['communication','worktree']);
 expect(openRecordCoordination).toHaveBeenCalledWith('board',expect.objectContaining({recordId:'decision'}));
 expect((await reopened.item('board','first')).item.analysis?.code).toBe('GIT_WORKTREE_CREATE_FAILED');
});
