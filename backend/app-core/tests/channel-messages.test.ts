import {expect,it,vi} from 'vitest';
import {consumeChannelMessages} from '../src/run/channel-messages';
const scope={runId:'run',itemId:'task',attemptId:'attempt'};
function journal(){const data=new Map<string,unknown>();return {get:async<T>(key:string)=>data.get(key) as T|undefined,update:async<T>(key:string,change:(old:T|undefined)=>T)=>{const value=change(data.get(key) as T|undefined);data.set(key,value);return value;}};}
it('retries pending delivery without losing identity and rejects altered publications',async()=>{
    const store=journal(),deliver=vi.fn().mockResolvedValueOnce({pending:true}).mockResolvedValue(undefined);
    const value={messages:[{id:'m1',message:{type:'result',content:'Evidence'}}]};
    await consumeChannelMessages(value,scope,store,deliver);await consumeChannelMessages(value,scope,store,deliver);await consumeChannelMessages(value,scope,store,deliver);
    expect(deliver).toHaveBeenCalledTimes(2);expect(deliver.mock.calls[0][0]).toMatchObject({...scope,id:'m1',content:'Evidence'});
    value.messages[0].message.content='changed';await expect(consumeChannelMessages(value,scope,store,deliver)).rejects.toMatchObject({code:'CHANNEL_MESSAGE_CHANGED'});
});
it('validates business message types and bounds before delivery',async()=>{
    const deliver=vi.fn();for(const message of [{type:'accept-execution',content:'done'},{type:'progress',content:'x'.repeat(8001)}])
        await expect(consumeChannelMessages({messages:[{id:'m',message}]},scope,journal(),deliver)).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
});

it('repairs a lost node acknowledgement without repeating a committed delivery',async()=>{
    const store=journal(),deliver=vi.fn(async()=>{}),ack=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const value={messages:[{id:'m',message:{type:'progress',content:'Saved'}}]};
    await expect(consumeChannelMessages(value,scope,store,deliver,ack)).rejects.toThrow('offline');
    await consumeChannelMessages(value,scope,store,deliver,ack);
    await consumeChannelMessages(value,scope,store,deliver,ack);
    expect(deliver).toHaveBeenCalledOnce();expect(ack).toHaveBeenCalledTimes(2);
});
it('rejects invalid linked resolutions and duplicate IDs before any delivery',async()=>{
    const deliver=vi.fn(),row={id:'m',message:{type:'progress',content:'Saved'}};
    await expect(consumeChannelMessages({messages:[row,row]},scope,journal(),deliver)).rejects.toMatchObject({code:'CHANNEL_MESSAGE_INVALID'});
    await expect(consumeChannelMessages({messages:[row,{id:'resolved',message:{type:'resolved',replyTo:'missing',content:'Done'}}]},scope,journal(),deliver)).rejects.toMatchObject({code:'WORKSPACE_RESOLUTION_INVALID'});
    expect(deliver).not.toHaveBeenCalled();
});
it('delivers linked questions before their resolutions and detects removed publications after restart',async()=>{
    const store=journal(),deliver=vi.fn(async()=>{}),question={id:'question',message:{type:'clarification',content:'Choose'}};
    const value={messages:[{id:'resolved',message:{type:'resolved',replyTo:'question',content:'Answer applied'}},question]};
    expect((await consumeChannelMessages(value,scope,store,deliver)).map(row=>row.id)).toEqual(['question','resolved']);
    await expect(consumeChannelMessages({messages:[question]},scope,store,deliver)).rejects.toMatchObject({code:'CHANNEL_MESSAGE_MISSING'});
    expect(deliver).toHaveBeenCalledTimes(2);
});
it('does not acknowledge pending business delivery',async()=>{
    const ack=vi.fn(),value={messages:[{id:'m',message:{type:'result',content:'Ready'}}]};
    await consumeChannelMessages(value,scope,journal(),async()=>({pending:true}),ack);expect(ack).not.toHaveBeenCalled();
});

it('preserves the binary issue handler from the native payload and rejects other handlers',async()=>{
 const deliver=vi.fn(async()=>{});
 for(const handler of ['self','parent']){
  const rows=await consumeChannelMessages({messages:[{id:'error',message:{type:'error',content:'Blocked',payload:{handler}}}]},scope,journal(),deliver);
  expect(rows[0]).toMatchObject({handler});
 }
 await expect(consumeChannelMessages({messages:[{id:'error',message:{type:'error',content:'Blocked',payload:{handler:'administrator'}}}]},scope,journal(),deliver)).rejects.toMatchObject({reasonCode:'WORK_MESSAGE_HANDLER_INVALID'});
});
