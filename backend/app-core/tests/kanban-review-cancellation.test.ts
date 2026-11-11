import {expect,it,vi} from 'vitest';
import {reviewCancellation} from '../src/presets/kanban-review-cancellation';
import type {SubmissionControlRequest,ControlJournal} from '@nestos/llm-session';
import type {ReviewJob} from '../src/kanban/item-operation-types';
function fixture(){
 const values=new Map<string,unknown>();
 const journal={get:async(key:string)=>structuredClone(values.get(key)),update:async(key:string,change:any)=>{const next=change(structuredClone(values.get(key)));values.set(key,structuredClone(next));return next;}};
 const base={expectedSessionId:'session',submission:{id:'original'}};
 const job:ReviewJob={id:'review',boardId:'b',itemId:'i',action:'build',phase:'submitting',state:'running',fingerprint:'f',createdAt:1,snapshot:{version:'v',sourceVersion:'s',targetVersion:'t',context:{}},request:base as never};
 const submission=vi.fn(async(_input:SubmissionControlRequest,_journal:ControlJournal)=> 'cancelled' as 'cancelled'|'accepted'|'unknown'),native=vi.fn(async(_input:{scopeId:string;operationId:string;action:'cancel'})=> 'cancelled' as 'cancelled'|'accepted'|'unknown');
 const cancel=reviewCancellation({journal:journal as never,submission,native});return {values,job,submission,native,cancel};
}
it('requires both native and kernel stop evidence and freezes exact continuation identities',async()=>{
 const f=fixture();f.values.set('channel-exchange:review',{request:{expectedSessionId:'session',submission:{id:'continuation'}}});
 f.submission.mockResolvedValueOnce('cancelled').mockResolvedValueOnce('accepted');
 expect(await f.cancel(f.job,'cancel')).toBe('accepted');expect(f.submission.mock.calls.map(row=>row[0].submissionId)).toEqual(['original','continuation']);
 f.values.set('channel-exchange:review',{request:{expectedSessionId:'other',submission:{id:'unrelated'}}});
 expect(await f.cancel(f.job,'cancel')).toBe('cancelled');expect(f.submission.mock.calls.slice(2).map(row=>row[0].submissionId)).toEqual(['original','continuation']);
 expect(f.native.mock.calls[0][0]).toEqual(f.native.mock.calls[1][0]);
});
it('retains uncertainty when the cell cannot prove stop',async()=>{
 const f=fixture();f.native.mockResolvedValue('unknown');expect(await f.cancel(f.job,'cancel')).toBe('unknown');
});
it('does not treat one rejected component as proof the whole multi-layer cancellation was unadmitted',async()=>{
 const f=fixture();f.native.mockRejectedValueOnce(Object.assign(new Error('Denied'),{code:'EACCES',cancelRejected:true}));
 await expect(f.cancel(f.job,'cancel')).rejects.toMatchObject({code:'EACCES',cancelRejected:false});expect(f.submission).toHaveBeenCalledOnce();
});
