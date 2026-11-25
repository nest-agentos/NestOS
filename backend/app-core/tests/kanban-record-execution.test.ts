import {kanbanControlOptions} from '../src/kanban/control-adapter';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule} from '@nestos/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import type {KanbanCommand, KanbanWorkType} from '@nestos/kanban/contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {KanbanAutomationJournal,recurrenceAdmission} from '@nestos/kanban/integration';
import {createRecordExecution} from '@nestos/kanban/integration';
import {validateRemoteReferences, projectResourceCatalog} from '../src/kanban/resource-catalog';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture(enabled:boolean|null = true, workTypes?: KanbanWorkType[]) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), journal = new KanbanAutomationJournal(fs, kanbanJournalOptions);
    await journal.open();
    const actor = {kind: 'human' as const, id: 'admin'}, log = vi.fn();
    const service = createKanbanModule({store, actor, authorize: async () => {}, log});
    const folders = ['one', 'two', 'local'].map(id => ({name: id, path: '/' + id, project: {id, source: {kind: id === 'local' ? 'local' : 'remote'}}}));
    const projects = {list: async () => folders, get: async (id: string) => {
        const row = folders.find(row => row.project.id === id); if (!row) throw Object.assign(new Error('Missing'), {code: 'ENOENT'}); return row;
    }} as unknown as Pick<ProjectService, 'list' | 'get'>;
    await service.create({id: 'source', title: 'Development', ...(workTypes ? {workTypes, defaultWorkType: workTypes.find(type => type.executable)!.id} : {}), scope: {kind: 'system'}, members: [{...actor, responsibility: 'Manage', roles: ['coordinator', 'reviewer', 'worker']}, {kind: 'human', id: 'reviewer', responsibility: 'Review', roles: ['reviewer']}], policy: {requireEstimate: false, review: 'assignee'}});
    const reviewer = createKanbanModule({store, actor: {kind: 'human', id: 'reviewer'}, authorize: async () => {}, log});
    let sequence = 0;
    const command = async (command: KanbanCommand) => (command.type === 'review' ? reviewer : service).execute('source', {operationId: 'request-' + ++sequence, expectedRevision: (await service.read('source')).revision, command});
    if(enabled!==null)await command({type: 'configure-automation', settings: {enabled, autoAccept: false,
        planner: {system: 'agent', id: 'planner', revision: '1'}, executor: {system: 'agent', id: 'worker', revision: '1'},
        coordinator: {kind: 'service', id: 'planner'}, worker: {kind: 'service', id: 'worker'}}});
    await command({type: 'append-record', record: {id: 'decision', kind: 'decision', title: 'Goal', content: 'PRIVATE_REQUIREMENT', rationale: 'Acceptance criteria', itemIds: [], sources: [],
        externalRefs: ['one', 'two'].map(id => ({system: 'nestos-remote-project', id}))}});
    const open = () => createRecordExecution({service, journal, resources: projectResourceCatalog(projects), log});
    return {service, command, open, projects, log, journal,fs};
}

async function completeCoordination(f:Awaited<ReturnType<typeof fixture>>,id:string):Promise<void>{
 const board=await f.service.read('source'),parent=board.items.find(item=>item.id===id)!,rank=(board.workTypes??(await import('@nestos/kanban/contracts')).DEFAULT_KANBAN_WORK_TYPES).find(type=>type.id===parent.planning?.kind)!.rank;
 const type=(board.workTypes??(await import('@nestos/kanban/contracts')).DEFAULT_KANBAN_WORK_TYPES).find(type=>type.executable&&type.rank>rank)!;
 const child=id+'-execute';await f.command({type:'create-item',item:{id:child,title:'Execute',responsibility:'Implement',acceptance:'Verified'},planning:{kind:type.id,parentId:id,priority:2,dependencies:[],references:[]}});
 await f.command({type:'finish-planning',itemId:id});await f.command({type:'set-stage',itemId:child,stage:'open'});
 const claimed=await f.command({type:'claim',itemId:child});await f.command({type:'submit',itemId:child,token:claimed.items.find(item=>item.id===child)!.owner!.token,resultRef:'verified'});
 await f.command({type:'review',itemId:child,accept:true});await f.command({type:'close-plan',itemId:id,resultRef:'children-verified'});
}

it('resumes a persisted recurring intent through the existing execution path with a frozen snapshot',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const before=await f.service.record('source','decision');
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:{state:'active',firstAt:1000,timeZone:'UTC',cadence:{kind:'interval',milliseconds:60000},trigger:'fixed',maxConcurrency:2}});
 const snapshot=await f.service.record('source','decision'),execution=f.open();
 const engine=recurrenceAdmission({journal:f.journal,log:f.log,inspect:async intent=>{
  const run=await f.journal.run<any>(intent.boardId,intent.id);return run?{state:run.state==='completed'?'settled':'admitted',runId:run.id}:{state:'unknown'};
 },submit:async intent=>{const run=await execution.runRecurring(intent);return {state:'admitted',runId:run.id};}});
 await f.command({type:'reserve-record-recurrence',recordId:'decision',configRevision:snapshot.recurrenceRevision!,scheduledAt:1000});
 await f.command({type:'reserve-record-recurrence',recordId:'decision',configRevision:snapshot.recurrenceRevision!,scheduledAt:61000});
 const reserved=await f.service.record('source','decision'),[firstFence,secondFence]=reserved.recurrenceFence!.pending;
 const first=await engine.reserve('source',firstFence.record,firstFence.configRevision,firstFence.scheduledAt);
 const second=await engine.reserve('source',secondFence.record,secondFence.configRevision,secondFence.scheduledAt);
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:reserved.revision,recurrence:{...snapshot.recurrence!,state:'paused'}});
 expect((await f.service.read('source')).items).toHaveLength(0);
 const result=await engine.reconcile((await engine.read('source','decision'))[0]);
 expect(result).toMatchObject({id:first.id,phase:'admitted',runId:first.id});
 await engine.reconcile(second);
 expect((await f.service.read('source')).items).toHaveLength(2);
 expect((await execution.recordExecutions('source','decision')).map(row=>row.id)).toEqual([first.id,second.id]);
 expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REQUIREMENT');
});

