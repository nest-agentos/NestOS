import {EventEmitter} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {expect,it,vi} from 'vitest';
import {diagnosticContext} from '@nestos/common';
import {BrowserRequestTrace} from '../src/client/request-trace';
import {requestTrace,traceRequest,tracedCellsFetch} from '../../node-host/src/logging/request-trace';
import {auditRequest} from '../../node-host/src/logging/audit-log';
import {RequestDiagnostics} from '../src/client/request-diagnostics';
import {reportClientDiagnostic} from '../../../backend/app-core/src/host/client-diagnostic';
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
it('correlates a browser failure before the origin receives it and reports only safe metadata after reconnect',async()=>{
    const browser=new BrowserRequestTrace(),records:any[]=[],headers:Headers[]=[];
    const fetcher=browser.wrap(vi.fn(async(_url,init)=>{headers.push(new Headers(init?.headers));throw new TypeError('PRIVATE_INPUT_AND_TOKEN');}) as typeof fetch);
    const input={method:'POST',headers:{Authorization:'Bearer PRIVATE_TOKEN','X-NestOS-RPC-Kind':'call','X-NestOS-RPC-Method':'saveComposerDraft'},body:JSON.stringify({text:'PRIVATE_INPUT'})};
    await expect(fetcher('https://example.invalid/api/application?token=PRIVATE_QUERY',input)).rejects.toMatchObject({clientRequestId:expect.any(String)});
    browser.setReporter(async event=>{reportClientDiagnostic(event);records.push(event);});
    await vi.waitFor(()=>expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({operationId:headers[0].get('X-NestOS-Client-Request-ID'),stage:'transport.fetch',code:'HTTP_CONNECTION_LOST',
        http:{browserSessionId:browser.browserSessionId,route:'/api/application',method:'POST',rpcMethod:'saveComposerDraft',requestBytes:new TextEncoder().encode(input.body).byteLength}});
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE|Bearer|example.invalid|token=/);
});
it('distinguishes an upstream HTML 503 from a response decoding failure without logging its body',async()=>{
    const browser=new BrowserRequestTrace(),records:any[]=[];
    const fetcher=browser.wrap(async()=>new Response('<html>PRIVATE_UPSTREAM_BODY</html>',{status:503,headers:{'content-type':'text/html'}}));
    const response=await fetcher('/api/application',{method:'POST'});
    await expect(response.json()).rejects.toMatchObject({code:'HTTP_RESPONSE_INVALID',message:'Application response could not be decoded (HTTP 503)'});
    browser.setReporter(async event=>{reportClientDiagnostic(event);records.push(event);});
    await vi.waitFor(()=>expect(records).toHaveLength(2));
    expect(records.map(r=>r.stage)).toEqual(['response.headers','response.decode']);
    expect(records.every(r=>r.http.status===503 && r.http.responseType==='html' && !r.requestId)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
});
it('bounds deferred reports across reload and retains a failed report without a retry loop or replaying input',async()=>{
    const queue=new RequestDiagnostics();let saved='';queue.restore({read:()=>null,write:value=>{saved=value;}});
    const record={operation:'http.request',operationId:'11111111-1111-4111-8111-111111111111',stage:'transport.fetch',code:'HTTP_CONNECTION_LOST',result:'failure' as const,durationMs:1,
        http:{browserSessionId:'11111111-1111-4111-8111-111111111111',traceId:'1'.repeat(32),spanId:'2'.repeat(16),occurredAt:1,method:'POST' as const,route:'/api/application' as const}};
    for(let i=0;i<20;i++)queue.add({...record,durationMs:i});
    expect(JSON.parse(saved)).toHaveLength(16);
    const next=new RequestDiagnostics();next.restore({read:()=>saved,write:value=>{saved=value;}});
    const reporter=vi.fn().mockRejectedValueOnce(Error('PRIVATE_REPORT_ERROR')).mockResolvedValue(undefined);next.setReporter(reporter);
    await vi.waitFor(()=>expect(reporter).toHaveBeenCalledOnce());expect(JSON.parse(saved)).toHaveLength(16);
    await vi.waitFor(()=>{next.flush();expect(JSON.parse(saved)).toEqual([]);});expect(reporter).toHaveBeenCalledTimes(17);
    expect(reporter.mock.calls[0][0].durationMs).toBe(4);
});
it('records receipt of application headers before completion, even if the response later aborts',()=>{
    const req=request(),res=response(),records:any[]=[];
    req.headers['x-nestos-client-request-id']='11111111-1111-4111-8111-111111111111';
    auditRequest({write:event=>records.push(event),close:async()=>{}},req,res as unknown as ServerResponse,'/api/application');
    expect(records).toMatchObject([{event:'request.received',clientRequestId:req.headers['x-nestos-client-request-id'],stage:'request.headers'}]);
    res.writableFinished=false;res.emit('close');
    expect(records[1]).toMatchObject({event:'request.aborted',requestId:records[0].requestId,clientRequestId:records[0].clientRequestId});
});
it('distinguishes interrupted response bytes from malformed JSON',async()=>{
    const browser=new BrowserRequestTrace(),records:any[]=[];
    const fetcher=browser.wrap(async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('PRIVATE_STREAM_BODY'));}}),{headers:{'content-type':'application/json'}}));
    const response=await fetcher('/api/application');
    await expect(response.json()).rejects.toMatchObject({code:'HTTP_RESPONSE_READ_FAILED',stage:'response.body'});
    browser.setReporter(async event=>{reportClientDiagnostic(event);records.push(event);});await vi.waitFor(()=>expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({stage:'response.body',code:'HTTP_RESPONSE_READ_FAILED'});expect(JSON.stringify(records)).not.toContain('PRIVATE');
});
it('does not recursively queue failures of diagnostic reports or replay the failed application request',async()=>{
    const browser=new BrowserRequestTrace(),fetch=vi.fn().mockRejectedValueOnce(new TypeError('PRIVATE_INITIAL'))
        .mockRejectedValueOnce(new TypeError('PRIVATE_REPORT')).mockImplementation(async()=>new Response('{}'));
    const wrapped=browser.wrap(fetch);await expect(wrapped('/api/application')).rejects.toBeInstanceOf(TypeError);
    const report=vi.fn(async()=>{await wrapped('/api/application',{headers:{'X-NestOS-Diagnostic':'1'}});});browser.setReporter(report);
    await vi.waitFor(()=>expect(report).toHaveBeenCalledOnce());await new Promise(resolve=>setTimeout(resolve,10));expect(fetch).toHaveBeenCalledTimes(2);
    await wrapped('/api/health');await vi.waitFor(()=>expect(report).toHaveBeenCalledTimes(2));expect(fetch).toHaveBeenCalledTimes(4);
});

