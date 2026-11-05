import {kanbanControlOptions} from '../src/kanban/control-adapter';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {drainBoardAnalyses} from '@nestos/kanban/integration';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(phase:'prepared'|'submitting') {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'), kanbanJournalOptions);await journal.open();
    await journal.update('analysis:job',()=>({id:'original',phase,status:{itemId:'task',state:'analyzing'},input:{request:{expectedSessionId:'original',submission:{id:'original'}}}}));
    await journal.update('analysis-history:'+JSON.stringify(['b','task']),()=>({keys:['analysis:job'],indexed:true}));
    const board={id:'b',lifecycle:{operationId:'stop',intent:'delete',mode:'drain',phase:'waiting'},items:[{id:'task',status:'backlog',analysis:{state:'analyzing'}}]};
    const calls={list:vi.fn(async()=>[{input:{request:{submission:{id:'original'}}},callerState:{settled:false},executionTree:{settled:false}}])};
    const service={read:vi.fn(async()=>({id:'b',revision:1})),execute:vi.fn(async()=>({id:'b'}))};
    return {journal,board,calls,service,drain:()=>drainBoardAnalyses(kanbanControlOptions({calls:calls as never},journal),journal,board as never,service as never)};
}
it('drains an accepted analysis without adopting a new plan or issuing a cancellation',async()=>{
    const f=await fixture('submitting');await f.drain();
    expect(await f.journal.get('analysis:job')).toMatchObject({phase:'submitting'});expect(f.service.execute).not.toHaveBeenCalled();
    f.calls.list.mockResolvedValue([{input:{request:{submission:{id:'original'}}},callerState:{settled:true},executionTree:{settled:true},executionState:{exitStatus:'succeeded'}}] as never);
    await f.drain();
    expect(await f.journal.get('analysis:job')).toMatchObject({phase:'settled',terminalOutcome:'succeeded',status:{code:'BOARD_STOPPED_AFTER_ANALYSIS'}});
    expect(f.service.execute).toHaveBeenCalledWith('b',expect.objectContaining({command:expect.objectContaining({type:'report-analysis'})}));
    expect(f.service.execute).toHaveBeenCalledOnce();
});
it('atomically closes a never-submitted analysis without starting or probing a Session',async()=>{
    const f=await fixture('prepared');await f.drain();
    expect(await f.journal.get('analysis:job')).toMatchObject({phase:'settled',terminalOutcome:'cancelled'});
    expect(await f.journal.claim('analysis:job')).toBe(false);expect(f.calls.list).not.toHaveBeenCalled();
});
