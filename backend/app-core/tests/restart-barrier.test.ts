import {expect,it,vi} from 'vitest';
import type {KanbanClient,KanbanExecutionSessionDetail} from '@nestos/kanban/contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {nativeRestartIdle,restartBarrier} from '../src/kanban/restart-barrier';

const resourceId='/folder:cx1/@harness/codex/native';
const row={sessionId:'local-binding',state:'unknown',stale:true,recent:false} as const;
it('probes the exact current native session when its related row has no resource route',async()=>{
    const state:KanbanExecutionSessionDetail={history:[],current:{...row,resourceId},sessions:[{...row,current:true,purposes:['execution'],executions:[]}]};
    const service={executionSession:vi.fn(async()=>state),workResources:vi.fn(async()=>[])} as unknown as KanbanClient;
    const idle=vi.fn(async()=>true);
    await expect(restartBarrier(()=>service,idle)('board',['item'])).resolves.toBeUndefined();
    expect(idle).toHaveBeenCalledExactlyOnceWith(resourceId);
    idle.mockResolvedValue(false);
    await expect(restartBarrier(()=>service,idle)('board',['item'])).rejects.toMatchObject({code:'RESTART_SESSION_NOT_IDLE'});
    expect(service.workResources).toHaveBeenCalledOnce();
});

it('requires a fresh, idle, read-only native observation with an empty durable queue',async()=>{
    const close=vi.fn(async()=>{});
    const snapshot={sessionId:'native',active:false,pending:false,requests:[],instructionQueue:{items:[] as unknown[]},
        observation:{execution:'idle',connection:'online',stale:false,receiptUnknown:false,activeTurnId:null}};
    const read=vi.fn(async()=>snapshot);
    const projectConversation=vi.fn(async()=>({read,close}));
    const projects={forFolder:vi.fn(async()=>({path:'/cx1',project:{id:'cx1'}})),remoteMounts:{projectConversation}} as unknown as ProjectService;
    const verify=nativeRestartIdle(projects);
    expect(await verify(resourceId)).toBe(true);
    expect(projectConversation).toHaveBeenCalledWith('cx1','codex','native',{timeoutMs:3000},true);
    expect(read).toHaveBeenCalledWith({includeUsage:false});
    snapshot.instructionQueue.items.push({state:'pending'});
    expect(await verify(resourceId)).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
});
