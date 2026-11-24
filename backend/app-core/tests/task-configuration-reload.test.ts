import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {readPrompt} from '../src/run/prompt-bundle';
import {ensureKanbanConfiguration} from '../src/presets/kanban-global-configuration';
import {reloadTaskConfiguration,taskConfigurationStatus} from '../src/kanban/task-configuration-reload';
import type {TaskRecoveryOptions} from '../src/kanban/task-recovery-ports';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

it.each(['coordination','execution'])('publishes current configuration and notifies the existing %s session once',async taskType=>{
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});
    cleanup.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs);
    await journal.open();
    await ensureKanbanConfiguration(fs);
    const configPath='/etc/kanban/development/report-packaging.md';
    await fs.driver.writeContent(configPath,'Current report guidance');
    const session={sessionId:'canonical',resourceId:'/folder:cx1/@harness/codex/native'};
    const item={id:'task',taskType,externalRefs:[{system:'nestos-remote-project',id:'project'}]};
    const service={item:async()=>({item}),planningSession:async()=>({...session,analysisId:'original'}),
        executionSession:async()=>({current:session}),workflow:async()=>({dispatches:{original:{id:'original',itemId:'task',executionSessionId:'canonical'}}})};
    await journal.update('development-workspace:original',()=>({projectId:'project',directory:'/workspace/task',policy:{profile:'development'}}));
    const enqueue=vi.fn(),close=vi.fn(),read=vi.fn(),projectConversation=vi.fn(async()=>({enqueue,close,read}));
    const options={fs,journal,service,client:()=>service,remote:{projectConversation},projects:{get:async()=>({path:'/project'}),
        openWorkspace:async()=>({fs,dispose:async()=>{}})},log:vi.fn()} as unknown as TaskRecoveryOptions;
    const reload=reloadTaskConfiguration(options),request={itemId:'task',sessionId:'canonical',operationId:'reload'};
    const result=await reload('board',request);
    expect(await readPrompt(fs,'/workspace/task/_nestos/kanban/config-reloads/reload/prompts/report-packaging.md')).toBe('Current report guidance');
    expect(projectConversation).toHaveBeenCalledExactlyOnceWith('project','codex','native');
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(result.revision),[],undefined,expect.stringMatching(/^configuration-/),'next-turn');
    const queueId=enqueue.mock.calls[0][3];
    read.mockResolvedValue({instructionQueue:{submissions:[{id:queueId,turnId:'matching-turn'}]},
        messages:[{role:'assistant',turnId:'other-turn',text:'CONFIGURATION_READ '+result.revision}]});
    expect(await taskConfigurationStatus(options,'board','task')).toMatchObject({state:'dispatched'});
    read.mockResolvedValue({instructionQueue:{submissions:[{id:queueId,turnId:'matching-turn'}]},
        messages:[{role:'assistant',turnId:'matching-turn',text:'CONFIGURATION_READ '+result.revision}]});
    const confirmed=await taskConfigurationStatus(options,'board','task');
    expect(confirmed).toMatchObject({state:'read',readRevision:confirmed.currentRevision});
    await fs.driver.writeContent(configPath,'Another version');
    expect(await reload('board',request)).toEqual(result);
    const changed=await taskConfigurationStatus(options,'board','task');
    expect(changed.currentRevision).not.toBe(changed.readRevision);
    expect(enqueue).toHaveBeenCalledTimes(1);
    await expect(reload('board',{...request,sessionId:'other'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(reload('board',{...request,operationId:'stale',sessionId:'old'})).rejects.toMatchObject({code:'TASK_CONFIGURATION_SESSION_CHANGED'});
});
