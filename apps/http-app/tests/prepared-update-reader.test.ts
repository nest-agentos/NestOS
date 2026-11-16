import {afterEach,expect,it,vi} from 'vitest';
import {PreparedUpdateReader} from '../../../shared/app-transport/src/http/prepared-update-reader';
import {HttpViewClient} from '@nestos/app-transport/http';
import {RpcPeer} from '@nestos/app-transport/application';

afterEach(() => {vi.useRealTimers();vi.restoreAllMocks();});
const lost = () => Object.assign(new Error('Connection interrupted'), {code: 'HTTP_CONNECTION_LOST'});

it('backs off repeatable reads up to fifteen seconds and cancels every pending retry with its owner', async () => {
    vi.useFakeTimers();const lifetime = new AbortController(), fetch = vi.fn(async () => {throw lost();}), report = vi.fn();
    const reader = new PreparedUpdateReader(lifetime.signal, fetch, report), result = reader.read('prepared-id').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);expect(fetch).toHaveBeenCalledTimes(1);
    for (const delay of [1000,2000,4000,8000,15000,15000]) {
        const count = fetch.mock.calls.length;await vi.advanceTimersByTimeAsync(delay-1);expect(fetch).toHaveBeenCalledTimes(count);
        await vi.advanceTimersByTimeAsync(1);expect(fetch).toHaveBeenCalledTimes(count+1);
    }
    expect(report).toHaveBeenLastCalledWith(expect.any(Error), expect.objectContaining({delayMs:15000, operationId:'prepared-id'}));
    lifetime.abort();expect(await result).toMatchObject({name:'AbortError'});
    const count = fetch.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(fetch).toHaveBeenCalledTimes(count);expect(vi.getTimerCount()).toBe(0);
});

it('wakes the same prepared read on foreground recovery and does not repeat completed callbacks', async () => {
    vi.useFakeTimers();const lifetime = new AbortController(), fetch = vi.fn().mockRejectedValueOnce(lost()).mockResolvedValueOnce({updates:[]});
    const reader = new PreparedUpdateReader(lifetime.signal, fetch, vi.fn()), result = reader.read('same-id');
    await vi.advanceTimersByTimeAsync(0);reader.retry();await expect(result).resolves.toEqual({updates:[]});
    expect(fetch.mock.calls).toEqual([['same-id'],['same-id']]);expect(vi.getTimerCount()).toBe(0);
});

it.each(['EIO','HTTP_RESPONSE_INVALID','ECAPABILITY'])('does not retry a real %s server or protocol failure', async code => {
    const failure = Object.assign(new Error('Real failure'), {code}), fetch = vi.fn(async () => {throw failure;}), report = vi.fn();
    const reader = new PreparedUpdateReader(new AbortController().signal, fetch, report);
    await expect(reader.read('prepared-id')).rejects.toBe(failure);expect(fetch).toHaveBeenCalledOnce();expect(report).not.toHaveBeenCalled();
});

it('retries a prepared update body lost in transit without treating it as invalid JSON', async () => {
    vi.useFakeTimers();const fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Body lost'), {code:'HTTP_RESPONSE_READ_FAILED'})).mockResolvedValue({updates:[]});
    const reader = new PreparedUpdateReader(new AbortController().signal, fetch, vi.fn()), result = reader.read('prepared-id');
    await vi.advanceTimersByTimeAsync(1000);await expect(result).resolves.toEqual({updates:[]});expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([false,true])('preserves saving on transient TLS failure and classifies a fatal prepared read (fatal=%s)', async fatal => {
    vi.useFakeTimers();vi.spyOn(console,'warn').mockImplementation(() => {});
    const saved = vi.fn(), server = new RpcPeer('server',async()=>({}));
    const bootstrap = await server.bootstrap({backend:{workbenchView:async()=>{},toolboxView:async()=>{},taskDetails:async()=>{},writeUiDocuments:saved}});
    let stream!: ReadableStreamDefaultController<Uint8Array>, finishSave!:()=>void, saveSignal!:AbortSignal, reads=0;
    const readIds:string[]=[], updateError=vi.fn(), disconnected=vi.fn();
    const fetcher:typeof fetch=async(_url,init)=>{
        if(!init?.method)return new Response(new ReadableStream({start(c){stream=c;}}));
        const body=JSON.parse(String(init.body));
        if(body.kind==='bootstrap')return Response.json(bootstrap);
        if(body.kind==='updates-read'){
            if(fatal)return Response.json({error:{code:'EIO',requestId:'prepared-failed-read'}},{status:500});
            readIds.push(body.id);if(++reads===1)throw new TypeError('TLS transport failed');return Response.json({updates:[]});
        }
        if(body.kind==='call'){
            saveSignal=init.signal!;await new Promise<void>((resolve,reject)=>{finishSave=resolve;init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});});
            return Response.json(await server.handle(body.call));
        }
        return Response.json({});
    };
    const client=new HttpViewClient('prepared-reader','/api/application',fetcher,disconnected,updateError);
    try{
        const root=await client.start(), apply=vi.spyOn(client.peer,'applyUpdates');
        const saving=root.backend.writeUiDocuments({document:{text:'PRIVATE_DRAFT'}}).then(()=>({ok:true}),error=>({error}));await vi.advanceTimersByTimeAsync(0);
        const id='e562a1b7-d1e5-42ac-b0aa-d9ac212c7f0a';
        stream.enqueue(new TextEncoder().encode(`data: {"updatesRead":"${id}"}\n\ndata: {}\n\n`));await vi.advanceTimersByTimeAsync(0);
        if(fatal){
            expect(updateError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code:'EIO',requestId:'prepared-failed-read'}));
            expect(saveSignal.reason).toMatchObject({code:'HTTP_VIEW_UPDATE_FAILED',updateCode:'EIO',requestId:'prepared-failed-read'});
            await expect(saving).resolves.toMatchObject({error:{code:'HTTP_VIEW_UPDATE_FAILED'}});expect(saved).not.toHaveBeenCalled();return;
        }
        expect(reads).toBe(1);expect(saveSignal.aborted).toBe(false);expect(updateError).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);expect(readIds).toEqual([id,id]);expect(apply).toHaveBeenCalledTimes(2);
        finishSave();await expect(saving).resolves.toEqual({ok:true});expect(saved).toHaveBeenCalledOnce();expect(saveSignal.aborted).toBe(false);expect(updateError).not.toHaveBeenCalled();
    }finally{await client.close();await server.close();}
});
