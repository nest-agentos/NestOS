import {expect, it} from 'vitest';
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startHost, createCertificates, loadCertificates} from '@nestos/node-host/http';
import {openCliApplication} from '../../cli/src/application-host';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const run=promisify(execFile);
async function stop(child?:ChildProcess) {
    if (!child || child.exitCode!==null || child.signalCode!==null) return;
    const ended=once(child,'exit'); child.kill('SIGTERM'); await ended;
}
async function startCells(root:string) {
    for (const name of ['home','work','catalog']) await mkdir(path.join(root,name));
    let source=await readFile(path.join(repo,'tools/cells/src/plugin/harness/tests/fixtures/codex-app-server.py'),'utf8');
    source=source.replace('threads = {}','threads = {}\ncreated_count = 0')
        .replaceAll("thread_id = 'session-' + str(len(threads) + 1)","created_count += 1\n        thread_id = 'session-' + str(created_count)")
        .replace("elif method == 'turn/start':", "elif method == 'turn/start':\n        if params['input'][0].get('text') == 'fixture:reject-first':\n            emit({'id':request['id'],'error':{'code':-32602,'message':'invalid fixture input'}})\n            continue");
    source=source.replace("elif method == 'thread/unsubscribe':",`elif method == 'thread/unsubscribe':\n        if not threads.get(params['threadId'], {}).get('turns'):\n            threads.pop(params['threadId'], None)\n        open(${JSON.stringify(path.join(root,'unsubscribed'))}, 'a').write('unloaded\\n')`);
    source=source.replace("thread = threads.get(params['threadId'])",`thread = threads.get(params['threadId'])\n        if thread is None:\n            emit({'id':request['id'],'error':{'code':-32600,'message':'thread not loaded: '+params['threadId']}})\n            continue`);
    const peer=path.join(root,'peer.py'); await writeFile(peer,source,{mode:0o700});
    const config=path.join(root,'cells.toml');
    await writeFile(config,`listen='127.0.0.1:0'\nserver_id='cli-empty-fixture'\ntoken='fixture-key-at-least-24-characters'\nexecution=true\n[projects]\nroot=${JSON.stringify(path.join(root,'catalog'))}\nisolation='none'\n[[exports]]\nalias='work'\npath=${JSON.stringify(path.join(root,'work'))}\naccess='rw'\n[[harnesses]]\nid='codex'\nkind='codex'\nprojects=true\nhome=${JSON.stringify(path.join(root,'home'))}\ncommand=${JSON.stringify(peer)}\n`);
    const child=spawn(process.env.CELLS_EMPTY_THREAD_BINARY ?? path.join(repo,'tools/cells/target/debug/cells'),[config],{stdio:['ignore','ignore','pipe']});
    let endpoint=''; child.stderr!.on('data',bytes=>{const found=String(bytes).match(/listening on (127\.0\.0\.1:\d+)/);if(found)endpoint='http://'+found[1];});
    try {await expect.poll(()=>endpoint,{timeout:10000}).toMatch(/^http:/); return {child,endpoint};}
    catch(error) {await stop(child);throw error;}
}
async function cli(args:string[],certs:string,port:number) {
    const {stdout}=await run('pnpm',['--silent','cli',...args,'--connect',`https://127.0.0.1:${port}`,'--client-cert',path.join(certs,'client.crt'),
        '--client-key',path.join(certs,'client.key'),'--ca-cert',path.join(certs,'ca.crt')],{cwd:repo,timeout:30000,maxBuffer:2*1024*1024});
    return JSON.parse(stdout.trim());
}
it('sends the first input through the real httpd CLI without unloading an unmaterialized native thread',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'httpd-cli-empty-'));
    let cells:Awaited<ReturnType<typeof startCells>>|undefined, host:Awaited<ReturnType<typeof startHost>>|undefined;
    let local:Awaited<ReturnType<typeof openCliApplication>>|undefined;
    try {
        cells=await startCells(root);
        const options={profile:path.join(root,'data'),authDir:path.join(root,'auth'),auditFile:path.join(root,'local-audit.jsonl')};
        local=await openCliApplication(options);
        const project=await local.client.services.projects.create('CLI empty');
        const mounts=local.client.services.projects.remoteMounts!;
        const connection=await mounts.saveConnection({name:'Fixture Cells',endpoint:cells.endpoint},'fixture-key-at-least-24-characters');
        await mounts.bindProject(project.project.id,connection,'/work','rw');
        await local.close(); local=undefined;
        const certs=path.join(root,'certs'); await createCertificates(certs,['127.0.0.1']);
        host=await startHost({root:options.profile,sidecar:path.join(options.profile,'_meta'),authDir:options.authDir,auditFile:path.join(root,'http-audit.jsonl'),
            certificates:await loadCertificates(certs),staticDir:root,port:0,host:'127.0.0.1',backlog:32});
        const port=(host.server.address() as {port:number}).port;
        const profiles=await cli(['conversation','profiles',project.project.id],certs,port);
        const workspace=profiles.profiles.find((p:{id:string})=>p.id==='codex').workspaces[0].id;
        const created=await cli(['conversation','create',project.project.id,'codex',workspace],certs,port);
        const id=created.session.id;
        const sent=await cli(['conversation','send',project.project.id,'codex',id,'fixture:checkpoint-empty-thread'],certs,port);
        expect(sent).toMatchObject({sessionId:id,pending:false,submittedTurnId:'turn-1'});
        const shown=await cli(['conversation','show',project.project.id,'codex',id],certs,port);
        expect(shown).toMatchObject({sessionId:id,pending:false});
        const draft=await cli(['conversation','draft',project.project.id,'codex'],certs,port);
        const before=await cli(['conversation','list',project.project.id,'codex'],certs,port);
        expect(before.sessions).toHaveLength(1);
        const first=await cli(['conversation','send-draft',project.project.id,'codex','fixture:first-content'],certs,port);
        expect(first).toMatchObject({sessionId:'session-2',pending:false,submittedTurnId:'turn-2'});
        const next=await cli(['conversation','draft',project.project.id,'codex'],certs,port);
        expect(next.draftId).not.toBe(draft.draftId);
        await expect(cli(['conversation','send-draft',project.project.id,'codex','fixture:reject-first'],certs,port)).rejects.toBeDefined();
        const afterFailure=await cli(['conversation','list',project.project.id,'codex'],certs,port);
        expect(afterFailure.sessions).toHaveLength(2);
        expect((await cli(['conversation','draft',project.project.id,'codex'],certs,port)).draftId).toBe(next.draftId);
        const retried=await cli(['conversation','send-draft',project.project.id,'codex','fixture:explicit-retry'],certs,port);
        expect(retried).toMatchObject({sessionId:'session-4',pending:false,submittedTurnId:'turn-3'});
        await expect(access(path.join(root,'unsubscribed'))).rejects.toMatchObject({code:'ENOENT'});
    } finally {await local?.close();await host?.close();await stop(cells?.child);await rm(root,{recursive:true,force:true});}
},180000);
