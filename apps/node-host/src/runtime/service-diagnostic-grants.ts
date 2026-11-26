import {createHash} from 'node:crypto';
import {closeSync,openSync} from 'node:fs';
import {lstat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {ServiceDiagnosticAccess,ServiceDiagnosticSource,UpdateServiceDiagnosticAccess} from '@nestos/app-contracts/services';

export const diagnosticSources=['httpd','cells'] as const;
interface Row {revision:number;sources:ServiceDiagnosticSource[];operationId:string;expectedRevision:string}
interface DiagnosticDatabase {
    exec(sql:string):void;
    close():void;
    prepare(sql:string):{
        get(...values:string[]):Record<string,unknown>|undefined;
        run(...values:(string|number)[]):unknown;
    };
}

export class ServiceDiagnosticGrants {
    constructor(private readonly directory:string) {}

    async read(key:string,defaults:ServiceDiagnosticSource[]):Promise<ServiceDiagnosticAccess>{
        const db=await this.open(false);
        try{return snapshot(key,defaults,db?load(db,key):undefined);}
        finally{db?.close();}
    }

    async save(key:string,defaults:ServiceDiagnosticSource[],change:UpdateServiceDiagnosticAccess):Promise<ServiceDiagnosticAccess>{
        const sources=validateChange(change),db=await this.open(true);
        if(!db)throw failure('SERVICE_DIAGNOSTICS_STORAGE_UNAVAILABLE');
        try{
            db.exec('BEGIN IMMEDIATE');
            const previous=load(db,key),current=snapshot(key,defaults,previous);
            if(previous?.operationId===change.operationId){
                if(previous.expectedRevision!==change.expectedRevision||previous.sources.join()!==sources.join())
                    throw failure('SERVICE_DIAGNOSTICS_OPERATION_CONFLICT');
                db.exec('COMMIT');return current;
            }
            if(current.revision!==change.expectedRevision)throw failure('SERVICE_DIAGNOSTICS_ACCESS_CONFLICT');
            if(current.sources.join()===sources.join()){db.exec('COMMIT');return current;}
            const row={revision:(previous?.revision??0)+1,sources,operationId:change.operationId,expectedRevision:change.expectedRevision};
            db.prepare('INSERT INTO grants VALUES (?, ?, ?, ?, ?) ON CONFLICT(binding) DO UPDATE SET revision=excluded.revision,sources=excluded.sources,operation=excluded.operation,expected=excluded.expected')
                .run(key,row.revision,JSON.stringify(row.sources),row.operationId,row.expectedRevision);
            db.exec('COMMIT');
            return snapshot(key,defaults,row);
        }finally{db.close();}
    }

    private async open(create:boolean){
        if(create)await mkdir(this.directory,{recursive:true,mode:0o700});
        const info=await privateEntry(this.directory);
        if(!info){if(!create)return;throw failure('SERVICE_DIAGNOSTICS_STORAGE_UNAVAILABLE');}
        if(!info.isDirectory())throw failure('SERVICE_DIAGNOSTICS_STORAGE_INVALID');
        const file=path.join(this.directory,'grants.sqlite'),existing=await privateEntry(file);
        if(!existing&&!create)return;
        if(existing&&!existing.isFile())throw failure('SERVICE_DIAGNOSTICS_STORAGE_INVALID');
        const moduleName='node:sqlite';
        const {DatabaseSync}=await import(moduleName) as {DatabaseSync:new(file:string,options:{readOnly:boolean})=>DiagnosticDatabase};
        if(create&&!existing){
            try{closeSync(openSync(file,'wx',0o600));}
            catch(error){if((error as {code?:string}).code!=='EEXIST')throw error;}
        }
        const db=new DatabaseSync(file,{readOnly:!create});
        try{
            db.exec('PRAGMA busy_timeout=2000');
            if(create)db.exec('CREATE TABLE IF NOT EXISTS grants (binding TEXT PRIMARY KEY, revision INTEGER NOT NULL, sources TEXT NOT NULL, operation TEXT NOT NULL, expected TEXT NOT NULL)');
            return db;
        }catch(error){db.close();throw error;}
    }
}

async function privateEntry(file:string){
    const info=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(info&&(info.isSymbolicLink()||(info.mode&0o077)||process.getuid&&info.uid!==process.getuid()))
        throw failure('SERVICE_DIAGNOSTICS_STORAGE_INVALID');
    return info;
}
function load(db:DiagnosticDatabase,key:string):Row|undefined{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='grants'").get())return;
    const row=db.prepare('SELECT revision,sources,operation,expected FROM grants WHERE binding=?').get(key);
    return row?{revision:Number(row.revision),sources:normalizeSources(JSON.parse(String(row.sources))),
        operationId:String(row.operation),expectedRevision:String(row.expected)}:undefined;
}
function snapshot(key:string,defaults:ServiceDiagnosticSource[],row?:Row):ServiceDiagnosticAccess{
    const sources=row?.sources??defaults;
    return {sources,revision:createHash('sha256').update(JSON.stringify([key,defaults,row?.revision??0,sources])).digest('hex')};
}
function validateChange(change:UpdateServiceDiagnosticAccess):ServiceDiagnosticSource[]{
    if(!change||typeof change.expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(change.expectedRevision)
        ||typeof change.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(change.operationId)
        ||Object.keys(change).some(key=>!['expectedRevision','sources','operationId'].includes(key)))
        throw failure('SERVICE_DIAGNOSTICS_ACCESS_INVALID');
    return normalizeSources(change.sources);
}
function normalizeSources(value:unknown):ServiceDiagnosticSource[]{
    if(!Array.isArray(value)||value.length>diagnosticSources.length||new Set(value).size!==value.length||value.some(source=>!diagnosticSources.includes(source)))
        throw failure('SERVICE_DIAGNOSTICS_ACCESS_INVALID');
    return diagnosticSources.filter(source=>value.includes(source));
}
function failure(code:string):Error{return Object.assign(new Error(code),{code});}
