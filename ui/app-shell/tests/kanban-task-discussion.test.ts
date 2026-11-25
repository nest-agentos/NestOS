import {expect,it,vi} from 'vitest';
import type {ApplicationBackend,ApplicationServices} from '@nestos/app-contracts/services';
import type {KanbanItem,KanbanRequest} from '@nestos/kanban/contracts';
import {openTaskDiscussion} from '../src/kanban/task-discussion';

it('resumes a reserved discussion after a failed draft write and reopens it after task completion',async()=>{
    const item={id:'checklist',title:'Practice',participants:[],status:'open'} as unknown as KanbanItem;
    const getManifest=vi.fn().mockRejectedValueOnce({code:'ENOENT'}).mockResolvedValue({branches:{'task-discussion':null}});
    const execute=vi.fn(async (_board:string,request:KanbanRequest)=>{
        if(request.command.type!=='register-session')throw new Error('Unexpected command');
        item.participants.push({sessionId:request.command.sessionId,roles:['discussion'],subscribed:false,joinedAt:1});
    });
    const services={kanban:{execute,read:async()=>({revision:2}),item:async()=>({item})},
        projects:{personal:async()=>({path:'/local'})},sessionRepository:{getManifest}} as unknown as ApplicationServices;
    const createSessionDraft=vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue(undefined);
    const backend={createSessionDraft} as unknown as ApplicationBackend;
    await expect(openTaskDiscussion(services,backend,'round',item,'Context')).rejects.toThrow('Disconnected');
    const [{sessionId}]=item.participants;
    const route=sessionId+'?branch=task-discussion';
    await expect(openTaskDiscussion(services,backend,'round',item,'Context')).resolves.toBe(route);
    item.status='completed';
    await expect(openTaskDiscussion(services,backend,'round',item,'New text')).resolves.toBe(route);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createSessionDraft).toHaveBeenCalledTimes(2);
    expect(createSessionDraft.mock.calls.every(([request])=>request.sessionId===sessionId&&request.inputText==='Context')).toBe(true);
});
