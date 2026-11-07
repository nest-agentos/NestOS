import {afterEach, expect, it, vi} from 'vitest';
import {gzip, gunzipSync} from 'node:zlib';
import type {ServerResponse} from 'node:http';
import {compressedJson} from '../../node-host/src/http/http-response';
import {MAX_BODY_BYTES} from '@nestos/app-transport/rpc';

vi.mock('node:zlib', async original => {const actual = await original<typeof import('node:zlib')>(); return {...actual,gzip:vi.fn(actual.gzip)};});
afterEach(() => {vi.mocked(gzip).mockClear(); vi.restoreAllMocks();});
function response(encoding = 'gzip') {
    return {destroyed:false,req:{headers:{'accept-encoding':encoding}},writeHead:vi.fn(),end:vi.fn(),getHeader:vi.fn(() => 'operation-id')};
}
it('compresses large private JSON responses with correct framing and no caching', async () => {
    const reply = response(), payload = {data:'temporary fixture '.repeat(16000)};
    await compressedJson(reply as unknown as ServerResponse,200,payload);
    const headers = reply.writeHead.mock.calls[0][1], body = reply.end.mock.calls[0][0];
    expect(headers).toMatchObject({'Content-Encoding':'gzip','Content-Type':'application/json','Cache-Control':'no-store',Vary:'Accept-Encoding','Content-Length':body.length});
    expect(JSON.parse(gunzipSync(body).toString())).toEqual(payload);
    expect(body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(payload))/10);
});
it('negotiates gzip without overriding explicit refusal, and leaves small bodies plain', async () => {
    for(const encoding of ['', 'br', 'gzip;q=0', '*;q=1, gzip;q=0', 'gzip;q=invalid']) {
        const reply = response(encoding); await compressedJson(reply as unknown as ServerResponse,200,{data:'a'.repeat(5000)});
        expect(reply.writeHead.mock.calls[0][1]['Content-Encoding']).toBeUndefined();
        expect(JSON.parse(reply.end.mock.calls[0][0].toString())).toEqual({data:'a'.repeat(5000)});
    }
    const small = response(); await compressedJson(small as unknown as ServerResponse,200,{ok:true});
    expect(small.writeHead.mock.calls[0][1]['Content-Encoding']).toBeUndefined();
    expect(gzip).not.toHaveBeenCalled();
    for(const encoding of ['GZip; q=0.5','br, *;q=1']) {
        const reply = response(encoding); await compressedJson(reply as unknown as ServerResponse,200,{data:'a'.repeat(5000)});
        expect(reply.writeHead.mock.calls[0][1]['Content-Encoding']).toBe('gzip');
    }
});
it('enforces the uncompressed limit before compression', async () => {
    const reply = response();
    await expect(compressedJson(reply as unknown as ServerResponse,200,{data:'a'.repeat(MAX_BODY_BYTES)})).rejects.toMatchObject({code:'EFBIG'});
    expect(gzip).not.toHaveBeenCalled(); expect(reply.end).not.toHaveBeenCalled();
});
it('reports a compression failure without writing a partial response or logging its body', async () => {
    const warn = vi.spyOn(console,'warn').mockImplementation(() => {}), reply = response();
    vi.mocked(gzip).mockImplementationOnce(((_body:unknown,_options:unknown,done:(error:Error)=>void) => done(Object.assign(new Error('PRIVATE_BODY'),{code:'Z_DATA_ERROR'}))) as typeof gzip);
    await expect(compressedJson(reply as unknown as ServerResponse,200,{data:'PRIVATE_BODY'.repeat(500)})).rejects.toMatchObject({code:'EIO'});
    expect(reply.writeHead).not.toHaveBeenCalled(); expect(reply.end).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_BODY');
});
