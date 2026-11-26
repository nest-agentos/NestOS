import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {getLogger} from '@nestos/common';
import type {ServiceDiagnosticQuery,ServiceDiagnosticRecord,ServiceDiagnosticResult,ServiceDiagnosticSource} from '@nestos/app-contracts/services';

const run=promisify(execFile),id=/^[A-Za-z0-9_.:-]{1,128}$/;
const tailBytes=512*1024,journalLines=1000;
type Fields=Record<string,unknown>;
type Reader=(since:number,serverId:string)=>Promise<Fields[]>;
type Readers=Record<ServiceDiagnosticSource,Reader>;

export async function projectServiceDiagnostics(project:{id:string;nodeId:string;serverId:string},query:ServiceDiagnosticQuery,
    readers:Readers=hostReaders(),now=Date.now(),sources:readonly ServiceDiagnosticSource[]=['httpd','cells']):Promise<ServiceDiagnosticResult>{
    const {operationId,requestId,minutes=30,limit=25}=query;
    if(![operationId,requestId].some(value=>value!==undefined)||[operationId,requestId].some(value=>value!==undefined&&!identifier(value))
        ||!validInteger(minutes,120)||!validInteger(limit,50))throw failure('SERVICE_DIAGNOSTICS_QUERY_INVALID');
    const since=now-minutes*60_000;
    const read=(source:ServiceDiagnosticSource)=>sources.includes(source)?readers[source](since,project.serverId):Promise.resolve([]);
    const [httpd,cells]=await Promise.allSettled([read('httpd'),read('cells')]);
    const records=[
        ...projectRecords('httpd',httpd,project.id,query,since,now),
        ...projectRecords('cells',cells,project.nodeId,query,since,now),
    ].sort((a,b)=>b.time.localeCompare(a.time)).slice(0,limit);
    const status=(source:ServiceDiagnosticSource,result:PromiseSettledResult<Fields[]>)=>!sources.includes(source)
        ?'disabled':result.status==='fulfilled'?'read':'unavailable';
    return {records,sources:{httpd:status('httpd',httpd),cells:status('cells',cells)}};
}

function projectRecords(source:ServiceDiagnosticSource,rows:PromiseSettledResult<Fields[]>,projectId:string,
    query:ServiceDiagnosticQuery,since:number,now:number):ServiceDiagnosticRecord[]{
    if(rows.status!=='fulfilled')return [];
    const records:ServiceDiagnosticRecord[]=[];
    for(const row of rows.value){
        const fields=object(row.fields)??row;
        if(!matchesScope(fields,source,projectId)||!matchesQuery(fields,query))continue;
        const time=timestamp(row.time??row.timestamp??row.at??fields.time);
        if(time===undefined||time<since||time>now)continue;
        records.push({source,time:new Date(time).toISOString(),
            operation:label(fields.operation??row.event),stage:label(fields.stage),
            result:label(fields.result??fields.outcome),code:code(fields.code??fields.errorCode??fields.error_code),
            durationMs:duration(fields.durationMs??fields.duration_ms??fields.elapsedMs)});
    }
    return records;
}

