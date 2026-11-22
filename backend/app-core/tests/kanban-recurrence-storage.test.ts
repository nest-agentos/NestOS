import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVFS} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {LocalFSBackend} from '../../../libraries/vfsdriver-local/src';
import {BetterSqliteSidecarDb} from '../../../libraries/vfsdriver-local/src/node';

const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
it('uses bounded SQLite key windows and reads only the requested hot rows',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recurrence-sqlite-'));closes.push(()=>rm(root,{recursive:true,force:true}));let db!:BetterSqliteSidecarDb;
 const backend=new LocalFSBackend({rootDir:root,sidecarDir:join(root,'.meta'),createDb:async path=>db=new BetterSqliteSidecarDb(path)});
 await backend.init();
 const {manager}=await createVFS({rootBackend:backend});closes.push(()=>manager.dispose());
 const fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs);await journal.open();
 for(let i=0;i<125;i++){
  const id='round-'+String(i).padStart(3,'0'),value={id,recordId:'decision',recordRevision:1,boardId:'board',createdAt:1000+i,updatedAt:1000+i,state:'completed' as const,record:{content:'PRIVATE_BODY'}};
  await journal.appendRecurringRun('board',value,{sourceBoardId:'board',recordId:'decision',recordRevision:1,runId:id});
 }
 const keys=vi.spyOn(db,'getRecordKeys'),full=vi.spyOn(db,'listRecordFields'),fields=vi.spyOn(db,'getRecordFields');
 const first=await journal.runHistoryPage('board','decision',20),second=await journal.runHistoryPage('board','decision',20,first.nextCursor);
 expect(first.items).toHaveLength(20);expect(second.items).toHaveLength(20);expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(40);
 expect(keys).toHaveBeenCalledTimes(4);expect(keys.mock.calls.every(([,query])=>query.limit===21||query.limit===51)).toBe(true);
 expect(fields.mock.calls.every(([,requested])=>requested.length<=20&&requested.every(field=>!field.includes('detail:')))).toBe(true);
 expect(full).not.toHaveBeenCalled();expect(JSON.stringify([first,second])).not.toContain('PRIVATE_BODY');
});
