import {afterEach, describe, expect, it} from 'vitest';
import {NodeServerTerminals} from '../../node-host/src/terminal/server-terminals';
import type {ServerTerminal} from '@nestos/app-contracts/services';
import {RpcPeer, installViewProjections} from '@nestos/app-transport/application';
import {createApplicationRuntime} from '@nestos/app-core';
import {MemoryBackend} from '@nestos/vfs-core';
import {createHostedView} from '@nestos/node-host/http';

const hosts: NodeServerTerminals[] = [];
afterEach(async () => {await Promise.all(hosts.splice(0).map(host => host.dispose()));});
function host() {const value = new NodeServerTerminals(); hosts.push(value); return value;}
async function outputUntil(session: ServerTerminal, pattern: RegExp, cursor = 0) {
    let output = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const page = await session.readOutput(cursor); output += page.output; cursor = page.cursor;
        if (pattern.test(output)) return {output, cursor};
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Expected terminal output did not arrive');
}

describe('server Bash terminal', () => {
    it('keeps Bash state, displays stderr, and interrupts foreground jobs through real RPC', async () => {
        const terminals = host();
        let server!: RpcPeer;
        const client = new RpcPeer('client', call => server.handle(call), () => {}, installViewProjections);
        server = new RpcPeer('server', call => client.handle(call), () => {});
        try {
            const boot = await server.bootstrap(terminals); client.applyUpdates(boot.updates);
            const remote = client.decode(boot.value!) as NodeServerTerminals;
            const session = await remote.openTerminal();
            await session.sendInput("cd /tmp; export NESTOS_TERMINAL_TEST=state; printf '\\nREADY_MARKER\\n'\r");
            let page = await outputUntil(session, /\r?\nREADY_MARKER\r?\n/);
            await session.sendInput("printf '\\n%s:%s\\n' \"$PWD\" \"$NESTOS_TERMINAL_TEST\"; printf 'STDERR_MARKER\\n' >&2\r");
            page = await outputUntil(session, /\r?\nSTDERR_MARKER\r?\n/, page.cursor);
            expect(page.output).toContain('/tmp:state');
            await session.resizeTerminal(100, 35);
            await session.sendInput('sleep 60\r');
            await new Promise(resolve => setTimeout(resolve, 100));
            await session.sendInput('\x03');
            await session.sendInput("printf '\\nINTERRUPTED_MARKER\\n'\r");
            await outputUntil(session, /\r?\nINTERRUPTED_MARKER\r?\n/, page.cursor);
            await session.sendInput('exit 7\r');
            await expect.poll(async () => (await session.readOutput(0)).exited).toBe(true);
            expect((await session.readOutput(0)).exitCode).toBe(7);
            await session.dispose();
        } finally {await client.close(); await server.close();}
    }, 15000);

    it('bounds sessions and output, rejects invalid input, and closes live processes with the view', async () => {
        const terminals = host(), first = await terminals.openTerminal(), second = await terminals.openTerminal();
        await expect(terminals.openTerminal()).rejects.toMatchObject({code: 'EBUSY'});
        await expect(first.readOutput(-1)).rejects.toMatchObject({code: 'EINVAL'});
        await expect(first.resizeTerminal(0, 24)).rejects.toMatchObject({code: 'EINVAL'});
        await expect(first.sendInput('x'.repeat(16385))).rejects.toMatchObject({code: 'EINVAL'});
        await first.sendInput("head -c 400000 /dev/zero | tr '\\0' x; printf '\\nOVERFLOW_DONE\\n'\r");
        await expect.poll(async () => (await first.readOutput(0)).truncated).toBe(true);
        await terminals.dispose();
        await expect(first.sendInput('echo bad\r')).rejects.toMatchObject({code: 'EIO'});
        await expect(second.sendInput('echo bad\r')).rejects.toMatchObject({code: 'EIO'});
        await expect(terminals.openTerminal()).rejects.toMatchObject({code: 'EIO'});
    });
});

