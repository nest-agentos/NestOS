import {expect, it, vi} from 'vitest';
import {createApplicationRuntime} from '@nestos/app-core';
import {MemoryBackend} from '@nestos/vfs-core';
import {RpcPeer} from '@nestos/app-transport/application';
import {createHostedView} from '@nestos/node-host/http';
import type {ProjectRemoteMount,ServiceDiagnosticAccess} from '@nestos/app-contracts/services';

it('transports prepared file metadata with the workspace lease and preserves release ownership', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false});
    const report = vi.fn(), server = new RpcPeer('server', async () => ({value: null}), report);
    const client = new RpcPeer('client', call => server.handle(call), report);
    let source: Awaited<ReturnType<typeof runtime.projects.openWorkspace>> | undefined;
    try {
        const project = await runtime.projects.create('RPC workspace');
        source = await runtime.projects.openWorkspace(project.path, {initialPath: '/workspace'});
        const dispose = vi.spyOn(source, 'dispose'), boot = await server.bootstrap(source);
        client.applyUpdates(boot.updates); const remote = client.decode(boot.value!);
        expect(remote.initialFile).toMatchObject({node: {path: '/workspace', type: 'directory'}, readonly: false});
        expect(remote.fs.viewId).toBe(source.fs.viewId); expect(dispose).not.toHaveBeenCalled();
        await remote.dispose(); expect(dispose).toHaveBeenCalledOnce(); source = undefined;
        expect(report).not.toHaveBeenCalled();
    } finally {await client.close(); await server.close(); await source?.dispose(); await runtime.dispose();}
}, 15000);

it('exports the scoped log settings RPC only to administrator views',async()=>{
    const current:ServiceDiagnosticAccess={revision:'initial',sources:[]};
    const diagnosticAccess=vi.fn(async()=>current);
    const saveDiagnosticAccess=vi.fn(async()=>({revision:'next',sources:['cells' as const]}));
    const project={serverId:'node',serverProjectId:'remote-a',principalId:'owner',alias:'prj',root:'/x1'};
    const diagnosticProjects=vi.fn(async()=>[project]);
    const serviceControl={describe:vi.fn(),submit:vi.fn(),inspect:vi.fn(),diagnosticProjects,diagnosticAccess,saveDiagnosticAccess};
    const remoteSourceProvider={resolveCredential:()=>'',setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn()};
    const runtime=await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'httpd',digitalTwinAutoStart:false,serviceControl,remoteSourceProvider});
    const grant:ProjectRemoteMount={...project,at:'/',mountId:'mount-x1',access:'rw',endpoint:'https://cells.test',credentialRef:'fixture',
        authorization:{principalId:'owner',anonymous:false,revision:'1'}};
    const server=new RpcPeer('server',async()=>({value:null}),console.error);
    const client=new RpcPeer('client',call=>server.handle(call),console.error);
    try{
        vi.spyOn(runtime.projects.remoteMounts!,'list').mockImplementation(id=>id==='x1'?[grant]:[]);
        vi.spyOn(runtime.projects.remoteMounts!,'projectRemountOptions').mockResolvedValue({alias:'prj',path:'x1',roots:[]});
        const admin=await createHostedView(runtime),readonly=await createHostedView(runtime,true);
        try{
            const expose=async(root:typeof admin.root)=>client.decode(await server.expose(root));
            const backend=(await expose(admin.root)).backend,other=(await expose(readonly.root)).backend;
            expect(other.projectDiagnosticAccess).toBeUndefined();
            const access=backend.projectDiagnosticAccess;
            expect(access.projects).toEqual([project]);
            expect(diagnosticProjects).toHaveBeenCalledOnce();
            expect(await access.readDiagnosticAccess('x1')).toEqual(current);
            const update={operationId:'grant',expectedRevision:'initial',sources:['cells']};
            expect(await access.saveDiagnosticAccess('x1',update)).toEqual({revision:'next',sources:['cells']});
            expect(saveDiagnosticAccess).toHaveBeenCalledExactlyOnceWith(project,update);
            await expect(access.readDiagnosticAccess('wrong-project')).rejects.toMatchObject({code:'SERVICE_PROJECT_BINDING_REQUIRED'});
            expect(diagnosticAccess).toHaveBeenCalledExactlyOnceWith(project);
        }finally{await readonly.close();await admin.close();}
    }finally{await client.close();await server.close();await runtime.dispose();}
},15000);