it('reconciles a lost task creation receipt without creating a second recurring task',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const before=await f.service.record('source','decision');
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:{state:'active',firstAt:1000,timeZone:'UTC',cadence:{kind:'interval',milliseconds:60000},trigger:'fixed',maxConcurrency:1}});
 const snapshot=await f.service.record('source','decision'),original=f.service.execute.bind(f.service);let lost=false;
 vi.spyOn(f.service,'execute').mockImplementation(async(board,request)=>{
  const result=await original(board,request);if(request.command.type==='create-item'&&!lost){lost=true;throw Object.assign(new Error('PRIVATE_REPLY'),{code:'EIO'});}return result;
 });
 const open=()=>{const execution=f.open();return {execution,engine:recurrenceAdmission({journal:f.journal,log:f.log,inspect:async intent=>{
  const run=await f.journal.run<any>(intent.boardId,intent.id);return run?{state:'admitted',runId:run.id}:{state:'unknown'};
 },submit:async intent=>{const run=await execution.runRecurring(intent);return {state:'admitted',runId:run.id};}})};};
 await f.command({type:'reserve-record-recurrence',recordId:'decision',configRevision:snapshot.recurrenceRevision!,scheduledAt:1000});
 const reservation=(await f.service.record('source','decision')).recurrenceFence!.pending[0];
 const first=open(),intent=await first.engine.reserve('source',reservation.record,reservation.configRevision,reservation.scheduledAt);
 expect((await first.engine.reconcile(intent)).phase).toBe('unknown');expect((await f.service.read('source')).items).toHaveLength(1);
 const restored=open();expect((await restored.engine.reconcile(intent)).phase).toBe('admitted');await restored.execution.scan();
 expect((await f.service.read('source')).items).toHaveLength(1);expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REPLY');
});
it('rejects a stale journal intent that has no committed board reservation',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const before=await f.service.record('source','decision');
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:{state:'active',firstAt:1000,timeZone:'UTC',cadence:{kind:'interval',milliseconds:60000},trigger:'fixed',maxConcurrency:1}});
 const snapshot=await f.service.record('source','decision'),execution=f.open();
 const engine=recurrenceAdmission({journal:f.journal,log:f.log,inspect:async()=>({state:'unknown'}),submit:async intent=>{const run=await execution.runRecurring(intent);return {state:'admitted',runId:run.id};}});
 const intent=await engine.reserve('source',snapshot,snapshot.recurrenceRevision!,1000);
 expect(await engine.reconcile(intent)).toMatchObject({phase:'unknown',code:'RECURRENCE_RESERVATION_MISSING'});
 expect((await f.service.read('source')).items).toHaveLength(0);
});

