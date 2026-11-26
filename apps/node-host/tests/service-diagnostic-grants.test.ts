import {expect,it} from 'vitest';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {UpdateServiceDiagnosticAccess} from '@nestos/app-contracts/services';
import {ServiceDiagnosticGrants} from '../src/runtime/service-diagnostic-grants';

it('persists scoped grants, fences stale writes, and recognizes a repeated save',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'diagnostic-grants-'));
    const directory=path.join(root,'grants'),store=new ServiceDiagnosticGrants(directory);
    try{
        const original=await store.read('project-a',[]);
        expect(original.sources).toEqual([]);
        expect(await store.read('project-b',['httpd','cells'])).toMatchObject({sources:['httpd','cells']});
        const change:UpdateServiceDiagnosticAccess={expectedRevision:original.revision,operationId:'grant-1',sources:['cells']};
        const saved=await store.save('project-a',[],change);
        expect(saved.sources).toEqual(['cells']);
        expect(await store.save('project-a',[],change)).toEqual(saved);
        await expect(store.save('project-a',[],{...change,sources:['httpd']}))
            .rejects.toMatchObject({code:'SERVICE_DIAGNOSTICS_OPERATION_CONFLICT'});
        await expect(store.save('project-a',[],{...change,operationId:'stale',sources:['httpd']}))
            .rejects.toMatchObject({code:'SERVICE_DIAGNOSTICS_ACCESS_CONFLICT'});
        expect(await new ServiceDiagnosticGrants(directory).read('project-a',[])).toEqual(saved);
        expect(await store.read('project-b',[])).toMatchObject({sources:[]});
        expect((await stat(path.join(directory,'grants.sqlite'))).mode&0o777).toBe(0o600);
        const inherited=await store.read('project-b',['httpd','cells']);
        await store.save('project-b',['httpd','cells'],{expectedRevision:inherited.revision,operationId:'revoke',sources:[]});
        expect(await store.read('project-b',['httpd','cells'])).toMatchObject({sources:[]});
    }finally{await rm(root,{force:true,recursive:true});}
});

it('rejects paths and other unsupported settings before writing a grant',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'diagnostic-grants-'));
    try{
        const store=new ServiceDiagnosticGrants(path.join(root,'grants'));
        const original=await store.read('project',[]);
        const change={expectedRevision:original.revision,operationId:'grant',sources:[]};
        for(const invalid of [{...change,sources:['/var/log/nestos']},{...change,path:'/var/log/nestos'},{...change,sources:['httpd','httpd']}])
            await expect(store.save('project',[],invalid as UpdateServiceDiagnosticAccess))
                .rejects.toMatchObject({code:'SERVICE_DIAGNOSTICS_ACCESS_INVALID'});
        expect(await store.read('project',[])).toEqual(original);
    }finally{await rm(root,{force:true,recursive:true});}
});
