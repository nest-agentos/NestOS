import {expect,it,vi} from 'vitest';
import {nativeSessionActivity} from '../src/kanban/native-session-activity';
import {createLocalKanbanSessionSource} from '../src/kanban/session-source';
const board={id:'board'} as any,resource='/folder:project/@harness/codex/native';
function fixture(){
 const data=new Map<string,unknown>();let now=1000;
 const journal={get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined,update:vi.fn(async<T>(key:string,change:(old:T|undefined)=>T)=>{const value=change(structuredClone(data.get(key)) as T|undefined);data.set(key,structuredClone(value));return value;})};
 return {journal,activity:nativeSessionActivity(journal,()=>now),advance:(ms:number)=>{now+=ms;}};
}
it('projects a later native turn instead of the original completed kernel call and timestamp',async()=>{
 const f=fixture();await f.activity.record('board','execution',{sessionId:'native',turnId:'later',status:'running',observedAt:900});
 const repository={getManifest:async()=>({id:'execution',title:'Execution',currentBranch:'main',createdAt:1})},kernel={sessionActivity:async()=>({sessionId:'execution',counts:{running:0},pending:{},latestExit:{status:'succeeded',at:100},lastActivityAt:100})};
 const source=createLocalKanbanSessionSource(repository as never,kernel as never,async()=>resource,f.activity.read);
 expect(await source.inspect(board,'execution')).toMatchObject({state:'running',lastActivityAt:900,observedAt:1000,stale:false});
 await f.activity.record('board','execution',{sessionId:'native',turnId:'later',status:'completed',observedAt:1100});
 expect(await source.inspect(board,'execution')).toMatchObject({state:'completed',lastActivityAt:1100});
});
it('does not count polls as activity or persist an unchanged healthy observation',async()=>{
 const f=fixture(),event={sessionId:'native',turnId:'turn',status:'running',observedAt:900};
 await f.activity.record('board','execution',event);f.advance(30000);await f.activity.record('board','execution',event);
 expect(f.journal.update).toHaveBeenCalledOnce();expect(await f.activity.read(board,'execution',resource)).toMatchObject({state:'running',lastActivityAt:900,observedAt:31000,stale:false});
 f.advance(120001);expect(await f.activity.read(board,'execution',resource)).toMatchObject({state:'unknown',lastActivityAt:900,stale:true});
});
it('keeps restart evidence stale until a new real observation and rejects another native Session identity',async()=>{
 const f=fixture();await f.activity.record('board','execution',{sessionId:'native',status:'running',observedAt:900});
 const restarted=nativeSessionActivity(f.journal);
 expect(await restarted.read(board,'execution',resource)).toMatchObject({state:'unknown',stale:true});
 expect(await f.activity.read(board,'execution','/folder:project/@harness/codex/other')).toMatchObject({state:'unknown',code:'NATIVE_ACTIVITY_SCOPE_MISMATCH'});
 expect(await f.activity.read({id:'other-board'} as never,'execution',resource)).toMatchObject({state:'unknown',code:'NATIVE_ACTIVITY_PENDING'});
 expect(await f.activity.read(board,'execution','/local')).toBeUndefined();
});
it('does not turn disconnect or observation time into recent execution activity',async()=>{
 const f=fixture();await f.activity.record('board','execution',{sessionId:'native',status:'running',observedAt:900});
 await f.activity.record('board','execution',{sessionId:'native',status:'unknown',observedAt:1000});
 expect(await f.activity.read(board,'execution',resource)).toMatchObject({state:'unknown',lastActivityAt:900});
});