it('automatically schedules due rounds through runtime scans and pauses new admission',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture();
 await f.command({type:'review-record',recordId:'decision',accept:true});let clock=Date.now();
 const before=await f.service.record('source','decision'),config={state:'active' as const,firstAt:clock+60000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log,now:()=>clock});cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(0);expect((await runtime.service.record('source','decision')).recurrenceNextAt).toBe(config.firstAt);
 clock+=60000;await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(1);
 const started=await f.service.record('source','decision');expect(started.recurrenceFence?.pending).toHaveLength(1);
 clock+=60000;await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(1);
 const current=await f.service.record('source','decision');await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:current.revision,recurrence:{...config,state:'paused'}});
 clock+=60000;await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(1);
 expect((await f.service.record('source','decision')).recurrenceFence?.pending[0].record.recurrence?.state).toBe('active');
});
it('retries the same reserved round after board automation is enabled',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture(false);
 await f.command({type:'review-record',recordId:'decision',accept:true});
 let clock=Date.now();
 const before=await f.service.record('source','decision');
 const config={state:'active' as const,firstAt:clock+60000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log,now:()=>clock});
 cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();
 clock=config.firstAt;
 await runtime.service.scan();
 const [reserved]=(await f.service.record('source','decision')).recurrenceFence!.pending;
 const board=await f.service.read('source');
 expect(board.items).toHaveLength(0);
 expect(f.log).toHaveBeenCalledWith(expect.objectContaining({operationId:reserved.id,stage:'recurrence.admit',result:'failure',code:'AUTOMATION_PAUSED'}));
 await f.command({type:'configure-automation',settings:{...board.automation!,enabled:true}});
 await runtime.service.scan();
 await runtime.service.scan();
 const [run]=await runtime.service.recordExecutions!('source','decision');
 expect(run).toMatchObject({id:reserved.id,scheduledAt:config.firstAt});
 expect((await f.service.read('source')).items.map(item=>item.id)).toEqual([run.rootItemId]);
 const root = (await f.service.item('source',run.rootItemId!)).item;
 const managementRef = `KBLC-${board.number}-${root.number}`;
 const [projected] = await runtime.service.recordExecutions!('source','decision',{includeManagementTasks:true});
 expect(projected.managementTasks?.[0]).toMatchObject({id:root.id,reference:managementRef});
 await completeCoordination(f,root.id);
 const [child] = (await f.service.query('source',{parentId:root.id,view:'all'})).items;
 const executionRef = `KBLT-${board.number}-${child.number}`;
 expect(await f.service.resolve(managementRef)).toMatchObject({itemId:root.id,reference:managementRef});
 expect(await f.service.resolve(executionRef)).toMatchObject({itemId:child.id,reference:executionRef});
 expect(await f.service.resolve(`KBT-${board.number}-${child.number}`)).toMatchObject({itemId:child.id,reference:executionRef});
 expect((await f.service.query('source',{search:executionRef,view:'all'})).items.map(item=>item.id)).toEqual([child.id]);
});
it('automatically isolates recurring work from a source board without AI collaboration',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture(null);
 await f.command({type:'review-record',recordId:'decision',accept:true});
 let clock=Date.now();
 const record=await f.service.record('source','decision');
 const config={state:'active' as const,firstAt:clock+60000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:record.revision,recurrence:config});
 const automation={enabled:true,autoAccept:false,planner:{system:'agent',id:'planner',revision:'1'},executor:{system:'agent',id:'worker',revision:'1'},
    coordinator:{kind:'service' as const,id:'planner'},worker:{kind:'service' as const,id:'worker'}};
 const recurringAutomation=vi.fn(async()=>automation);
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),recurringAutomation,log:f.log,now:()=>clock});
 cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();
 clock=config.firstAt;
 await runtime.service.scan();
 await runtime.service.scan();
 const [run]=await runtime.service.recordExecutions!('source','decision',{includeManagementTasks:true});
 const target=await f.service.read(run.boardId),source=await f.service.read('source');
 expect(source.automation).toBeUndefined();
 expect(source.items).toHaveLength(0);
 expect(target.scope).toEqual({kind:'collection',namespace:'recurring-run',id:run.id});
 expect(target.automation).toMatchObject(automation);
 expect(target.items.map(item=>item.id)).toEqual([run.rootItemId]);
 expect(run.managementTasks?.[0].reference).toMatch(/^KBLC-/);
 expect(recurringAutomation).toHaveBeenCalledTimes(1);
});
it('recovers a fenced intent after restart even if scheduling was paused',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const before=await f.service.record('source','decision'),config={state:'active' as const,firstAt:1000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});
 const configured=await f.service.record('source','decision');await f.command({type:'reserve-record-recurrence',recordId:'decision',configRevision:configured.recurrenceRevision!,scheduledAt:1000});
 const fenced=await f.service.record('source','decision');await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:fenced.revision,recurrence:{...config,state:'paused'}});
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log});cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(1);
 expect((await runtime.service.recordExecutions!('source','decision'))[0].id).toBe(fenced.recurrenceFence!.pending[0].id);
});
it('does not replay fixed slots missed while runtime was stopped',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const before=await f.service.record('source','decision'),config={state:'active' as const,firstAt:1000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});let clock=181000;
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log,now:()=>clock});cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(0);
 clock=241000;await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(1);
});
it('does not replay a backlog after a delayed scan',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});let clock=Date.now();
 const before=await f.service.record('source','decision'),config={state:'active' as const,firstAt:clock+60000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log,now:()=>clock});cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();clock+=300000;await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(0);
 clock+=60000;await runtime.service.scan();expect((await f.service.read('source')).items).toHaveLength(1);
});
it('enforces bounded concurrent rounds in runtime scans',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});let clock=Date.now();
 const before=await f.service.record('source','decision'),config={state:'active' as const,firstAt:clock+60000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:2};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log,now:()=>clock});cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();for(let i=0;i<3;i++){clock+=60000;await runtime.service.scan();}
 expect(await runtime.service.recordExecutions!('source','decision')).toHaveLength(2);
 expect((await f.service.record('source','decision')).recurrenceFence?.pending).toHaveLength(2);
});
it('waits for the settled round before starting the next after-settlement interval',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});let clock=Date.now();
 const before=await f.service.record('source','decision'),config={state:'active' as const,firstAt:clock+60000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'after-settlement' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log,now:()=>clock});cleanup.push(()=>runtime.service.quiesce());
 await runtime.service.scan();clock+=60000;await runtime.service.scan();
 const initial=(await runtime.service.recordExecutions!('source','decision'))[0];expect(initial.rootItemId).toBeDefined();expect((await runtime.service.record('source','decision')).recurrenceNextAt).toBeUndefined();
 await completeCoordination(f,initial.rootItemId!);clock=Date.now();await runtime.service.scan();await runtime.service.scan();
 const settled=await f.journal.run<any>('source',initial.id);expect(settled.state).toBe('completed');
 clock=settled.updatedAt+59999;await runtime.service.scan();expect(await runtime.service.recordExecutions!('source','decision')).toHaveLength(1);
 clock=settled.updatedAt+60001;await runtime.service.scan();expect((await runtime.service.recordExecutions!('source','decision'))).toHaveLength(2);
});
it('keeps more than 100 settled and archived recurring rounds addressable through cursor pages after reopening',async()=>{
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});let clock=Date.now();
 const before=await f.service.record('source','decision'),config={state:'active' as const,firstAt:clock+60000,timeZone:'UTC',cadence:{kind:'interval' as const,milliseconds:60000},trigger:'fixed' as const,maxConcurrency:1};
 await f.command({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config});
 const open=()=>assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log,now:()=>clock});
 const runtime=await open();cleanup.push(()=>runtime.service.quiesce());await runtime.service.scan();const ids:string[]=[];
 for(let i=0;i<101;i++){
  clock+=60000;await runtime.service.scan();const record=await f.service.record('source','decision'),reservation=record.recurrenceFence?.pending[0];expect(reservation,`round ${i}`).toBeDefined();
  const run=await f.journal.run<any>('source',reservation!.id);expect(run?.rootItemId).toBeDefined();ids.push(run.id);
  await completeCoordination(f,run.rootItemId);for(let retry=0;retry<4&&(await f.service.record('source','decision')).recurrenceFence?.pending.length;retry++)await runtime.service.scan();
  expect((await f.service.record('source','decision')).recurrenceFence?.pending).toHaveLength(0);
  await f.command({type:'archive-items',itemIds:[run.rootItemId],reason:'Retain completed round'});
 }
 expect((await f.service.record('source','decision')).itemIds).toHaveLength(0);
 await runtime.service.quiesce();const restored=await open();cleanup.push(()=>restored.service.quiesce());await restored.service.scan();
 const seen:string[]=[];let cursor:string|undefined;
 do{const page=await restored.service.recordExecutionPage!('source','decision',{limit:20,cursor});seen.push(...page.items.map(row=>row.id));cursor=page.nextCursor;}while(cursor);
 expect(seen).toHaveLength(101);expect(new Set(seen).size).toBe(101);expect(new Set(seen)).toEqual(new Set(ids));
 clock+=60000;await restored.service.scan();const pending=(await f.service.record('source','decision')).recurrenceFence!.pending[0];expect(pending).toBeDefined();
 const live=await f.journal.run<any>('source',pending.id),read=vi.spyOn(f.journal,'get');
 await restored.service.controlRecord!('source',{recordId:'decision',operationId:'cancel-after-history',action:'cancel'});
 expect((await f.journal.run<any>('source',live.id)).state).not.toBe('cancelled');
 await restored.service.quiesce();const recovered=await open();cleanup.push(()=>recovered.service.quiesce());
 await settleCancellation(f);await recovered.service.scan();
 expect((await f.journal.run<any>('source',live.id)).state).toBe('cancelled');
 expect((await f.service.record('source','decision')).status).toBe('cancelled');
 const restart={recordId:'decision',operationId:'restart-after-history',action:'restart' as const};
 await recovered.service.controlRecord!('source',restart);await settleCancellation(f);
 const restarted=await f.journal.get<any>('record-operation:restart-restart-after-history');expect(restarted?.id).toBeDefined();
 await recovered.service.controlRecord!('source',restart);expect((await f.journal.get<any>('record-operation:restart-restart-after-history'))?.id).toBe(restarted.id);
 expect(read.mock.calls.some(([key])=>key==='record-runs:source')).toBe(false);read.mockRestore();
},180000);

