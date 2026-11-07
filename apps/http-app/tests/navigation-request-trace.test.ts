// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {NAVIGATION_EVENTS} from '@nestos/common';
import {BrowserRequestTrace} from '../src/client/request-trace';

it('keeps the operation trace across late hashchange and popstate events and releases its listener',async()=>{
 const tracing=new BrowserRequestTrace(),lifetime=new AbortController(),headers:Headers[]=[];
 tracing.bindNavigation(lifetime.signal);
 const fetcher=tracing.wrap(async(_input,init)=>{headers.push(new Headers(init?.headers));return new Response('{}');});
 const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
 const start=(operationId:string)=>window.dispatchEvent(new CustomEvent(NAVIGATION_EVENTS.START,{detail:{operationId}}));
 try{
  start(first);window.dispatchEvent(new HashChangeEvent('hashchange'));await fetcher('/api/application');
  start(second);window.dispatchEvent(new PopStateEvent('popstate'));window.dispatchEvent(new HashChangeEvent('hashchange'));await fetcher('/api/application');
  lifetime.abort();start(first);await fetcher('/api/application');
  expect(headers.map(value=>value.get('traceparent')!.split('-')[1])).toEqual([first.replaceAll('-',''),second.replaceAll('-',''),second.replaceAll('-','')]);
 }finally{lifetime.abort();}
});