it('reports bounded method batches, retry attempts and safe network codes without logging arguments',async()=>{
    const browser=new BrowserRequestTrace(),records:any[]=[];
    const fetcher=browser.wrap(async()=>{throw Object.assign(new TypeError('PRIVATE_NETWORK_BODY'),{cause:{code:'ECONNRESET'}});});
    await expect(fetcher('/api/application',{method:'POST',headers:{'X-NestOS-RPC-Kind':'queries','X-NestOS-RPC-Methods':'catalog,decisionSnapshot',
        'X-NestOS-RPC-Batch-Size':'2','X-NestOS-RPC-Attempt':'2'},body:'PRIVATE_QUERY_ARGUMENTS'})).rejects.toThrow();
    browser.setReporter(async value=>{reportClientDiagnostic(value);records.push(value);});await vi.waitFor(()=>expect(records).toHaveLength(1));
    expect(records[0].http).toMatchObject({rpcMethods:['catalog','decisionSnapshot'],rpcBatchSize:2,rpcAttempt:2,networkCode:'ECONNRESET'});
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
});
it('defers exact capability compatibility diagnostics until the new view can report them',async()=>{
    const browser=new BrowserRequestTrace(),records:any[]=[];
    browser.compatibility({code:'RPC_METHOD_UNSUPPORTED',capabilityKind:'KanbanService',rpcMethod:'removeRecordConversations'});
    browser.compatibility({code:'RPC_METHOD_UNSUPPORTED',capabilityKind:'PRIVATE BODY',rpcMethod:'SECRET'});
    browser.setReporter(async value=>{reportClientDiagnostic(value);records.push(value);});await vi.waitFor(()=>expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({stage:'rpc.decode',code:'RPC_METHOD_UNSUPPORTED',http:{capabilityKind:'KanbanService',rpcMethod:'removeRecordConversations'}});
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
});
