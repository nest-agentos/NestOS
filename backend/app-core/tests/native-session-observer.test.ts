import {expect,it,vi} from 'vitest';
import {currentNativeSessionReader} from '../src/kanban/native-session-observer';
import type {HarnessObservation} from '@nestos/cells-driver';
const resource='/folder:project/@harness/codex/native',board={id:'board'} as never;
function fixture(){
 const previous={state:'completed' as const,lastActivityAt:100,observedAt:100,stale:true,code:'NATIVE_ACTIVITY_STALE'};
 let current:HarnessObservation|undefined;
 const fresh={execution:'idle',lastResult:'completed',observedAt:Date.now(),stale:false,connection:'online'} as HarnessObservation;
 const status={get:vi.fn(()=>current),read:vi.fn(async()=>{current=fresh;})};
 const projects={forFolder:vi.fn(async()=>({path:'/project',project:{id:'project'}} as never))};
 const cached=vi.fn(async()=>previous),read=currentNativeSessionReader({cached,status,projects});
 return {previous,fresh,status,projects,cached,read,set:(value:HarnessObservation)=>{current=value;}};
}
it('refreshes settled channel evidence from shared metadata without inventing user activity',async()=>{
 const f=fixture();
  expect(await f.read(board,'execution',resource)).toMatchObject({state:'completed',stale:false,observedAt:f.fresh.observedAt,lastActivityAt:100,code:undefined});
  await f.read(board,'execution',resource);expect(f.status.read).toHaveBeenCalledOnce();
  f.set({...f.fresh,execution:'running'});expect(await f.read(board,'execution',resource)).toMatchObject({state:'running',stale:false,lastActivityAt:100});

});
it('keeps actual metadata failures actionable and preserves the last activity timestamp',async()=>{
 const f=fixture();f.status.read.mockRejectedValue(Object.assign(new Error('Private endpoint details'),{code:'EACCES'}));
 expect(await f.read(board,'execution',resource)).toMatchObject({state:'unknown',stale:true,code:'EACCES',lastActivityAt:100});
});
it('does not read a different native scope or resurrect expired shared metadata',async()=>{
 const f=fixture();f.cached.mockResolvedValue({...f.previous,code:'NATIVE_ACTIVITY_SCOPE_MISMATCH'});
 expect(await f.read(board,'execution',resource)).toMatchObject({code:'NATIVE_ACTIVITY_SCOPE_MISMATCH'});expect(f.projects.forFolder).not.toHaveBeenCalled();
 f.cached.mockResolvedValue(f.previous);const expired={...f.fresh,execution:'running' as const,observedAt:1};
 f.status.read.mockImplementation(async()=>{f.set(expired);});
 expect(await f.read(board,'execution',resource)).toMatchObject({state:'unknown',stale:true,code:'NATIVE_ACTIVITY_STALE',lastActivityAt:100});
});
