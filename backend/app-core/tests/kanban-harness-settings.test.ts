import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanBoard} from '@nestos/kanban/contracts';
import type {HarnessProfile} from '@nestos/cells-driver';
import {kanbanHarnessSettings,selectKanbanHarness,freezeKanbanHarness} from '../src/presets/kanban-harness-settings';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function profile(id:string,ready=true):HarnessProfile{return {id,kind:id,projectRuntime:true,workspaces:[{id:'workspace'}],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true,sessionChannels:ready,workingDirectory:ready}};}
it('selects the explicitly configured profile and rejects unsupported profiles without falling back',()=>{
    const profiles=[profile('default'),profile('chosen'),profile('dsh',false)];
    expect(selectKanbanHarness(profiles,'workspace','chosen').id).toBe('chosen');expect(selectKanbanHarness(profiles,'workspace').id).toBe('default');
    expect(()=>selectKanbanHarness(profiles,'workspace','missing')).toThrow();expect(()=>selectKanbanHarness(profiles,'workspace','dsh')).toThrow();
});
it('exposes three board-specific fields with a default and disabled capability-missing choices',async()=>{
    const close=vi.fn(async()=>{}),remote={mountedProjectIds:()=>['p'],list:()=>[{at:'/',connectionId:'node'}],projectHarness:async()=>({profiles:async()=>({profiles:[profile('codex'),profile('dsh',false)]}),close})} as never;
    const settings=kanbanHarnessSettings(remote),board={settings:{'harness-decision':'codex'}} as KanbanBoard;const catalog=await settings.catalog(board);
    expect(catalog.fields.map(field=>field.name)).toEqual(['harness-decision','harness-coordination','harness-execution']);
    expect(catalog.fields[0].choices).toContainEqual(expect.objectContaining({value:'dsh',disabled:true}));
    await expect(settings.validate(board,{'harness-execution':'dsh'})).rejects.toMatchObject({code:'KANBAN_HARNESS_UNAVAILABLE'});
    await settings.validate(board,{'harness-execution':'codex'});await settings.validate(board,{});expect(close).toHaveBeenCalled();
});
it('freezes the chosen profile once per operation and preserves it when board defaults change',async()=>{
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});cleanup.push(()=>manager.dispose());const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
    expect(await freezeKanbanHarness(journal,'operation','board','execution','codex')).toBe('codex');
    expect(await freezeKanbanHarness(journal,'operation','board','execution','another')).toBe('codex');
    await expect(freezeKanbanHarness(journal,'operation','other','execution','codex')).rejects.toMatchObject({code:'KANBAN_HARNESS_BINDING_CHANGED'});
});

it.each(['decision','coordination'] as const)('uses the board %s profile in real conversation preparation and freezes it before retry',async role=>{
    const {decisionConversationTransport}=await import('../src/kanban/decision-conversation-transport');
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});cleanup.push(()=>manager.dispose());const fs=await manager.openFileSystem('/');
    const journal=new KanbanAutomationJournal(fs);await journal.open();if(role==='coordination')await journal.update('record-coordination-scope:operation',()=>({recordId:'decision'}));
    const board={id:'board',settings:{['harness-'+role]:'chosen'}};
    const close=vi.fn(async()=>{}),channel=vi.fn(async()=>({projectContext:{projects:[{projectId:'workspace',revision:1,directory:'/workspace'}]}}));
    const options={fs,journal,service:{read:async()=>board,record:async()=>({kind:'decision',status:'confirmed'})},projects:{get:async()=>({path:'/project',project:{id:'project',source:{kind:'remote'}}}),openWorkspace:async()=>({fs,dispose:async()=>{}})},
        remote:{projectHarness:async()=>({profiles:async()=>({epoch:'epoch',profiles:[profile('default'),profile('chosen')]}),close}),sessionChannel:channel,
            list:()=>[{at:'/',serverId:'cell',serverProjectId:'workspace',serverProjectRevision:1,authorization:{principalId:'owner',revision:'auth'}}]},log:vi.fn()} as never;
    const transport=decisionConversationTransport(options,async()=>{}),resources=[{system:'nestos-remote-project',id:'project'}];
    const first=await transport.prepare('operation','board',resources,resources[0]);expect(first).toMatchObject({profileId:'chosen',...(role==='coordination'?{purpose:'coordination'}:{})});
    board.settings['harness-'+role]='missing';expect(await transport.prepare('operation','board',resources,resources[0])).toMatchObject({profileId:'chosen'});expect(close).toHaveBeenCalledTimes(2);
});