function matchesScope(fields:Fields,source:ServiceDiagnosticSource,projectId:string):boolean{
    if(source==='httpd'&&fields.userId!=='admin')return false;
    const scopes=source==='httpd'?[fields.projectId,fields.project_id]:[fields.projectId,fields.project_id,fields.serverProjectId,fields.server_project_id];
    const present=scopes.filter(scope=>scope!==undefined&&scope!==null);
    return present.length>0&&present.every(scope=>scope===projectId);
}
function matchesQuery(fields:Fields,query:ServiceDiagnosticQuery):boolean{
    return (query.operationId===undefined||(fields.operationId??fields.operation_id)===query.operationId)
        &&(query.requestId===undefined||[fields.requestId,fields.request_id,fields.parentRequestId,fields.parent_request_id].includes(query.requestId));
}
function hostReaders():Readers{
    const directory=process.env.NESTOS_HTTPD_LOG_DIR||'/var/log/nestos';
    return {httpd:async since=>{
        const memory=getLogger().query({startTime:since}).flatMap(entry=>{
            const fields=object(entry.data);
            return fields?[{fields,time:entry.timestamp}]:[];
        });
        try{return [...memory,...await readHttpd(directory)];}
        catch(error){if(memory.length)return memory;throw error;}
    },cells:readCells};
}
async function readHttpd(directory:string):Promise<Fields[]>{
    const names=['httpd.runtime.log','httpd.runtime.log.1','httpd.runtime.log.2','httpd.runtime.log.3'];
    const files=await Promise.all(names.map(name=>fileTail(path.join(directory,name)).catch(error=>{
        if((error as {code?:string}).code==='ENOENT')return undefined;
        throw error;
    })));
    if(files.every(file=>file===undefined))throw failure('SERVICE_DIAGNOSTICS_SOURCE_UNAVAILABLE');
    return files.flatMap<Fields>(file=>file?.split('\n').flatMap<Fields>(line=>{
        const index=line.indexOf('{');
        return index<0?[]:json(line.slice(index))??[];
    })??[]);
}
async function fileTail(file:string):Promise<string>{
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const info=await handle.stat();
        if(!info.isFile())throw failure('SERVICE_DIAGNOSTICS_SOURCE_INVALID');
        const start=Math.max(0,info.size-tailBytes),buffer=Buffer.alloc(info.size-start);
        const {bytesRead}=await handle.read(buffer,0,buffer.length,start);
        const text=buffer.toString('utf8',0,bytesRead);
        return start?text.slice(text.indexOf('\n')<0?text.length:text.indexOf('\n')+1):text;
    }finally{await handle.close();}
}
async function readCells(since:number,serverId:string):Promise<Fields[]>{
    const started=await cellsJournal(['--grep=server.ready','--lines=1']);
    const ready=started[0],identity=typeof ready?.MESSAGE==='string'&&json(ready.MESSAGE);
    if(!identity||identity.event!=='server.ready'||object(identity.fields)?.serverId!==serverId
        ||typeof ready._SYSTEMD_INVOCATION_ID!=='string')throw failure('SERVICE_DIAGNOSTICS_CELLS_IDENTITY_UNAVAILABLE');
    const rows=await cellsJournal([`--since=@${Math.floor(since/1000)}`,`--lines=${journalLines}`,
        `_SYSTEMD_INVOCATION_ID=${ready._SYSTEMD_INVOCATION_ID}`]);
    return rows.flatMap(row=>{
        if(typeof row.MESSAGE!=='string'||row._SYSTEMD_INVOCATION_ID!==ready._SYSTEMD_INVOCATION_ID)return [];
        const entry=json(row.MESSAGE),micros=Number(row.__REALTIME_TIMESTAMP);
        return entry&&Number.isSafeInteger(micros)?[{...entry,time:Math.floor(micros/1000)}]:[];
    });
}
async function cellsJournal(args:string[]):Promise<Fields[]>{
    const {stdout}=await run('/usr/bin/journalctl',['--unit=nestos-cells-local.service','--no-pager','--output=json',
        '--output-fields=MESSAGE,__REALTIME_TIMESTAMP,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID',...args],{timeout:4000,maxBuffer:2*1024*1024});
    return stdout.split('\n').flatMap<Fields>(line=>{
        const row=json(line);
        return row?._SYSTEMD_UNIT==='nestos-cells-local.service'?[row]:[];
    });
}
function json(value:string):Fields|undefined{
    try{return object(JSON.parse(value));}catch{return undefined;}
}
function object(value:unknown):Fields|undefined{return value&&typeof value==='object'&&!Array.isArray(value)?value as Fields:undefined;}
function identifier(value:unknown):boolean{return typeof value==='string'&&id.test(value);}
function validInteger(value:number,max:number):boolean{return Number.isSafeInteger(value)&&value>=1&&value<=max;}
function label(value:unknown):string|undefined{return typeof value==='string'&&/^[a-z][a-z0-9_.:-]{0,79}$/.test(value)?value:undefined;}
function code(value:unknown):string|undefined{return typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:undefined;}
function duration(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;}
function timestamp(value:unknown):number|undefined{
    const time=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
    return Number.isFinite(time)?time:undefined;
}
function failure(code:string):Error{return Object.assign(new Error(code),{code});}