it('rejects unconfirmed/stale decisions and local project selection', async () => {
    const f = await fixture(), execution = f.open();
    await expect(execution.runRecord('source', {operationId: 'run', recordId: 'decision', expectedRevision: 1})).rejects.toMatchObject({code: 'DECISION_NOT_CONFIRMED'});
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    await expect(execution.runRecord('source', {operationId: 'run', recordId: 'decision', expectedRevision: 1})).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    await expect(validateRemoteReferences(f.projects, {externalRefs: [{system: 'nestos-remote-project', id: 'local'}]})).rejects.toMatchObject({code: 'REMOTE_PROJECT_REQUIRED'});
    expect(await execution.recordResources()).toHaveLength(2);
});

it('deduplicates concurrent runs and preserves remote bindings across reopening', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2}, execution = f.open();
    const [first, second] = await Promise.all([execution.runRecord('source', request), execution.runRecord('source', {...request, operationId: 'double-click'})]);
    expect(first.id).toBe(second.id);
    const board = await f.service.read(first.boardId);
    expect(first.boardId).toBe('source'); expect(board.items).toHaveLength(1); expect(board.automation).toMatchObject({enabled: true, autoAccept: false});
    expect(board.items.filter(item => first.itemIds!.includes(item.id)).flatMap(item => item.externalRefs!.filter(ref=>ref.system==='nestos-remote-project').map(ref=>ref.id))).toEqual(['one', 'two']);
    expect(first.rootItemId).toBe(first.itemIds![0]); expect(board.items.filter(item => item.planning?.parentId === first.rootItemId)).toHaveLength(0);
    await f.open().scan(); expect(await f.open().runRecord('source', request)).toMatchObject({id: first.id, boardId: first.boardId});
    expect((await f.service.catalog()).filter(board => board.scope.kind === 'collection')).toHaveLength(0);
    expect((await f.service.record('source', 'decision')).status).toBe('confirmed');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REQUIREMENT');
    await expect(execution.runRecord('source', {...request, expectedRevision: 9})).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
});

it('recovers a committed creation when the response is lost without creating duplicate items', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const original = f.service.execute.bind(f.service); let lost = false;
    vi.spyOn(f.service, 'execute').mockImplementation(async (id, request) => {
        const result = await original(id, request);
        if (request.command.type === 'create-item' && !lost) {lost = true; throw Object.assign(new Error('PRIVATE_REPLY'), {code: 'EIO'});}
        return result;
    });
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2};
    await expect(f.open().runRecord('source', request)).rejects.toMatchObject({code: 'EIO'});
    const run = await f.open().runRecord('source', request);
    expect((await f.service.read(run.boardId)).items).toHaveLength(1);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REPLY');
});

