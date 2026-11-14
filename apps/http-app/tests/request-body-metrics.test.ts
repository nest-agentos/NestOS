import {expect,it} from 'vitest';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {readJson,type JsonReadMetrics} from '../../node-host/src/http/http-response';

it('records byte/chunk metadata while another independent body can finish first',async()=>{
    let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
    const chunks=['{"method":"读取",','"args":[]}'];let metrics:JsonReadMetrics|undefined;
    const slow=readJson(Readable.from((async function*(){yield Buffer.from(chunks[0]);await gate;yield Buffer.from(chunks[1]);})()) as IncomingMessage,value=>{metrics=value;});
    try {
        expect(await readJson(Readable.from([Buffer.from('{"method":"fast"}')]) as IncomingMessage)).toMatchObject({method:'fast'});
        expect(metrics).toBeUndefined();
    }finally{finish();}
    expect(await slow).toMatchObject({method:'读取'});
    expect(metrics).toMatchObject({bodyBytes:Buffer.byteLength(chunks.join('')),bodyChunks:2,bodyFirstByteMs:expect.any(Number),bodyReceiveMs:expect.any(Number),bodyParseMs:expect.any(Number)});
    expect(JSON.stringify(metrics)).not.toContain('method');
});
it('keeps failure metrics without recording malformed content',async()=>{
    let metrics:JsonReadMetrics|undefined;
    await expect(readJson(Readable.from([Buffer.from('PRIVATE_INVALID_BODY')]) as IncomingMessage,value=>{metrics=value;})).rejects.toMatchObject({code:'EINVAL'});
    expect(metrics).toMatchObject({bodyBytes:20,bodyChunks:1,bodyParseMs:expect.any(Number)});
    expect(JSON.stringify(metrics)).not.toContain('PRIVATE');
});
