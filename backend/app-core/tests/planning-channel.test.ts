import {describe,it,expect,vi} from 'vitest';
import {readPlanningChannel} from '../src/run/planning-channel';
import type {PromptJournal} from '../src/run/prompt-bundle';

function fixture() {
    const data=new Map<string,unknown>();
    const journal:PromptJournal={get:async <T>(key:string)=>structuredClone(data.get(key)) as T|undefined,
        update:async <T>(key:string,change:(old:T|undefined)=>T)=>{const value=change(structuredClone(data.get(key)) as T|undefined);data.set(key,structuredClone(value));return value;}};
    const origin=(turnId:string)=>({sessionId:'s',turnId,operationId:'op-'+turnId,revision:1});
    const envelope={messages:[] as any[],execution:{...origin('q'),status:'completed'}};
    const acks=new Map<string,unknown>();
    const remote={sessionChannel:vi.fn(async (_p:string,op:string,input:Record<string,unknown>)=>{
        if(op==='messages')return structuredClone(envelope);
        if(op==='acknowledge'){const key=String(input.id),old=acks.get(key);if(old&&JSON.stringify(old)!==JSON.stringify(input.ack))throw Error('ACK_CHANGED');acks.set(key,input.ack);return {};}
        throw Error('BAD_OPERATION');
    })};
    const report=(id:string,type:string,turnId:string,extra:object={})=>envelope.messages.push({id,origin:origin(turnId),message:{type,content:'report',...extra}});
    const read=()=>readPlanningChannel(remote as any,'p','scope',journal);
    return {journal,envelope,remote,origin,report,read,acks};
}
describe('planning conversation reports',()=>{
    it('keeps clarification across reads and restart, then accepts the same session after a new answer turn completes',async()=>{
        const f=fixture();f.report('question','clarification','q');
        expect(await f.read()).toMatchObject({state:'clarification'});
        expect(await readPlanningChannel(f.remote as any,'p','scope',f.journal)).toMatchObject({state:'clarification'});
        f.report('answer','resolved','a',{replyTo:'question'});
        f.report('final','result','a',{payload:{ready:true,reason:'Confirmed scope',dependencies:[]}});
        f.envelope.execution={...f.origin('a'),status:'running'};
        expect(await f.read()).toEqual({state:'running'});
        f.envelope.execution.status='completed';
        expect(await f.read()).toMatchObject({state:'succeeded',output:{ready:true}});
        expect(await f.read()).toMatchObject({state:'succeeded'});
        expect(f.acks.get('final')).toMatchObject({status:'validated'});
    });
    it('rejects same-turn self-resolution and premature results without preventing a corrected later report',async()=>{
        const f=fixture();f.report('question','clarification','q');f.report('fake','resolved','q',{replyTo:'question'});
        f.report('early','result','q',{payload:{ready:true}});
        expect(await f.read()).toMatchObject({state:'clarification'});
        expect(f.acks.get('fake')).toMatchObject({code:'PLANNING_REPLY_UNVERIFIED'});
        expect(f.acks.get('early')).toMatchObject({code:'PLANNING_CLARIFICATION_UNRESOLVED'});
        f.report('real','resolved','a',{replyTo:'question'});f.envelope.execution={...f.origin('a'),status:'completed'};
        expect(await f.read()).toBeUndefined();
        f.report('corrected','result','a',{payload:{ready:true,reason:'Scope',dependencies:[]}});
        expect(await f.read()).toMatchObject({state:'succeeded'});
    });
    it('identifies every unresolved historical report and acknowledges resolutions',async()=>{
        const f=fixture();f.report('legacy','result','q',{payload:{ready:false,reason:'Scope'}});
        f.report('new-question','clarification','q');await f.read();
        f.report('new-answer','resolved','a',{replyTo:'new-question'});
        f.report('early','result','a',{payload:{ready:true}});f.envelope.execution={...f.origin('a'),status:'completed'};
        expect(await f.read()).toMatchObject({state:'clarification'});
        expect(f.acks.get('early')).toMatchObject({code:'PLANNING_CLARIFICATION_UNRESOLVED',pendingQuestionIds:['legacy']});
        expect(f.acks.get('new-answer')).toMatchObject({status:'validated'});
        f.report('old-answer','resolved','b',{replyTo:'legacy'});f.report('final','result','b',{payload:{ready:true,reason:'Confirmed',dependencies:[]}});
        f.envelope.execution={...f.origin('b'),status:'completed'};
        expect(await f.read()).toMatchObject({state:'succeeded'});
        // A later conversational turn cannot erase already validated planning evidence.
        f.envelope.execution={...f.origin('later'),status:'running'};
        expect(await f.read()).toMatchObject({state:'succeeded'});
    });
    it('does not accept a final result without trusted publication origin',async()=>{
        const f=fixture();f.envelope.messages.push({id:'x',message:{type:'result',content:'ok',payload:{ready:true}}});
        expect(await f.read()).toEqual({state:'running'});
    });
    it('freezes legacy ready:false as a question without rewriting its original final result',async()=>{
        const f=fixture();f.envelope.messages.push({id:'old',message:{type:'result',content:'question',payload:{ready:false}}});
        expect(await f.read()).toMatchObject({state:'clarification'});
        f.envelope.execution={...f.origin('a'),status:'completed'};
        f.report('resolved','resolved','a',{replyTo:'old'});f.report('final','result','a',{payload:{ready:true}});
        expect(await f.read()).toMatchObject({state:'succeeded'});
    });
    it('rejects changed or missing publications and competing final results',async()=>{
        const f=fixture();f.report('q','clarification','q');await f.read();
        f.envelope.messages[0].message.content='changed';await expect(f.read()).rejects.toMatchObject({code:'CHANNEL_MESSAGE_CHANGED'});
        f.envelope.messages=[];await expect(f.read()).rejects.toMatchObject({code:'CHANNEL_MESSAGE_MISSING'});
        const g=fixture();g.report('a','result','q',{payload:{ready:true}});g.report('b','result','q',{payload:{ready:true}});
        await expect(g.read()).rejects.toMatchObject({code:'CHANNEL_RESULT_INVALID'});
    });
    it('retries acknowledgement after an uncertain response without losing the report',async()=>{
        const f=fixture();f.report('q','clarification','q');
        const normal=f.remote.sessionChannel.getMockImplementation()!;
        let once=true;f.remote.sessionChannel.mockImplementation(async(...args)=>{const result=await normal(...args);if(args[1]==='acknowledge'&&once){once=false;throw Error('NETWORK');}return result;});
        await expect(f.read()).rejects.toThrow('NETWORK');
        expect(await f.read()).toMatchObject({state:'clarification'});
    });
});

it('rejects a host-invalid delivery plan before acknowledging or freezing success',async()=>{
 const f=fixture();f.report('invalid','result','q',{payload:{ready:true}});
 const validate=()=>{throw Object.assign(new Error('Missing release'),{code:'DELIVERY_CHAIN_INVALID'});};
 expect(await readPlanningChannel(f.remote as any,'p','scope',f.journal,validate)).toMatchObject({state:'clarification'});
 expect(f.acks.get('invalid')).toEqual({status:'rejected',code:'DELIVERY_CHAIN_INVALID'});
 f.report('corrected','result','q',{payload:{ready:true,reason:'One release'}});
 expect(await f.read()).toMatchObject({state:'succeeded',output:{reason:'One release'}});
});
