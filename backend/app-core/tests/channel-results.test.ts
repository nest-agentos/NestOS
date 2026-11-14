import {expect,it} from 'vitest';
import {readChannelResult} from '../src/run/channel-results';
import {memoryChannels} from './helpers/session-channels';
function fixture(){
    const channels=memoryChannels(),values=new Map<string,unknown>();
    const journal={get:async<T>(key:string)=>values.get(key) as T|undefined,update:async<T>(key:string,change:(old:T|undefined)=>T)=>{const value=change(values.get(key) as T|undefined);values.set(key,value);return value;}};
    return {channels,read:(reportErrors=false)=>readChannelResult({sessionChannel:channels.channel},'project','scope',journal,{reportErrors})};
}
it('freezes a structured result independently of chat and rejects later changes',async()=>{
    const f=fixture();expect(await f.read()).toBeUndefined();
    f.channels.report('scope','result',{type:'result',content:'Ready',payload:{ready:true}});
    expect(await f.read()).toEqual({ready:true});expect(await f.read()).toEqual({ready:true});
    f.channels.ensure('scope').messages[0].message.payload={ready:false};
    await expect(f.read()).rejects.toMatchObject({code:'CHANNEL_RESULT_CHANGED'});
});
it('rejects ambiguous or missing structured payloads',async()=>{
    const f=fixture();f.channels.report('scope','first',{type:'result',content:'Ready'});
    await expect(f.read()).rejects.toMatchObject({code:'CHANNEL_RESULT_INVALID'});
    f.channels.report('scope','second',{type:'result',content:'Again',payload:{}});
    await expect(f.read()).rejects.toMatchObject({code:'CHANNEL_RESULT_INVALID'});
});
it('surfaces a scoped structured blocker without treating it as a successful final result',async()=>{
    const f=fixture();f.channels.report('scope','missing-identity',{type:'error',content:'Private details',payload:{operationId:'scope',code:'GIT_IDENTITY_MISSING'}});
    expect(await f.read()).toBeUndefined();await expect(f.read(true)).rejects.toMatchObject({code:'GIT_IDENTITY_MISSING'});
    f.channels.report('scope','formal-result',{type:'result',content:'Verified',payload:{status:'succeeded'}});
    expect(await f.read(true)).toEqual({status:'succeeded'});
});