it('keeps one run after linking the decision advances its revision and does not duplicate a feature', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const first = await f.open().runRecord('source', {operationId: 'first', recordId: 'decision', expectedRevision: 2});
    const decision = await f.service.record('source', 'decision'); expect(decision.itemIds).toEqual(expect.arrayContaining(first.itemIds!));
    const request = {operationId: 'again', recordId: 'decision', expectedRevision: decision.revision};
    expect((await f.open().runRecord('source', request)).id).toBe(first.id);
    expect((await f.open().runRecord('source', request)).id).toBe(first.id);
    expect((await f.service.read('source')).items).toHaveLength(1);
    await expect(f.open().runRecord('source', {...request, operationId: 'separate', placement: 'new-board'})).rejects.toMatchObject({code: 'DECISION_EXECUTION_PLACEMENT_CONFLICT'});
});
it('requires explicitly resuming paused AI and only creates a board when selected', async () => {
    const f = await fixture(false); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2};
    await expect(f.open().runRecord('source', request)).rejects.toMatchObject({code: 'AUTOMATION_PAUSED'});
    expect((await f.service.read('source')).items).toHaveLength(0);
    const run = await f.open().runRecord('source', {...request, placement: 'new-board'});
    expect(run.boardId).not.toBe('source'); expect((await f.service.catalog())).toHaveLength(2);
    expect((await f.service.read('source')).automation?.enabled).toBe(false);
    expect((await f.service.read(run.boardId)).automation?.enabled).toBe(true);
});
it('creates a single task for one project and derives completion only from its own work', async () => {
    const f = await fixture();
    await f.command({type: 'append-record', record: {id: 'small', kind: 'decision', title: 'Cloze modes', content: 'Implement', rationale: 'Verified', itemIds: [], sources: [], externalRefs: [{system: 'nestos-remote-project', id: 'one'}]}});
    await f.command({type: 'review-record', recordId: 'small', accept: true});
    await f.command({type: 'create-item', item: {id: 'unrelated', title: 'Other', responsibility: 'Other', acceptance: 'Other'}});
    await f.command({type: 'block-item', itemId: 'unrelated', reason: 'Independent work'});
    const run = await f.open().runRecord('source', {operationId: 'small', recordId: 'small', expectedRevision: 2});
    expect(run.itemIds).toHaveLength(1); expect(run.rootItemId).toBe(run.itemIds![0]); expect(run.state).toBe('running');
    expect((await f.service.item('source',run.rootItemId!)).item.taskType).toBe('coordination');
    await completeCoordination(f,run.rootItemId!);
    await f.open().scan();
    expect((await f.open().recordExecutions('source', 'small'))[0].state).toBe('completed');
    const completed=await f.service.record('source','small');
    await expect(f.open().runRecord('source',{operationId:'after-completed',recordId:'small',expectedRevision:completed.revision})).rejects.toMatchObject({code:'DECISION_EXECUTION_COMPLETED'});
    expect((await f.service.read('source')).items.find(item => item.id === 'unrelated')?.blocked).toBeDefined();
});
it('creates one coordination group for all projects and settles the decision from that group',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const run=await f.open().runRecord('source',{operationId:'projects',recordId:'decision',expectedRevision:2});
 expect(run.rootItemId).toBe(run.itemIds![0]);expect(run.itemIds).toHaveLength(1);
 expect((await f.service.item('source',run.rootItemId!)).item.externalRefs).toEqual(expect.arrayContaining(['one','two'].map(id=>({system:'nestos-remote-project',id}))));
 const children=['one','two'].map(project=>({id:'execute-'+project,project}));
 for(const child of children)await f.command({type:'create-item',item:{id:child.id,title:child.project,responsibility:'Implement',acceptance:'Verified',externalRefs:[{system:'nestos-remote-project',id:child.project}]},planning:{kind:'task',parentId:run.rootItemId!,priority:2,dependencies:[],references:[]}});
 await f.command({type:'finish-planning',itemId:run.rootItemId!});
 for(const child of children){
  await f.command({type:'set-stage',itemId:child.id,stage:'open'});
  const claimed=await f.command({type:'claim',itemId:child.id});await f.command({type:'submit',itemId:child.id,token:claimed.items.find(item=>item.id===child.id)!.owner!.token,resultRef:'verified'});
  await f.command({type:'review',itemId:child.id,accept:true});await f.open().scan();
  expect((await f.open().recordExecutions('source','decision'))[0].state).not.toBe('completed');
 }
 await f.command({type:'close-plan',itemId:run.rootItemId!,resultRef:'children-verified'});
 await f.open().scan();expect((await f.open().recordExecutions('source','decision'))[0].state).toBe('completed');
 expect((await f.service.record('source','decision')).status).toBe('confirmed');
});

it('resumes legacy dedicated boards in place without introducing parent items or moving identities', async () => {
    const f = await fixture(false); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const record = await f.service.record('source', 'decision'), source = await f.service.read('source');
    const legacy = {id: 'legacy', sourceBoardId: 'source', recordId: 'decision', recordRevision: 2, boardId: 'run-legacy', state: 'preparing',
        createdAt: 1, updatedAt: 1, record, automation: source.automation};
    await f.journal.update('record-runs:source', () => [legacy]);
    await f.journal.update('record-operation:legacy-click', () => legacy);
    await f.open().scan();
    const run = await f.open().runRecord('source', {operationId: 'legacy-click', recordId: 'decision', expectedRevision: 2});
    expect(run.boardId).toBe('run-legacy'); expect(run.rootItemId).toBeUndefined();
    expect((await f.service.read(run.boardId)).items.map(item => item.id)).toEqual(['work-0', 'work-1']);
    expect((await f.service.read('source')).items).toHaveLength(0);
    await f.open().scan(); expect((await f.service.read(run.boardId)).items).toHaveLength(2);
});
it('marks only the affected decision run failed when a task is cancelled', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const run = await f.open().runRecord('source', {operationId: 'cancelled', recordId: 'decision', expectedRevision: 2});
    await f.command({type: 'cancel-item', itemId: run.itemIds![0], reason: 'User choice'}); await f.open().scan();
    expect((await f.open().recordExecutions('source', 'decision'))[0]).toMatchObject({state: 'failed', code: 'DECISION_TASK_CANCELLED'});
    expect((await f.service.read('source')).items).toHaveLength(1);
});

it('uses configured work type ranks instead of requiring feature/task identifiers', async () => {
    const f = await fixture(true, [{id: 'bundle', label: 'Delivery', rank: 5, executable: false}, {id: 'action', label: 'Work', rank: 9, executable: true}]);
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const run = await f.open().runRecord('source', {operationId: 'custom', recordId: 'decision', expectedRevision: 2, placement: 'new-board'});
    const board = await f.service.read(run.boardId);
    expect(run.rootItemId).toBe(run.itemIds![0]);
    expect(board.items.filter(item => run.itemIds!.includes(item.id)).every(item => item.planning?.kind === 'bundle' && item.taskType==='coordination')).toBe(true);
    await f.open().scan(); expect((await f.service.read(run.boardId)).items).toHaveLength(1);
});

it('provides a single resource selector that inherits and locks the parent project',async()=>{
    const f=await fixture(),reference={system:'nestos-remote-project',id:'one'};
    await f.command({type:'create-item',item:{id:'parent',title:'Parent',responsibility:'Work',acceptance:'Verified',externalRefs:[reference]}});
    expect(await f.open().itemResources('source','parent')).toMatchObject({selected:reference,required:true,readonly:true,resources:[
        {reference:{system:'nestos-remote-project',id:'one'}}]});
});
it('quiesces at a committed decision boundary and reopens with the same run and items', async () => {
    const f = await fixture(), first = f.open();
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {recordId: 'decision', operationId: 'safe-restart', expectedRevision: (await f.service.record('source', 'decision')).revision};
    const before = await first.runRecord('source', request);
    await first.quiesce(); await expect(first.runRecord('source', request)).rejects.toMatchObject({code: 'SERVICE_STOPPING'});
    const after = await f.open().runRecord('source', request);
    expect(after.id).toBe(before.id); expect(after.itemIds).toEqual(before.itemIds);
    expect((await f.service.read('source')).items.map(row => row.id)).toEqual(expect.arrayContaining(before.itemIds!));
    expect(after.updatedAt).toBe(before.updatedAt);
    const receipt = await f.journal.get<Record<string, unknown>>('record-operation:safe-restart');
    expect(receipt).toMatchObject({schema: 2, id: before.id, sourceBoardId: 'source'});
    expect(receipt).not.toHaveProperty('state'); expect(receipt).not.toHaveProperty('record');
});

