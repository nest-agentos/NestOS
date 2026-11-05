import {afterEach,expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {operationReceipt} from '../src/run/operation-receipt';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
it('recovers a scoped immutable receipt after losing MCP and rejects changed or contradictory results',async()=>{
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/');
    const journal=new KanbanAutomationJournal(fs);await journal.open();
    const payload={schema:'nestos.kanban.operation-result/1',operationId:'replace',status:'succeeded',version:'candidate'};
    await fs.driver.createFile({parentPath:'/operation',name:'result.json',content:JSON.stringify(payload),recursive:true});
    expect(await operationReceipt(fs,'/operation',undefined,journal,'replace')).toEqual(payload);
    expect(await operationReceipt(fs,'/operation',payload,journal,'replace')).toEqual(payload);
    await expect(operationReceipt(fs,'/operation',{...payload,version:'other'},journal,'replace')).rejects.toMatchObject({code:'OPERATION_RESULT_RECEIPT_CONFLICT'});
    await fs.driver.writeContent('/operation/result.json',JSON.stringify({...payload,version:'other'}));
    await expect(operationReceipt(fs,'/operation',undefined,journal,'replace')).rejects.toMatchObject({code:'OPERATION_RESULT_RECEIPT_CONFLICT'});
});
