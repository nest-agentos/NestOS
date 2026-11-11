import {expect,it} from 'vitest';
import {observeNativePage,refreshNativeHistory,finishNativeTurn} from '../src/projects/harness-execution-observation';
import {nativeFailureCode} from '../src/projects/harness-turn-failure';
import type {NativeExecution} from '../src/projects/harness-execution-operations';

function fixture(error:unknown){
    const journal={data:{sessionId:'native',turnId:'turn',texts:[],operations:{},notified:[]},
        async save(update:unknown){Object.assign(this.data,update);}};
    const client={eventSnapshot:async()=>({epoch:'epoch',cursor:1,gap:false,events:[
        {message:{method:'turn/completed',params:{threadId:'native',turn:{id:'other',status:'failed',error:{codexErrorInfo:'contextWindowExceeded'}}}}},
        {message:{method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'failed',error}}}},
    ]}),read:async()=>({session:{id:'native'},turns:[{id:'turn',status:'completed',items:[]}]})};
    return {journal,run:{journal,acquired:{client,profile:{id:'profile'}},signal:new AbortController().signal} as unknown as NativeExecution};
}
it('persists quota classification without native messages and retains the exact failed turn across history reads',async()=>{
    const f=fixture({message:'private content',codexErrorInfo:'usageLimitExceeded'});
    await observeNativePage(f.run);await refreshNativeHistory(f.run);
    expect(f.journal.data).toMatchObject({terminal:'failed',terminalCode:'NATIVE_USAGE_LIMIT_EXCEEDED'});
    expect(JSON.stringify(f.journal.data)).not.toContain('private content');
    await expect(finishNativeTurn(f.run)).rejects.toMatchObject({code:'NATIVE_USAGE_LIMIT_EXCEEDED'});
});
it('keeps unknown native errors generic and never treats arbitrary messages as codes',async()=>{
    const f=fixture({message:'private content',codexErrorInfo:'private-code'});await observeNativePage(f.run);
    await expect(finishNativeTurn(f.run)).rejects.toMatchObject({code:'NATIVE_TURN_FAILED'});
    expect(nativeFailureCode({codex_error_info:'usage_limit_exceeded'})).toBe('NATIVE_USAGE_LIMIT_EXCEEDED');
    expect(nativeFailureCode({codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}}})).toBe('NATIVE_CONNECTION_FAILED');
});