it('cancels all decision descendants, resumes cancellation after restart and permits logical record deletion',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const run=await f.open().runRecord('source',{operationId:'run',recordId:'decision',expectedRevision:2});
    await f.open().controlRecord('source',{recordId:'decision',operationId:'cancel-decision',action:'cancel'});
    const board=await f.service.read('source');expect(board.items.every(item=>item.control?.action==='cancel')).toBe(true);
    const {scanTaskControls}=await import('@nestos/kanban/integration');
    for(let pass=0;pass<3;pass++)await scanTaskControls(kanbanControlOptions({calls:{list:async()=>[]}},f.journal),f.journal,await f.service.read('source'),f.service);
    await f.open().scan();
    expect((await f.service.read('source')).items.every(item=>item.status==='cancelled')).toBe(true);
    expect(await f.service.record('source','decision')).toMatchObject({status:'cancelled'});
    expect((await f.open().recordExecutions('source','decision')).find(row=>row.id===run.id)?.state).toBe('cancelled');
    await f.command({type:'delete-record',recordId:'decision'});
    expect((await f.service.records('source',{kind:'decision'})).items).toEqual([]);
    expect((await f.service.record('source','decision')).deletedAt).toBeTypeOf('number');
});
it('cancels a decision with no execution without materializing work or contacting project resources',async()=>{
    const f=await fixture();
    await f.open().controlRecord('source',{recordId:'decision',operationId:'cancel-draft',action:'cancel'});
    expect((await f.service.read('source')).items).toEqual([]);
    expect(await f.service.record('source','decision')).toMatchObject({status:'cancelled'});
});
it('projects unresolved planning clarification as a blocked decision and clears it only after the status changes',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});const execution=f.open();
    const run=await execution.runRecord('source',{operationId:'clarification-run',recordId:'decision',expectedRevision:2});
    const itemId=run.itemIds![0];
    await f.command({type:'report-analysis',itemId,operationId:'analysis',status:{itemId,state:'clarification',reason:'Please confirm the scope'}});
    await execution.scan();expect(await execution.recordExecutions('source','decision')).toContainEqual(expect.objectContaining({state:'blocked',code:'DECISION_INPUT_REQUIRED'}));
    expect(Object.values((await f.service.workflow('source')).dispatches)).toHaveLength(0);
    await f.command({type:'report-analysis',itemId,operationId:'clarified',status:{itemId,state:'ready',reason:'Confirmed'}});
    await execution.scan();const resumed=(await execution.recordExecutions('source','decision'))[0];expect(resumed.state).toBe('running');expect(resumed.code).toBeUndefined();
});

async function settleCancellation(f:Awaited<ReturnType<typeof fixture>>) {
    const {scanTaskControls}=await import('@nestos/kanban/integration');
    for(let pass=0;pass<3;pass++)await scanTaskControls(kanbanControlOptions({calls:{list:async()=>[]}},f.journal),f.journal,await f.service.read('source'),f.service);
    await f.open().scan();
}
it('rejects archiving active decisions, preserves settled tasks and keeps deletion separate',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const run=await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    await f.command({type:'create-item',item:{id:'unrelated',title:'Unrelated',responsibility:'Keep',acceptance:'Keep'}});
    await expect(f.open().controlRecord('source',{recordId:'decision',operationId:'archive-active',action:'archive'})).rejects.toMatchObject({code:'RECORD_EXECUTION_UNSETTLED'});
    await f.open().controlRecord('source',{recordId:'decision',operationId:'cancel-before-archive',action:'cancel'});await settleCancellation(f);
    const retained=await f.service.read('source');
    await f.open().controlRecord('source',{recordId:'decision',operationId:'archive',action:'archive'});
    expect((await f.service.record('source','decision')).archivedAt).toBeTypeOf('number');
    expect((await f.service.records('source')).items).toHaveLength(0);
    expect((await f.service.query('source',{view:'archive'})).total).toBe(0);
    expect((await f.service.read('source')).items).toEqual(retained.items);
    await f.open().controlRecord('source',{recordId:'decision',operationId:'delete',action:'delete'});await f.open().scan();
    expect((await f.service.record('source','decision')).deletedAt).toBeTypeOf('number');
    await f.open().controlRecord('source',{recordId:'decision',operationId:'delete',action:'delete'});
    for(const id of run.itemIds!)expect((await f.service.item('source',id)).item.deletedAt).toBeTypeOf('number');
    expect((await f.service.item('source','unrelated')).item.deletedAt).toBeUndefined();
});
it('restarts a decision after settlement with a new run and retains replay identity across reopening',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const old=await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    const request={recordId:'decision',operationId:'restart',action:'restart' as const};
    await f.open().controlRecord('source',request);await settleCancellation(f);
    const runs=await f.open().recordExecutions('source','decision');
    expect(runs).toHaveLength(2);expect(runs[0]).toMatchObject({id:old.id,state:'cancelled'});
    expect(runs[1].id).not.toBe(old.id);expect(runs[1].state).toBe('running');
    expect((await f.service.record('source','decision')).status).toBe('confirmed');
    await f.open().controlRecord('source',request);await f.open().scan();
    expect(await f.open().recordExecutions('source','decision')).toHaveLength(2);
    expect((await f.service.query('source',{view:'archive'})).total).toBe(1);
});
it('keeps decision deletion pending when task cancellation has no confirmed receipt',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    await f.open().controlRecord('source',{recordId:'decision',operationId:'delete',action:'delete'});
    for(const item of (await f.service.read('source')).items)await f.command({type:'control-receipt',itemId:item.id,controlId:item.control!.id,state:'unknown',code:'CONNECTION_LOST'});
    await f.open().scan();
    const record=await f.service.record('source','decision');expect(record.status).toBe('cancelling');expect(record.deletedAt).toBeUndefined();
    expect((await f.service.read('source')).items.every(item=>item.deletedAt===undefined)).toBe(true);
});
it('keeps unclarified decision planning out of development lists and counts attention once per decision',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const run=await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    expect((await f.service.query('source',{view:'all',excludePlanning:true})).total).toBe(0);
    for(const itemId of run.itemIds!)await f.command({type:'report-analysis',itemId,operationId:'clarify-'+itemId,status:{itemId,state:'clarification',reason:'Confirm scope'}});
    expect((await f.service.overview('source')).attention).toMatchObject({decision:1,board:0,log:0});
    expect((await f.service.records('source',{kind:'decision'})).items[0].attention).toBe('waiting-input');
    expect((await f.service.catalog())[0].attention?.decision).toBe(1);
});

