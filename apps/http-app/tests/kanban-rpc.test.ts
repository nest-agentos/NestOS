import {expect, it, vi} from 'vitest';
import {createApplicationRuntime} from '@nestos/app-core';
import {openApplicationView} from '@nestos/app-core/host';
import {MemoryBackend} from '@nestos/vfs-core';
import {RpcPeer, installViewProjections} from '@nestos/app-transport/application';
import {executionSessionReference} from '@nestos/app-contracts';

it('exposes user-bound Kanban commands, queries and system notifications through real RPC', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', startupMode: 'interactive', digitalTwinAutoStart: false});
    const operationView = {revision: 'snapshot', operations: [{id: 'merge', label: 'Merge', state: 'waiting-confirmation', enabled: true, fields: [{id: 'file', label: 'File', choices: [{id: 'keep', label: 'Keep'}]}]}]};
    const operationPorts = {itemOperations: vi.fn(async () => operationView), runItemOperation: vi.fn(async () => operationView), bindItemOperation: vi.fn(async () => operationView)};
    const recoveryPorts={taskRecovery:vi.fn(async()=>({itemId:'card',revision:'r',related:[],canRetry:true,canSelectCurrentVersion:false})),recoverTask:vi.fn(async()=>({operationId:'retry',state:'pending'})),startRecordConversation:vi.fn(async()=>({id:'discussion',boardId:'rpc-board',state:'clarifying',createdAt:1,resourceId:'/native/original'})),recordConversations:vi.fn(async()=>[]),previewTaskRestart:vi.fn(async()=>({itemId:'card',version:'v',affected:[{id:'card',title:'Card',status:'cancelled',started:true}]})),restartTask:vi.fn(async()=>({operationId:'restart',itemId:'card',state:'stopping',affectedIds:['card']}))};
    Object.assign(runtime.kanban!, operationPorts,recoveryPorts);
    const view = await openApplicationView(runtime), report = vi.fn();
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), report, installViewProjections);
    server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);}, report);
    try {
        const boot = await server.bootstrap({services: view.services, backend: view.backend}); client.applyUpdates(boot.updates);
        const remote = client.decode(boot.value!), kanban = remote.services.kanban;
        expect(await kanban.taskRecovery('rpc-board','card')).toMatchObject({itemId:'card',canRetry:true});
        expect(await kanban.recoverTask('rpc-board',{operationId:'retry',itemId:'card',action:'retry',expectedRevision:'r'})).toMatchObject({state:'pending'});
        expect(await kanban.startRecordConversation('rpc-board',{operationId:'discussion'})).toMatchObject({resourceId:'/native/original'});
        expect(await kanban.recordConversations('rpc-board')).toEqual([]);
        expect(await kanban.previewTaskRestart('rpc-board','card')).toMatchObject({version:'v'});
        const restart={operationId:'restart',itemId:'card',version:'v',confirmed:true};
        expect(await kanban.restartTask('rpc-board',restart)).toMatchObject({state:'stopping'});expect(recoveryPorts.restartTask).toHaveBeenCalledWith('rpc-board',restart);
        const initial = await remote.backend.initialFiles();
        expect((await initial.list()).find((entry: {id: string}) => entry.id === 'kanban:nestos-demo')).toMatchObject({group: 'kanban', exists: true});
        expect(await initial.restore(['kanban:nestos-demo'])).toEqual([{id: 'kanban:nestos-demo', status: 'preserved'}]);
        const actor = await kanban.currentPrincipal(); expect(actor).toEqual({kind: 'human', id: 'admin'});
        const automation = await kanban.automationCatalog();
        expect(automation).toMatchObject({coordinator: {kind: 'service', id: 'kanban-planner'}, worker: {kind: 'service', id: 'kanban-worker'}});
        expect(Array.isArray(automation.targets)).toBe(true);
        const board = await kanban.create({id: 'board', title: 'Work', scope: {kind: 'system'}, members: [{...actor, responsibility: 'Work', roles: ['worker','coordinator','reviewer']}], policy: {requireEstimate: false, review: 'assignee'}, notifications: {rules: {'create-item': 'info'}}});
        await kanban.execute(board.id, {operationId: 'create-card', expectedRevision: board.revision, command: {type: 'create-item', item: {id: 'card', title: 'PRIVATE_CARD_TITLE', responsibility: 'PRIVATE_BODY', acceptance: 'Verified'}}});
        const directory = await kanban.catalog();
        expect(directory.find((entry: {id: string}) => entry.id === board.id).items).toEqual([{id:'card',title:'PRIVATE_CARD_TITLE',number:1,taskType:'execution'}]);
        expect(JSON.stringify(directory)).not.toContain('PRIVATE_BODY');
        const page = await kanban.query(board.id, {view: 'backlog'}); expect(page.items).toHaveLength(1);
        const candidates = await kanban.suggest(board.id, {kind: 'item', search: 'PRIVATE_CARD_TITLE'});
        expect(candidates.items[0]).toMatchObject({id: 'card', label: 'PRIVATE_CARD_TITLE'}); expect(JSON.stringify(candidates)).not.toContain('PRIVATE_BODY');
        expect(await kanban.resolve(`KB-${board.number}#1`)).toMatchObject({boardId:board.id,itemId:'card'});
        const read = await kanban.item(board.id, 'card'); expect(read.item.status).toBe('backlog');
        expect(read.task.phase).toBe('waiting-start');expect(read.task.startAt-read.item.createdAt).toBe(300000);
        expect((await kanban.query(board.id,{view:'all',phase:'waiting-start'})).items[0].task).toMatchObject(read.task);
        expect(await kanban.analysisStatus(board.id, 'card')).toBeNull();
        const notifications = await remote.backend.events.listNotifications(); expect(notifications.items).toHaveLength(1);
        expect(notifications.items[0].event.value.type).toBe('kanban.create-item'); expect(JSON.stringify(notifications)).not.toContain('PRIVATE_');
        await kanban.execute(board.id,{operationId:'archive-fixture-create',expectedRevision:(await kanban.read(board.id)).revision,command:{type:'append-record',record:{id:'archive-fixture',kind:'decision',title:'Closed proposal',content:'Scope',rationale:'Done',itemIds:[],sources:[]}}});
        await kanban.execute(board.id,{operationId:'archive-fixture-reject',expectedRevision:(await kanban.read(board.id)).revision,command:{type:'review-record',recordId:'archive-fixture',accept:false}});
        const archiveRevision=(await kanban.record(board.id,'archive-fixture')).revision;
        expect(await kanban.archiveRecords(board.id,{operationId:'archive-rpc',records:[{recordId:'archive-fixture',expectedRevision:archiveRevision}]})).toMatchObject({items:[{recordId:'archive-fixture',outcome:'archived'}]});
        expect((await kanban.records(board.id)).items.some((row:{id:string})=>row.id==='archive-fixture')).toBe(false);
        expect((await kanban.records(board.id,{includeArchived:true})).items.find((row:{id:string})=>row.id==='archive-fixture')).toMatchObject({status:'rejected',archivedAt:expect.any(Number)});
        expect((await kanban.record(board.id,'archive-fixture')).status).toBe('rejected');

        const sessionId = await runtime.sessionRepository.createSession('Autocomplete planning session');
        const sessions = await kanban.suggest(board.id, {kind: 'session', search: 'Autocomplete planning'});
        expect(sessions.items[0]).toMatchObject({id: sessionId, label: 'Autocomplete planning session'});
        await kanban.execute(board.id,{operationId:'bind-execution-session',expectedRevision:(await kanban.read(board.id)).revision,command:{type:'link-reference',itemId:'card',reference:executionSessionReference(sessionId,'binding-one')}});
        const execution=await kanban.executionSession(board.id,'card');expect(execution.current.sessionId).toBe(sessionId);
        expect(execution.history).toEqual([{sessionId,bindingId:'binding-one',current:true}]);
        const related = await kanban.executionSession(board.id,'card',{includeRelated:true});
        expect(related.sessions).toEqual([expect.objectContaining({sessionId,current:true,purposes:['execution'],executions:[]})]);
        expect(related.sessionsCode).toBeUndefined();
        expect((await kanban.queryActivity(board.id,{view:'all'})).items.find((item:{id:string})=>item.id==='card').execution.sessionId).toBe(sessionId);
        expect(JSON.stringify(execution)).not.toContain('taskId');
        expect(await kanban.itemOperations(board.id, 'card')).toEqual(operationView);
        const operation = {operationId: 'merge-review', itemId: 'card', action: 'merge', expectedRevision: 'snapshot', confirmed: true, selections: {file: 'keep'}};
        expect(await kanban.runItemOperation(board.id, operation)).toEqual(operationView); expect(operationPorts.runItemOperation).toHaveBeenCalledWith(board.id, operation);
        const binding = {operationId: 'bind-review', itemId: 'card', action: 'merge', expectedRevision: 'snapshot', target: {system: 'nestos-published-flow', id: 'merge-project', revision: '1'}};
        expect(await kanban.bindItemOperation(board.id, binding)).toEqual(operationView); expect(operationPorts.bindItemOperation).toHaveBeenCalledWith(board.id, binding);
        const current = await kanban.read(board.id);
        await kanban.execute(board.id, {operationId: 'record-log', expectedRevision: current.revision, command: {type: 'append-record', record: {id: 'log', kind: 'log', title: 'Work evidence', content: 'PRIVATE_LOG_BODY', itemIds: ['card'], sources: []}}});
        expect((await kanban.records(board.id, {itemId: 'card'})).items).toEqual(expect.arrayContaining([expect.objectContaining({id: 'log', kind: 'log'})]));
        expect((await kanban.record(board.id, 'log')).content).toBe('PRIVATE_LOG_BODY');
        expect(JSON.stringify(await remote.backend.events.listNotifications())).not.toContain('PRIVATE_LOG_BODY');
        expect((await kanban.workflow(board.id)).ready).toEqual([]);
        const resources=await kanban.itemResources(board.id);expect(Array.isArray(resources.resources)).toBe(true);
        await kanban.execute(board.id,{operationId:'publish-work',expectedRevision:(await kanban.read(board.id)).revision,command:{type:'publish-plan',plan:{schema:'kanban.plan/1',id:'work',revision:1,sealed:true,items:[{id:'action',title:'Action',responsibility:'Build',acceptance:'Verified',assignee:actor,dependsOn:[]}]}}});
        expect((await kanban.workflow(board.id)).ready).toEqual(['action']);
        await kanban.execute(board.id,{operationId:'dispatch-work',expectedRevision:(await kanban.read(board.id)).revision,command:{type:'prepare-dispatch',itemId:'action',dispatchId:'dispatch'}});
        const dispatch=(await kanban.workflow(board.id)).dispatches.dispatch;
        await kanban.execute(board.id,{operationId:'observe-work',expectedRevision:(await kanban.read(board.id)).revision,command:{type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'succeeded'}});
        expect((await kanban.workflow(board.id)).completedPlans).toEqual(['work']);
        await expect(kanban.create({id: 'wrong-store', title: 'Project', scope: {kind: 'project', projectId: 'other'}, members: [{...actor, responsibility: 'Work'}]})).rejects.toMatchObject({code: 'PROJECT_STORE_REQUIRED'});
        const disposable = await kanban.create({id: 'delete-fixture', title: 'Delete fixture', scope: {kind: 'system'}, members: [{...actor, responsibility: 'Manage', roles: ['coordinator', 'worker']}]});
        const preview = await kanban.previewDeletion(disposable.id);
        expect(preview).toMatchObject({boardId: disposable.id, blockers: [], resources: []});
        const removeRequest = {operationId: 'delete-fixture', version: preview.version, expectedRevision: preview.revision, cleanup: false};
        await kanban.deleteBoard(disposable.id, removeRequest); await kanban.deleteBoard(disposable.id, removeRequest);
        expect((await kanban.catalog()).some((row: {id: string}) => row.id === disposable.id)).toBe(false);
        expect((await kanban.read(disposable.id)).deletedAt).toBeTypeOf('number');
        expect(report).not.toHaveBeenCalled();
    } finally {await client.close(); await server.close(); await view.close(); await runtime.dispose();}
}, 15000);

