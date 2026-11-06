import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {runToolProcess} from '../src/runtime/tool-worker/process';
import type {ToolUseContext} from '@nestos/tools';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-tool-worker-')); cleanup.push(() => rm(root, {recursive: true, force: true}));
    const module = path.join(root, 'tool.mjs');
    await writeFile(module, `export function createTools(){return [{name:'worker-probe',version:'1',async call(args,ctx){
      if(args.mode==='busy'){await ctx.onProgress({message:'started',output:String(process.pid)});while(true){}}
      if(args.mode==='crash')process.exit(7);
      const text=await ctx.vfs.readFile('/file');await ctx.vfs.writeFile('/result',text+'!');
      return {data:{pid:process.pid,text,identity:ctx.executionIdentity}};
    },async reconcile(args,ctx){return {status:'completed',data:{operationId:ctx.executionIdentity.operationId}};}}];}`);
    const values = new Map([['/file', 'private document']]);
    const context: ToolUseContext = {cwd: '/', timeoutMs: 5000, operationId: 'original', executionIdentity: {operationId: 'original', sessionId: 'session', taskId: 'task', effectId: 'effect'},
        vfs: {readFile: async name => values.get(name)!, writeFile: async (name, value) => {values.set(name, value);}, listFiles: async () => [...values.keys()]}};
    return {options: {module, executables: {}, graceMs: 200}, context, values};
}
it('executes in a separate process and uses only the current invocation file ports and original identity', async () => {
    const f = await fixture();
    const result = await runToolProcess(f.options, {name: 'worker-probe'}, 'invoke', {}, f.context) as {data: {pid: number; text: string; identity: unknown}};
    expect(result.data.pid).not.toBe(process.pid); expect(result.data.text).toBe('private document'); expect(f.values.get('/result')).toBe('private document!');
    expect(result.data.identity).toEqual(f.context.executionIdentity);
    expect(() => process.kill(result.data.pid, 0)).toThrow();
    expect(await runToolProcess(f.options, {name: 'worker-probe'}, 'reconcile', {}, f.context)).toEqual({status: 'completed', data: {operationId: 'original'}});
});
it('bounds an uncooperative CPU-bound worker with TERM then KILL while the parent stays responsive', async () => {
    const f = await fixture(), controller = new AbortController(); let ready!: () => void;
    const admitted = new Promise<void>(resolve => {ready = resolve;});
    const work = runToolProcess(f.options, {name: 'worker-probe'}, 'invoke', {mode: 'busy'}, {...f.context, signal: controller.signal, onProgress: async () => {ready();}});
    const stopped = expect(work).rejects.toMatchObject({code: 'HOST_CHECKPOINT'});
    await admitted; const started = Date.now(); controller.abort(Object.assign(new Error('checkpoint'), {code: 'HOST_CHECKPOINT'}));
    await stopped; expect(Date.now() - started).toBeGreaterThanOrEqual(150); expect(Date.now() - started).toBeLessThan(5000);
});
it('reports an unexpected exit as unknown and does not retry the business call', async () => {
    const f = await fixture();
    await expect(runToolProcess(f.options, {name: 'worker-probe'}, 'invoke', {mode: 'crash'}, f.context)).rejects.toMatchObject({code: 'TOOL_WORKER_EXITED', executionOutcome: 'unknown'});
});

it('reaps a spinning business worker when its owning host crashes', async () => {
    const f = await fixture(), script = path.join(path.dirname(f.options.module), 'owner.mjs');
    const implementation = new URL('../src/runtime/tool-worker/process.ts', import.meta.url).href;
    await writeFile(script, `import {runToolProcess} from ${JSON.stringify(implementation)};
      await runToolProcess(${JSON.stringify(f.options)},{name:'worker-probe'},'invoke',{mode:'busy'},
        {cwd:'/',timeoutMs:5000,onProgress:async p=>process.send({pid:Number(p.output)})});`);
    const loader = createRequire(new URL('../../cli/package.json', import.meta.url)).resolve('tsx/esm');
    const owner = fork(script, [], {execArgv: ['--import', pathToFileURL(loader).href], stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    const exited = new Promise<void>(resolve => owner.once('exit', () => resolve()));
    cleanup.push(async () => {if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); await exited;});
    const pid = await new Promise<number>((resolve, reject) => {
        owner.once('message', value => resolve((value as {pid: number}).pid));
        owner.once('error', reject); owner.once('exit', () => reject(new Error('Owner exited before starting worker')));
    });
    owner.kill('SIGKILL'); await exited;
    await expect.poll(() => {try {process.kill(pid, 0); return false;} catch {return true;}}, {timeout: 5000}).toBe(true);
}, 10000);