it('recovers restart finalization after new run creation changed the live decision revision',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
 await f.open().controlRecord('source',{recordId:'decision',operationId:'restart-receipt',action:'restart'});await settleCancellation(f);
 const controls=await f.journal.find<any>('record-control:',row=>row.operationId==='restart-receipt');
 await f.journal.update(controls[0].key,old=>({...old as any,settled:false}));
 await f.open().scan();expect(await f.open().recordExecutions('source','decision')).toHaveLength(2);
 expect((await f.journal.get<any>(controls[0].key)).settled).toBe(true);
});

it('reports automatically created coordination work as blocked with its exact planning failure instead of running',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});const execution=f.open();
 const run=await execution.runRecord('source',{operationId:'auto',recordId:'decision',expectedRevision:2});
 expect(run.itemIds).toHaveLength(1);const root=run.itemIds![0],before=(await f.service.read('source')).items.length;
 await f.command({type:'report-analysis',itemId:root,operationId:'preparation',status:{itemId:root,state:'failed',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED'}});
 await execution.scan();expect((await execution.recordExecutions('source','decision'))[0]).toMatchObject({state:'blocked',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED',stage:'planning'});
 expect((await f.service.records('source',{kind:'decision'})).items[0]).toMatchObject({attention:'error',attentionCode:'GIT_RELATIVE_WORKTREES_UNSUPPORTED',attentionItemId:root});
 await execution.scan();expect((await f.service.read('source')).items).toHaveLength(before);
});
it('cancels from the decision protocol and keeps unknown execution receipts pending across recovery',async()=>{
 const {resolveDecisionRequest}=await import('../src/kanban/decision-conversation-requests'),{decisionConversationViews}=await import('../src/kanban/decision-conversation-views');
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const runtime=f.open(),run=await runtime.runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
 await f.journal.update('decision-conversation-record:conversation',()=>({recordId:'decision',state:'confirmed',proposalDigest:'preview'}));
 const read=vi.fn(async()=>({messages:[{id:'cancel',role:'user',text:'取消决策'}]}));
 const options={...f,client:()=>({...f.service,...runtime}),remote:{projectConversation:async()=>({read,close:async()=>{}})}} as any;
 const conversation={id:'conversation',boardId:'source',sessionId:'original',resourceId:'/native/original',binding:{projectId:'one',profileId:'codex'}} as any;
 const request={id:'cancel',scopeId:'conversation',method:'decision.cancel',params:{}};
 expect(await resolveDecisionRequest(options,conversation,request)).toMatchObject({state:'cancelling',recordId:'decision',retainedSession:true});
 for(const item of (await f.service.read('source')).items)await f.command({type:'control-receipt',itemId:item.id,controlId:item.control!.id,state:'unknown',code:'CONNECTION_LOST'});
 await runtime.quiesce();const recovered=f.open();options.client=()=>({...f.service,...recovered});await recovered.scan();
 expect(await resolveDecisionRequest(options,conversation,{...request,id:'inspect',method:'decision.read'})).toMatchObject({state:'cancelling',record:{status:'cancelling'}});
 expect((await decisionConversationViews(options,[{...conversation,state:'confirmed',createdAt:1,recordId:'decision'}]))[0].state).toBe('cancelling');
 for(const item of (await f.service.read('source')).items)await f.command({type:'control-receipt',itemId:item.id,controlId:item.control!.id,state:'cancelled'});
 await recovered.scan();expect(await resolveDecisionRequest(options,conversation,{...request,id:'settled',method:'decision.read'})).toMatchObject({state:'cancelled',record:{status:'cancelled'}});
 expect((await recovered.recordExecutions('source','decision')).find(row=>row.id===run.id)?.state).toBe('cancelled');
 expect((await f.service.read('source')).items).toHaveLength(1);expect((await f.service.read('source')).items.every(item=>item.status==='cancelled')).toBe(true);
});

it('settles a legacy review run from completed task groups without applying a second delivery gate',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration');
 const deliveryReady=vi.fn(async()=>false);
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),extensions:()=>[{deliveryReady,scan:async()=>{}}],log:f.log});
 cleanup.push(()=>runtime.service.quiesce());
 const run=await runtime.service.runRecord!('source',{operationId:'legacy-group',recordId:'decision',expectedRevision:2});
 for(const itemId of run.itemIds??[run.rootItemId!])await completeCoordination(f,itemId);
 await f.journal.update<any[]>('record-runs:source',old=>old!.map(row=>({...row,state:'review'})));
 await runtime.service.scan();
 expect((await runtime.service.recordExecutions!('source','decision'))[0]).toMatchObject({state:'completed'});
 expect(deliveryReady).not.toHaveBeenCalled();
 expect((await runtime.service.records('source',{kind:'decision'})).items[0].progress?.state).toBe('completed');
});
it('routes attention dismissal through the runtime without cancelling or recreating the failed task group',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const {assembleKanbanRuntime}=await import('@nestos/kanban/integration'),{recordAttentionFingerprint}=await import('@nestos/kanban/contracts');
 const runtime=await assembleKanbanRuntime({fs:f.fs,journal:f.journal,actor:{kind:'human',id:'admin'},authorize:async()=>{},resources:projectResourceCatalog(f.projects),log:f.log});cleanup.push(()=>runtime.service.quiesce());
 const run=await runtime.service.runRecord!('source',{operationId:'dismiss-run',recordId:'decision',expectedRevision:2});
 await f.command({type:'report-analysis',itemId:run.rootItemId!,operationId:'failed',status:{itemId:run.rootItemId!,state:'failed',code:'MISSING_STATE'}});
 const before=await runtime.service.read('source'),record=(await runtime.service.records('source',{kind:'decision'})).items[0];
 const fingerprint=recordAttentionFingerprint(record);
 await runtime.service.controlRecord!('source',{recordId:'decision',operationId:'dismiss-attention',action:'dismiss-attention',attentionFingerprint:fingerprint});
 expect((await runtime.service.records('source',{kind:'decision'})).items[0]).toMatchObject({progress:{state:'failed'},attentionDismissal:{fingerprint}});
 const after=await runtime.service.read('source');expect(after.items).toEqual(before.items);
 expect(await runtime.service.recordExecutions!('source','decision')).toHaveLength(1);
});

