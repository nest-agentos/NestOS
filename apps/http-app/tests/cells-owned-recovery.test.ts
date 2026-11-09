import {expect,it} from 'vitest';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createCellsDriver} from '@nestos/cells-driver';
import {createCertificates,createHttpServer,loadCertificates} from '@nestos/node-host/http';
import type {ApplicationRuntime} from '@nestos/app-core';
import {createSessionRecoveryClient} from '@nestos/app-transport/http';
import {ProjectRemoteMountService} from '../../../backend/app-core/src/projects/remote-mounts';
import {NativeSessionRecovery} from '../../../backend/app-core/src/projects/session-recovery';
import {RemoteConversationStore} from '../../../backend/app-core/src/projects/remote-conversation-store';
import {remoteClientState} from '../../../backend/app-core/src/projects/remote-client-state';
import {remoteConversationKey} from '../../../backend/app-core/src/projects/drafts/remote-submission';
import {RuntimeApi} from '../../node-host/src/http/runtime-api';
import {authenticatedFetch,listen,close} from './tls-fixture';
async function wait(check:()=>boolean|Promise<boolean>){for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('CELLS_HTTPS_FIXTURE_TIMEOUT');}
async function stop(child:ChildProcess|undefined){if(!child || child.exitCode!==null || child.signalCode!==null)return;const done=once(child,'exit');child.kill('SIGTERM');await done;}
it('recovers through the real NestOS-to-Cells path after a missing browser view and keeps duplicate recovery atomic',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'nestos-cells-recovery-'));
    const manifest=path.resolve('../../tools/cells/Cargo.toml'),peer=path.join(root,'peer.py');let cells:ChildProcess|undefined;
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});const provider=createCellsDriver();let remote:ProjectRemoteMountService|undefined;
    let server:ReturnType<typeof createHttpServer>|undefined,api:RuntimeApi|undefined,auth:Awaited<ReturnType<typeof authenticatedFetch>>|undefined;
    try{
        await promisify(execFile)('cargo',['build','--quiet','--manifest-path',manifest],{timeout:90000});
        for(const name of ['home','work','catalog','ui'])await mkdir(path.join(root,name));
        const native=path.join(root,'native.json');await writeFile(native,JSON.stringify({id:'native',cwd:path.join(root,'work'),status:{type:'notLoaded'},turns:[]}));
        const template=await readFile(path.resolve(manifest,'../src/plugin/harness/tests/fixtures/queue-app-server.py'),'utf8');
        await writeFile(peer,template.replaceAll('__STATE__',JSON.stringify(native)).replaceAll('__COUNT__',JSON.stringify(path.join(root,'turns'))).replaceAll('__FINISH__',JSON.stringify(path.join(root,'finish'))),{mode:0o700});
        const config=path.join(root,'cells.toml');await writeFile(config,`listen="127.0.0.1:0"\nserver_id="http-recovery-fixture"\ntoken="http-recovery-fixture-token-at-least-24-bytes"\nexecution=true\n[projects]\nroot=${JSON.stringify(path.join(root,'catalog'))}\nisolation="none"\n[[exports]]\nalias="work"\npath=${JSON.stringify(path.join(root,'work'))}\naccess="rw"\n[[harnesses]]\nid="codex"\nkind="codex"\ncommand=${JSON.stringify(peer)}\nhome=${JSON.stringify(path.join(root,'home'))}\nprojects=true\n`);
        cells=spawn(path.resolve(manifest,'../target/debug/cells'),[config],{stdio:['ignore','ignore','pipe']});let output='',endpoint='';
        cells.stderr!.on('data',chunk=>{output+=String(chunk);const match=output.match(/listening on (127\.0\.0\.1:\d+)/);if(match)endpoint='http://'+match[1];});await wait(()=>!!endpoint);
        const fs=await manager.openFileSystem('/');remote=new ProjectRemoteMountService(fs,provider,async()=>{},async()=>{});await remote.init();
        const connection=await remote.saveConnection({name:'Fixture',endpoint},'http-recovery-fixture-token-at-least-24-bytes');await remote.bindProject('p',connection,'/work','rw');
        const mount=remote.list('p')[0]!;const client=provider.projects(await remote.resolveConnection(connection));const project=await client.read(mount.serverProjectId!);
        const key=remoteConversationKey('p',{connectionId:connection,serverProjectId:project.id,principalId:mount.authorization?.principalId,profileId:'codex'},'native');
        const journal=new RemoteConversationStore(fs,key,remoteClientState(client,project,key,()=>{},'codex'));
        await journal.load();await journal.save({sessionId:'native',instructionQueue:{revision:4,paused:false,receipts:[{id:'old',input:'a'.repeat(64),turnId:'original'}],items:[{id:'old',text:'fixture accepted input',attachments:[],createdAt:1,state:'dispatching',receipt:{turnId:'original'}}]}});await client.close();
        const view=await remote.projectConversation('p','codex','native');await view.read();await view.close();
        const service=new NativeSessionRecovery(()=>remote);api=new RuntimeApi(Promise.resolve({sessionRecovery:service,createView:async()=>{throw new Error('View creation is forbidden');}} as unknown as ApplicationRuntime),undefined,false);
        const certs=path.join(root,'certs');await createCertificates(certs,['127.0.0.1']);auth=await authenticatedFetch(certs);
        server=createHttpServer({audit:{write:()=>{},close:async()=>{}},application:api,certificates:await loadCertificates(certs),staticDir:path.join(root,'ui')});const origin=`https://127.0.0.1:${await listen(server)}`;
        const expired=await auth.fetcher(origin+'/api/application/events?clientId=missing&after=0&version=15&resume=1');expect(expired.status).toBe(400);await expired.body?.cancel();
        const recovery=createSessionRecoveryClient(auth.fetcher,origin+'/api/sessions/recovery');const request={projectId:'p',profileId:'codex',sessionId:'native',operationId:'same-operation',instructionId:'old',expectedRevision:4};
        const started=performance.now();const results=await Promise.all([recovery.recover(request),recovery.recover(request)]);
        expect(results.map(r=>r.duplicate).sort()).toEqual([false,true]);expect(results.every(r=>r.state.instructionQueue?.revision===5 && r.outcome==='recovered')).toBe(true);expect(performance.now()-started).toBeLessThan(5000);
        expect(results[0]!.state.instructionQueue?.recoveries?.[0]).toMatchObject({id:'old',outcome:'unknown'});
        const index=await fs.meta.seq!.getEntry('/etc/fs/harness-conversations.seq',key);expect(index).not.toContain('fixture accepted input');
        await service.close();
    }finally{auth?.close();await api?.close();if(server)await close(server);await remote?.dispose();await provider.dispose();await manager.dispose();await stop(cells);await rm(root,{recursive:true,force:true});}
},120000);
