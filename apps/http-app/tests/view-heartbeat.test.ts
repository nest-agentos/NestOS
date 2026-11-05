import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {afterEach,expect,it,vi} from 'vitest';
import {startViewHeartbeat} from '../../node-host/src/http/view-heartbeat';
afterEach(()=>vi.useRealTimers());
function fixture(authorize?:()=>Promise<boolean>){
    vi.useFakeTimers();const stream=Object.assign(new EventEmitter(),{write:vi.fn(),end:vi.fn(),destroyed:false,writableEnded:false,writableFinished:false});
    const options={authorize,current:()=>true,seen:vi.fn(),failed:vi.fn()};startViewHeartbeat(stream as unknown as ServerResponse,options);return {stream,options};
}
it('discards late authorization after finish and absorbs a late stream error',async()=>{
    let resolve!:(value:boolean)=>void;const f=fixture(()=>new Promise(done=>{resolve=done;}));
    await vi.advanceTimersByTimeAsync(15000);f.stream.writableEnded=true;f.stream.emit('finish');resolve(true);
    await vi.advanceTimersByTimeAsync(30000);expect(f.stream.write).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    expect(()=>f.stream.emit('error',Object.assign(new Error(),{code:'ERR_STREAM_WRITE_AFTER_END'}))).not.toThrow();
});
it('avoids overlapping authorization and records a safe failure before stopping',async()=>{
    let reject!:(error:Error)=>void;const authorize=vi.fn(()=>new Promise<boolean>((_,fail)=>{reject=fail;}));const f=fixture(authorize);
    await vi.advanceTimersByTimeAsync(45000);expect(authorize).toHaveBeenCalledOnce();
    reject(Object.assign(new Error(),{code:'AUTH_UNAVAILABLE'}));await vi.advanceTimersByTimeAsync(1);
    expect(f.options.failed).toHaveBeenCalledOnce();expect(f.stream.end).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
