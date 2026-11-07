import {EventEmitter} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {expect,it,vi} from 'vitest';
import {diagnosticContext} from '@nestos/common';
import {BrowserRequestTrace} from '../src/client/request-trace';
import {requestTrace,traceRequest,tracedCellsFetch} from '../../node-host/src/logging/request-trace';
import {auditRequest} from '../../node-host/src/logging/audit-log';
const response=()=>Object.assign(new EventEmitter(),{headers:new Map<string,string>(),setHeader(name:string,value:string){this.headers.set(name,value);},getHeader(name:string){return this.headers.get(name);},statusCode:200,writableFinished:true});
it('uses a navigation operation as the backend trace even when pushState emits no hashchange',async()=>{
    const browser=new BrowserRequestTrace(),headers:Headers[]=[];
    const fetcher=browser.wrap(async(_input,init)=>{headers.push(new Headers(init?.headers));return new Response('{}');});
    const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
    browser.beginNavigation(first);await fetcher('/api/application');browser.beginNavigation(second);await fetcher('/api/application');
    expect(headers.map(h=>h.get('traceparent')!.split('-')[1])).toEqual([first.replaceAll('-',''),second.replaceAll('-','')]);
    browser.beginNavigation('INVALID_PRIVATE_BODY');await fetcher('/api/application');
    expect(headers[2].get('traceparent')).not.toContain('PRIVATE_BODY');
});
function request(trace='11111111111111111111111111111111'):IncomingMessage {return {url:'/api/application',socket:{remoteAddress:'127.0.0.1'},method:'POST',headers:{traceparent:`00-${trace}-2222222222222222-01`,'x-nestos-browser-session-id':'11111111-1111-4111-8111-111111111111'}} as unknown as IncomingMessage;}
it('keeps concurrent Node requests isolated and propagates parentage to Cells and finish logs',async()=>{
    const records:any[]=[],outgoing:string[]=[],audit={write:(event:any)=>records.push(event),close:async()=>{}};
    const fetcher=vi.fn(async(_url,init)=>{outgoing.push(new Headers(init.headers).get('traceparent')!);await new Promise(r=>setTimeout(r,1));return new Response('{}',{headers:{'x-request-id':'cells-request'}});});
    const responses=[response(),response()],ids=['11111111111111111111111111111111','33333333333333333333333333333333'];
    await Promise.all(ids.map((id,i)=>traceRequest(request(id),responses[i] as unknown as ServerResponse,async()=>{
        auditRequest(audit,request(id),responses[i] as unknown as ServerResponse,'/api/application');
        await tracedCellsFetch(fetcher as typeof fetch,event=>audit.write(event))('https://cells.invalid/v1/api/projects/list?token=secret');
        expect(diagnosticContext()?.traceId).toBe(id);
    })));
    responses.forEach(value=>value.emit('finish'));
    expect(diagnosticContext()).toBeUndefined();expect(outgoing.map(v=>v.split('-')[1]).sort()).toEqual(ids);
    expect(records.filter(v=>v.event==='request.complete').map(v=>v.traceId)).toEqual(ids);
    expect(records.filter(v=>v.event==='cells.request')).toHaveLength(2);
    expect(JSON.stringify(records)).not.toMatch(/secret|token|cells.invalid/);
    for(const record of records.filter(v=>v.event==='cells.request'))expect(record.parentRequestId).toBeTruthy();
});
it('rejects malformed and zero incoming trace metadata without reflecting it',()=>{
    for(const raw of ['secret\nvalue','00-'+ '0'.repeat(32)+'-'+ '1'.repeat(16)+'-01']){
        const req=request();req.headers.traceparent=raw;req.headers['x-nestos-browser-session-id']='secret';
        const context=requestTrace(req);expect(context.traceId).toMatch(/^[a-f0-9]{32}$/);expect(context.traceId).not.toBe('0'.repeat(32));expect(context.parentSpanId).toBeUndefined();expect(context.browserSessionId).toBeUndefined();
    }
});
it('correlates browser navigation requests while giving concurrent requests different spans',async()=>{
    const browser=new BrowserRequestTrace(),headers:Headers[]=[];
    const fetcher=browser.wrap((async(_input,init)=>{headers.push(new Headers(init?.headers));return new Response('{}');}) as typeof fetch);
    await Promise.all([fetcher('/api/application'),fetcher('/api/application')]);browser.beginNavigation();await fetcher('/api/application');
    const parents=headers.map(h=>h.get('traceparent')!.split('-'));
    expect(parents[0][1]).toBe(parents[1][1]);expect(parents[0][2]).not.toBe(parents[1][2]);expect(parents[2][1]).not.toBe(parents[0][1]);
    expect(headers.every(h=>h.get('x-nestos-browser-session-id')===browser.browserSessionId)).toBe(true);
});
it('preserves trace metadata when a Cells transport fails without logging the exception body',async()=>{
    const records:any[]=[];
    await expect(traceRequest(request(),response() as unknown as ServerResponse,()=>tracedCellsFetch((async()=>{throw Object.assign(Error('PRIVATE_BODY'),{code:'ECONNRESET'});}) as typeof fetch,event=>records.push(event))('https://cells.invalid/private/name'))).rejects.toThrow('PRIVATE_BODY');
    expect(records[0]).toMatchObject({traceId:'11111111111111111111111111111111',result:'failure',code:'ECONNRESET',route:'/v1/resource'});
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_BODY|private\/name/);
});
