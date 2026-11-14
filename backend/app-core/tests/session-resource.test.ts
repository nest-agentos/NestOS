import {expect,it,vi} from 'vitest';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {ProjectRemoteMountService} from '../src/projects/remote-mounts';
import {nativeSessionResource} from '../src/projects/session-resource';
import {HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {durableState,request} from './harness-execution-fixture';
import {context,operation} from './harness-context-fixture';
async function fixture(){
    const f=durableState(),store=new HarnessContextBindings(f.state,'s');
    const add=async(id:string)=>{
        await store.claim(id,context,request.connection,operation);
        await store.attach(id,operation.operationId,{nodeConnectionId:'node',profileId:'codex',workspaceId:'workspace',epoch:'epoch',sessionId:'native-'+id});
        const staged=await store.prepareSettlement(id,operation.operationId,{operationId:operation.operationId,kind:'terminal',knownHeadRef:'head'});
        await store.release(id,operation.operationId,staged.revision+1);
    };
    await add('one');
    const kernel={inspectSession:vi.fn(async()=>({getShared:<T extends import('@nestos/durable-kernel').JsonValue>(key:string)=>f.state.get<T>(key)}))};
    const projects={list:vi.fn(async()=>[{path:'/x1',project:{id:'x1'}}])} as unknown as Pick<ProjectService,'list'>;
    const remote={list:vi.fn(()=>[{at:'/',connectionId:'node',serverProjectId:'workspace'}])} as unknown as Pick<ProjectRemoteMountService,'list'>;
    return {...f,add,kernel,projects,remote,resolve:nativeSessionResource(kernel,projects,remote)};
}
it('opens the original native context by authorized project identity without executing or writing',async()=>{
    const f=await fixture(),writes=[...f.writes];
    expect(await f.resolve('s','main')).toBe('/folder:x1/@harness/codex/native-one');
    expect(f.writes).toEqual(writes);expect(await f.resolve('s','other')).toBeUndefined();
});
it('does not guess when multiple contexts or no authorized project match',async()=>{
    const f=await fixture();vi.mocked(f.remote.list).mockReturnValue([]);
    expect(await f.resolve('s','main')).toBeUndefined();
    await f.add('two');expect(await f.resolve('s','main')).toBeUndefined();
});

it('archives the original native session with one stable operation and recovers a lost reply',async()=>{
    const {nativeSessionArchive}=await import('../src/projects/session-archive');
    const f=await fixture(),data=new Map<string,unknown>();
    const journal={get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined,update:async<T>(key:string,change:(old:T|undefined)=>T)=>{const value=change(structuredClone(data.get(key)) as T|undefined);data.set(key,value);return value;}};
    const archive=vi.fn(async()=>{throw Object.assign(new Error('Reply lost'),{code:'CONNECTION_LOST'});});
    const client={profiles:async()=>({epoch:'epoch'}),inspect:async()=>({session:{id:'native-one',status:'idle',owned:true,archiveAllowed:true}}),archive,operation:vi.fn(async()=>({outcome:'committed'})),close:vi.fn(async()=>{})};
    const remote=Object.assign(f.remote,{projectHarness:vi.fn(async()=>client)});
    const run=nativeSessionArchive(f.kernel,f.projects,remote as unknown as ProjectRemoteMountService,journal);
    await expect(run('s','archive-op')).rejects.toMatchObject({code:'CONNECTION_LOST'});
    await run('s','archive-op');await run('s','archive-op');
    expect(archive).toHaveBeenCalledExactlyOnceWith('codex','native-one',true,{requestId:'archive-op',epoch:'epoch'});
    expect(client.operation).toHaveBeenCalledOnce();
    expect(JSON.stringify([...data.values()])).not.toContain('Reply lost');
});
it('does not archive a native session which is still running',async()=>{
    const {nativeSessionArchive}=await import('../src/projects/session-archive');const f=await fixture(),data=new Map<string,unknown>();
    const journal={get:async<T>(key:string)=>data.get(key) as T|undefined,update:async<T>(key:string,change:(old:T|undefined)=>T)=>{const value=change(data.get(key) as T|undefined);data.set(key,value);return value;}};
    const archive=vi.fn(),remote=Object.assign(f.remote,{projectHarness:async()=>({profiles:async()=>({epoch:'epoch'}),inspect:async()=>({session:{id:'native-one',status:'running',activeTurnId:'turn'}}),archive,close:async()=>{}})});
    await expect(nativeSessionArchive(f.kernel,f.projects,remote as unknown as ProjectRemoteMountService,journal)('s','archive-op')).rejects.toMatchObject({code:'SESSION_ARCHIVE_STILL_RUNNING'});
    expect(archive).not.toHaveBeenCalled();
});

it.each([0,2])('distinguishes %s matching projects without contacting a guessed native target',async(count)=>{
 const {nativeSessionArchive}=await import('../src/projects/session-archive'),f=await fixture();
 vi.mocked(f.projects.list).mockResolvedValue(Array.from({length:count},(_,index)=>({path:'/project-'+index,project:{id:'project-'+index}})) as any);
 const remote=Object.assign(f.remote,{projectHarness:vi.fn()}),journal={get:async()=>undefined,update:vi.fn()};
 await expect(nativeSessionArchive(f.kernel,f.projects,remote as unknown as ProjectRemoteMountService,journal as never)('s','archive-op')).rejects.toMatchObject({code:count?'SESSION_ARCHIVE_BINDING_AMBIGUOUS':'SESSION_ARCHIVE_PROJECT_UNAVAILABLE'});
 expect(remote.projectHarness).not.toHaveBeenCalled();expect(journal.update).not.toHaveBeenCalled();
});
it('retains a frozen archive operation when its project binding no longer matches',async()=>{
 const {nativeSessionArchive}=await import('../src/projects/session-archive'),f=await fixture();
 const saved={phase:'prepared',projectId:'x1',nodeConnectionId:'old-node',workspaceId:'workspace',profileId:'codex',sessionId:'native-one',epoch:'epoch'};
 const remote=Object.assign(f.remote,{projectHarness:vi.fn()}),journal={get:async()=>saved,update:vi.fn()};
 await expect(nativeSessionArchive(f.kernel,f.projects,remote as unknown as ProjectRemoteMountService,journal as never)('s','archive-op')).rejects.toMatchObject({code:'SESSION_ARCHIVE_BINDING_CHANGED'});
 expect(remote.projectHarness).not.toHaveBeenCalled();expect(journal.update).not.toHaveBeenCalled();
});