it('exposes server terminals only to administrator views and releases them on view closure', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', startupMode: 'interactive', digitalTwinAutoStart: false});
    const admin = await createHostedView(runtime), user = await createHostedView(runtime, true);
    try {
        expect(user.root.backend.serverTerminals).toBeUndefined();
        const session = await admin.root.backend.serverTerminals!.openTerminal();
        await admin.close();
        await expect(session.sendInput('echo forbidden\r')).rejects.toMatchObject({code: 'EIO'});
    } finally {await admin.close(); await user.close(); await runtime.dispose();}
}, 15000);

it('persists private commands and Bash history without recording interactive input', async () => {
    const {mkdtemp, mkdir, readdir, stat, rm} = await import('node:fs/promises');
    const path = await import('node:path');
    const base = path.resolve('../../_nestos/kanban/artifacts/terminal-tests'); await mkdir(base, {recursive:true});
    const directory = await mkdtemp(path.join(base, 'case-'));
    const first = new NodeServerTerminals(directory), second = new NodeServerTerminals(directory);
    try {
        await Promise.all([first.saveCommand({id:'one',name:'One',command:'printf one'}),second.saveCommand({id:'two',name:'Two',command:'printf two'})]);
        expect((await first.listCommands()).map(row=>row.id).sort()).toEqual(['one','two']);
        await first.saveCommand({id:'one',name:'Edited',command:'printf edited'}); await second.deleteCommand('two');
        expect(await second.listCommands()).toEqual([{id:'one',name:'Edited',command:'printf edited'}]);
        await expect(first.saveCommand({id:'bad!',name:'Bad',command:'x'})).rejects.toMatchObject({code:'EINVAL'});
        await expect(first.saveCommand({id:'oversize',name:'Bad',command:'汉'.repeat(6000)})).rejects.toMatchObject({code:'EINVAL'});
        await expect(first.saveCommand({name:'Bad',command:'x'} as any)).rejects.toMatchObject({code:'EINVAL'});
        const {getLogger}=await import('@nestos/common');
        const logs=JSON.stringify(getLogger().query({modules:['server-terminal']}));
        expect(logs).not.toContain('printf edited');expect(logs).not.toContain('private-password-value');
        expect(logs).toContain('EINVAL');
        const session=await first.openTerminal();
        let page=await outputUntil(session,/\x1b\[\?2004h.*[$#] /);
        await session.sendInput('false\r'); page=await outputUntil(session,/[$#] /,page.cursor);
        await session.sendInput("printf 'STATUS:%s\\n' \"$?\"\r"); page=await outputUntil(session,/STATUS:1\r?\n/,page.cursor);
        await session.sendInput("for x in marker; do\rprintf 'MULTI_%s\\n' \"$x\"\rdone\r"); page=await outputUntil(session,/MULTI_marker\r?\n/,page.cursor);
        await session.sendInput("printf 'HISTORY_READY\\n'\r"); page=await outputUntil(session,/HISTORY_READY\r?\n/,page.cursor);
        await session.sendInput("read -rs REPLY; printf 'INPUT_DONE\\n'\r");
        await new Promise(resolve=>setTimeout(resolve,100)); await session.sendInput('private-password-value\r');
        await outputUntil(session,/INPUT_DONE\r?\n/,page.cursor);
        await expect.poll(async()=> (await second.listHistory()).some(row=>row.includes('INPUT_DONE'))).toBe(true);
        const history=await second.listHistory();expect(history.some(row=>row.includes('HISTORY_READY'))).toBe(true);
        expect(history.some(row=>row.includes('MULTI_%s')&&row.includes('\n'))).toBe(true);
        expect(history.join('\n')).not.toContain('private-password-value');
        expect(JSON.stringify(getLogger().query({modules:['server-terminal']}))).not.toContain('private-password-value');
        await session.dispose(); await first.dispose(); await second.dispose();
        const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
        const script="import {NodeServerTerminals} from '../node-host/src/terminal/server-terminals.ts'; const host=new NodeServerTerminals(process.argv[1]); const commands=await host.listCommands(), history=await host.listHistory(); console.log(JSON.stringify({commands:commands.length,history:history.some(row=>row.includes('HISTORY_READY'))})); await host.dispose();";
        const restarted=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script,directory],{timeout:15000});
        expect(JSON.parse(restarted.stdout.trim())).toEqual({commands:1,history:true});
        const reopened=new NodeServerTerminals(directory);
        try {
            expect(await reopened.listCommands()).toHaveLength(1);expect(await reopened.listHistory()).toEqual(history);
            const again=await reopened.openTerminal(), start=await outputUntil(again,/[$#] /);
            await again.sendInput("printf 'RESTART_NEW\\n'\r");await outputUntil(again,/RESTART_NEW\r?\n/,start.cursor);
            await expect.poll(async()=> (await reopened.listHistory())[0]?.includes('RESTART_NEW')).toBe(true);
            expect((await reopened.listHistory()).filter(row=>row.includes('HISTORY_READY'))).toHaveLength(1);
            await again.sendInput('exit 7\r');await expect.poll(async()=> (await again.readOutput(0)).exited).toBe(true);
            expect((await again.readOutput(0)).exitCode).toBe(7);
        } finally {await reopened.dispose();}
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        for (const name of await readdir(directory)) expect((await stat(path.join(directory,name))).mode & 0o077).toBe(0);
    } finally {await first.dispose();await second.dispose();await rm(directory,{recursive:true,force:true});}
}, 20000);

it('merges consecutive history and preserves commands across concurrent terminals', async () => {
    const {mkdtemp,mkdir,readFile,rm} = await import('node:fs/promises'); const path = await import('node:path');
    const base=path.resolve('../../_nestos/kanban/artifacts/terminal-tests');await mkdir(base,{recursive:true});
    const directory=await mkdtemp(path.join(base,'concurrent-'));
    const first=new NodeServerTerminals(directory), second=new NodeServerTerminals(directory);
    try {
        const a=await first.openTerminal(),b=await second.openTerminal();
        const [startA,startB]=await Promise.all([outputUntil(a,/[$#] /),outputUntil(b,/[$#] /)]);
        await a.sendInput("printf 'A_FIRST\\n'\r"); await outputUntil(a,/A_FIRST\r?\n/,startA.cursor);
        await expect.poll(async()=> (await first.listHistory()).some(row=>row.includes('A_FIRST'))).toBe(true);
        await b.sendInput("printf 'B_MIDDLE\\n'\r"); await outputUntil(b,/B_MIDDLE\r?\n/,startB.cursor);
        await expect.poll(async()=> (await first.listHistory())[0]?.includes('B_MIDDLE')).toBe(true);
        await a.sendInput("printf 'A_FIRST\\n'\r");
        await expect.poll(async()=> (await first.listHistory()).filter(row=>row.includes('A_FIRST')).length).toBe(2);
        await a.sendInput("printf 'A_FIRST\\n'\r");
        await expect.poll(async()=> ((await readFile(path.join(directory,'history'),'utf8')).match(/A_FIRST/g)??[]).length).toBe(3);
        const rows=await first.listHistory();expect(rows.filter(row=>row.includes('A_FIRST'))).toHaveLength(2);
        for(let i=0;i<35;i++) await b.sendInput(`printf 'LIMIT_${String(i).padStart(2,'0')}\\n'\r`);
        await expect.poll(async()=> (await second.listHistory())[0]?.includes('LIMIT_34'),{timeout:10000}).toBe(true);
        const latest=await second.listHistory();expect(latest).toHaveLength(30);expect(latest.at(-1)).toContain('LIMIT_05');
        await first.dispose();await second.dispose();
    } finally {await first.dispose();await second.dispose();await rm(directory,{recursive:true,force:true});}
},30000);

it('rejects a symlink in private terminal storage without exposing its target', async () => {
    const {mkdtemp,mkdir,symlink,rm}=await import('node:fs/promises');const path=await import('node:path');
    const base=path.resolve('../../_nestos/kanban/artifacts/terminal-tests');await mkdir(base,{recursive:true});
    const directory=await mkdtemp(path.join(base,'invalid-')),host=new NodeServerTerminals(directory);
    try {
        await symlink('/etc/passwd',path.join(directory,'commands.json'));
        await expect(host.listCommands()).rejects.toMatchObject({code:'EIO'});
    } finally {await host.dispose();await rm(directory,{recursive:true,force:true});}
});
