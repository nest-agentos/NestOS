import {it,expect,vi} from 'vitest';
import {remoteClientState} from '../src/projects/remote-client-state';
import type {ProjectClient,RemoteProject} from '@nestos/cells-driver';
function fixture(){const rows=new Map<string,string>();const client={clientState:vi.fn(async(_project:unknown,input:any)=>{
    if(input.action==='read')return {value:rows.get(input.key)??null};
    if((rows.get(input.key)??null)!==input.expected)return {applied:false};
    if(input.value===null)rows.delete(input.key);else rows.set(input.key,input.value);return {applied:true};
})} as unknown as ProjectClient;return {rows,client,port:remoteClientState(client,{id:'p'} as RemoteProject,'native',()=>{})};}
it('keeps small state in one remote record and uses CAS without local storage',async()=>{
    const f=fixture();expect(await f.port.read('recovery')).toBeNull();
    expect(await f.port.compare('recovery',null,'private input')).toBe(true);
    expect(await f.port.read('recovery')).toBe('private input');expect(f.rows.size).toBe(1);
    expect(await f.port.compare('recovery',null,'overwrite')).toBe(false);
    const other=remoteClientState(f.client,{id:'p'} as RemoteProject,'other',()=>{});
    expect(await other.read('recovery')).toBeNull();
});
it('verifies chunked remote records and cleans replaced generations',async()=>{
    const f=fixture(),value='A'.repeat(400000);expect(await f.port.compare('asset/id',null,value)).toBe(true);
    expect(await f.port.read('asset/id')).toBe(value);expect(f.rows.size).toBeGreaterThan(1);
    expect(await f.port.compare('asset/id',value,'small')).toBe(true);expect(f.rows.size).toBe(1);
    expect(await f.port.read('asset/id')).toBe('small');
});