it('keeps fix and linked reply mutations callable through the declared Kanban RPC capability',async()=>{
    const fixTask=vi.fn(async(_board,request)=>({id:request.operationId,sessionId:'fix-session'})),replyTask=vi.fn(async()=>{}),report=vi.fn();let server!:RpcPeer;
    const client=new RpcPeer('client',call=>server.handle(call),report,installViewProjections);
    server=new RpcPeer('server',async call=>{client.applyUpdates(await server.refresh());return client.handle(call);},report);
    try {
        const boot=await server.bootstrap({overview:async()=>({}),related:async()=>[],scan:async()=>{},execute:async()=>{},fixTask,replyTask});client.applyUpdates(boot.updates);const remote=client.decode(boot.value!);
        const request={itemId:'original',operationId:'stable-fix'};expect(await remote.fixTask('development',request)).toMatchObject({sessionId:'fix-session'});
        await remote.replyTask('development',request);expect(fixTask).toHaveBeenCalledExactlyOnceWith('development',request);expect(replyTask).toHaveBeenCalledExactlyOnceWith('development',request);expect(report).not.toHaveBeenCalled();
    }finally{await client.close();await server.close();}
});

it('round-trips board settings through the declared RPC capability with revision and retry identity',async()=>{
    const runtime=await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web',startupMode:'interactive',digitalTwinAutoStart:false});
    const boardSettings=vi.fn(async()=>({fields:[{name:'harness-execution',label:'Execution',choices:[{value:'',label:'Default'},{value:'codex',label:'Codex'}]}]}));
    Object.assign(runtime.kanban!,{boardSettings});const view=await openApplicationView(runtime),report=vi.fn();let server!:RpcPeer;
    const client=new RpcPeer('client',call=>server.handle(call),report,installViewProjections);
    server=new RpcPeer('server',async call=>{client.applyUpdates(await server.refresh());return client.handle(call);},report);
    try{
        const boot=await server.bootstrap({services:view.services,backend:view.backend});client.applyUpdates(boot.updates);const remote=client.decode(boot.value!).services.kanban;
        const actor=await remote.currentPrincipal();const board=await remote.create({id:'settings-rpc',title:'Settings',scope:{kind:'system'},members:[{...actor,responsibility:'Manage',roles:['coordinator','reviewer','worker']}]});
        expect((await remote.boardSettings(board.id)).fields[0].name).toBe('harness-execution');expect(boardSettings).toHaveBeenCalledWith(board.id);
        const request={operationId:'settings-save',expectedRevision:board.revision,command:{type:'configure-board-settings',settings:{'harness-execution':'codex'}}};
        await remote.execute(board.id,request);await remote.execute(board.id,request);
        expect((await remote.read(board.id)).settings).toEqual({'harness-execution':'codex'});
        await expect(remote.execute(board.id,{...request,operationId:'stale-save'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(report).not.toHaveBeenCalled();
    }finally{await client.close();await server.close();await view.close();await runtime.dispose();}
},15000);
