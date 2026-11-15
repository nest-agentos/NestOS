import {expect,it,vi} from 'vitest';
import {installFileTransport} from '../../../shared/app-transport/src/http/file-transport';

function transport(fetcher:typeof fetch) {
    let call!:(target:string,method:string,args:unknown[])=>Promise<unknown>;
    const peer={setFileTransport:(value:typeof call)=>{call=value;},expose:async(value:unknown)=>value,
        applyUpdates:()=>{},waitUpdates:async()=>{},decode:(value:unknown)=>value};
    installFileTransport(peer as never,'https://nestos.example/api/application','view',new AbortController().signal,fetcher);
    return ()=>call('file','writeContent',['/note.md',new Uint8Array([1]).buffer,{}]);
}
it.each(['disconnect','truncated-reply'])('preserves an uncertain upload on %s without retrying',async failure=>{
    const fetcher=vi.fn(async()=>{if(failure==='disconnect')throw new Error('connection reset');return new Response('incomplete JSON');});
    await expect(transport(fetcher as typeof fetch)()).rejects.toMatchObject({code:'EIO',outcome:'unknown'});
    expect(fetcher).toHaveBeenCalledOnce();
});
it('retains the original remote operation ID in a failed binary upload reply',async()=>{
    const upload=transport((async()=>Response.json({error:{name:'FSError',message:'unknown',code:'EIO',outcome:'unknown',operationId:'original-dav-write'}})) as typeof fetch);
    await expect(upload()).rejects.toMatchObject({operationId:'original-dav-write',outcome:'unknown'});
});
