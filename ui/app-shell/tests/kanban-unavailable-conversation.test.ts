import {expect,it,vi} from 'vitest';
const {confirm}=vi.hoisted(()=>({confirm:vi.fn()}));
vi.mock('@nestos/ui-common',()=>({showConfirmDialog:confirm}));
import {confirmUnavailableConversation} from '../src/kanban/unavailable-conversation';
function fixture(){
 const row={id:'discussion',boardId:'b',state:'error',code:'ECAPABILITY',createdAt:1,resourceId:'/missing',sessionId:'original'};
 const controlRecordConversation=vi.fn(async()=>{}),service={catalog:async()=>[{id:'b'}],recordConversations:async()=>[row],controlRecordConversation};
 return {row,service,controlRecordConversation};
}
it('offers cleanup without changing anything when the user retains the unavailable entry',async()=>{
 const f=fixture();confirm.mockResolvedValueOnce(false);
 expect(await confirmUnavailableConversation(f.service as never,'/missing')).toBe(false);expect(f.controlRecordConversation).not.toHaveBeenCalled();
});
it('cleans only the matching discussion after confirmation and leaves the original session untouched',async()=>{
 const f=fixture();confirm.mockResolvedValueOnce(true);
 expect(await confirmUnavailableConversation(f.service as never,'/missing')).toBe(true);
 expect(f.controlRecordConversation).toHaveBeenCalledWith('b',expect.objectContaining({conversationId:'discussion',action:'cleanup-reference',confirmed:true,fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)}));
 expect(f.row.sessionId).toBe('original');
});
it('preserves the entry when absence cannot be revalidated by the host',async()=>{
 const f=fixture();confirm.mockResolvedValueOnce(true);f.controlRecordConversation.mockRejectedValueOnce(Object.assign(Error('Unavailable evidence'),{code:'CONVERSATION_REFERENCE_STILL_AVAILABLE'}));
 await expect(confirmUnavailableConversation(f.service as never,'/missing')).rejects.toMatchObject({code:'CONVERSATION_REFERENCE_STILL_AVAILABLE'});
});

it('reuses a stable cleanup identity after a lost metadata acknowledgement',async()=>{
 const f=fixture(),requests=new Map<string,string>();confirm.mockResolvedValue(true);
 f.controlRecordConversation.mockRejectedValueOnce(Object.assign(Error('lost'),{code:'EIO'}));
 await expect(confirmUnavailableConversation(f.service as never,'/missing',requests)).rejects.toMatchObject({code:'EIO'});
 await confirmUnavailableConversation(f.service as never,'/missing',requests);
 expect(f.controlRecordConversation.mock.calls[0][1].operationId).toBe(f.controlRecordConversation.mock.calls[1][1].operationId);
});