it('inherits the optional decision priority when materializing its management task',async()=>{
    const f=await fixture();await f.command({type:'set-record-priority',recordId:'decision',priority:0});
    await f.command({type:'review-record',recordId:'decision',accept:true});
    const record=await f.service.record('source','decision');
    const run=await f.open().runRecord('source',{operationId:'priority-run',recordId:'decision',expectedRevision:record.revision});
    expect((await f.service.item(run.boardId,run.rootItemId!)).item).toMatchObject({taskType:'coordination',planning:{priority:0}});
});

it('edits delivery after materialization, resolves it from the management task, and never creates another run on retry',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const original=await f.open().runRecord('source',{operationId:'first',recordId:'decision',expectedRevision:2});
 const before=await f.service.record('source','decision');await f.command({type:'configure-record-delivery',recordId:'decision',expectedRecordRevision:before.revision,verificationLevel:'none',deliveryMode:'source'});
 const current=await f.service.record('source','decision'),request={operationId:'after-settings',recordId:'decision',expectedRevision:current.revision};
 expect((await f.open().runRecord('source',request)).id).toBe(original.id);expect((await f.open().runRecord('source',request)).id).toBe(original.id);
 expect((await f.service.read('source')).items).toHaveLength(1);
 expect(await f.open().recordDelivery('source',original.itemIds![0])).toMatchObject({boardId:'source',recordId:'decision',mode:'source',editable:true});
 const saved=await f.journal.run<{record:{deliveryOptions?:unknown}}>('source',original.id);expect(saved?.record.deliveryOptions).toBeUndefined();
});
it('keeps a confirmed dependent decision entirely unmaterialized until its prerequisite completes',async()=>{
 const f=await fixture(),api=f.open();await f.command({type:'review-record',recordId:'decision',accept:true});
 const upstream=await api.runRecord('source',{operationId:'upstream',recordId:'decision',expectedRevision:(await f.service.record('source','decision')).revision});
 await f.command({type:'append-record',record:{id:'dependent',kind:'decision',title:'Client',content:'Client scope',rationale:'Verified',itemIds:[],sources:[],externalRefs:[{system:'nestos-remote-project',id:'one'}],dependsOn:[{boardId:'source',recordId:'decision',title:'Goal'}]}});
 await f.command({type:'review-record',recordId:'dependent',accept:true});
 const waiting=await api.runRecord('source',{operationId:'dependent-run',recordId:'dependent',expectedRevision:(await f.service.record('source','dependent')).revision});
 expect(waiting).toMatchObject({state:'blocked',code:'DECISION_DEPENDENCY_WAITING',dependencies:[{recordId:'decision',state:'waiting'}]});
 expect(waiting.rootItemId).toBeUndefined();expect((await f.service.read('source')).items).toHaveLength(1);expect((await f.service.record('source','dependent')).itemIds).toEqual([]);
 await api.scan();expect((await f.service.read('source')).items.some(row=>row.id===waiting.rootItemId)).toBe(false);
 await completeCoordination(f,upstream.rootItemId!);await api.scan();
 const resumed=(await api.recordExecutions('source','dependent'))[0];expect(resumed.id).toBe(waiting.id);expect(resumed.code).toBeUndefined();
 expect(resumed.rootItemId).toBeDefined();expect((await f.service.read('source')).items.some(row=>row.id===resumed.rootItemId)).toBe(true);await api.quiesce();
});
it('cancels a dependency wait without creating any management work or Session',async()=>{
 const f=await fixture(),api=f.open();await f.command({type:'review-record',recordId:'decision',accept:true});
 await f.command({type:'append-record',record:{id:'waiting',kind:'decision',title:'Wait',content:'Scope',rationale:'Check',itemIds:[],sources:[],externalRefs:[{system:'nestos-remote-project',id:'one'}],dependsOn:[{boardId:'source',recordId:'decision'}]}});await f.command({type:'review-record',recordId:'waiting',accept:true});
 const run=await api.runRecord('source',{operationId:'wait',recordId:'waiting',expectedRevision:(await f.service.record('source','waiting')).revision});
 await api.controlRecord('source',{operationId:'cancel-wait',recordId:'waiting',action:'cancel',expectedRevision:(await f.service.record('source','waiting')).revision});
 expect((await f.service.record('source','waiting')).status).toBe('cancelled');expect((await f.service.read('source')).items.some(row=>row.id===run.rootItemId)).toBe(false);await api.quiesce();
});
