import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {z} from 'zod/v4';
import {MemoryBackend} from '@nestos/vfs-core';
import {buildTool} from '@nestos/tools';
import {createApplicationRuntime} from '@nestos/app-core';
import {processTool} from '../src/runtime/tool-worker/tool';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
it('checkpoints the scanner, stops its real process and reconciles the original Task after restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-scanner-worker-')); cleanup.push(() => rm(root, {recursive: true, force: true}));
    const module = path.join(root, 'collector.mjs');
    await writeFile(module, `export function createTools(){return [{name:'isolated-collector',version:'1',async call(args,ctx){
      await ctx.vfs.writeFile('evidence/resume.md','durable evidence');
      await ctx.putAssetRecord('receipt',{operationId:ctx.executionIdentity.operationId,pid:process.pid});
      await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));
      throw new Error('unreachable');
    },async reconcile(args,ctx){const receipt=await ctx.getAssetRecord('receipt');
      if(await ctx.vfs.readFile('evidence/resume.md')!=='durable evidence')throw new Error('file mismatch');
      if(!receipt||receipt.operationId!==ctx.executionIdentity.operationId)throw new Error('receipt mismatch');
      return {status:'completed',data:{collection:{version:1,complete:true,processed:1}}};}}];}`);
    let started!: (value: {pid: number; operationId: string}) => void;
    const admitted = new Promise<{pid: number; operationId: string}>(resolve => {started = resolve;});
    const base = buildTool({name: 'isolated-collector', version: '1', inputSchema: z.object({}), async description() {return 'Collector';}, async prompt() {return '';},
        async call() {throw new Error('Business code must run outside the host');}, async reconcile() {return {status: 'indeterminate' as const};},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const isolated = processTool(base, {module, graceMs: 200});
    const invoke = vi.fn(async (args, context) => isolated.call(args, {...context, putAssetRecord: async (key, value) => {
        await context.putAssetRecord!(key, value); started(value as {pid: number; operationId: string});
    }}));
    const tool = new Proxy(isolated, {get(target, key) {return key === 'call' ? invoke : Reflect.get(target, key, target);}});
    const backend = new MemoryBackend(), close = backend.close.bind(backend); backend.close = async () => {}; cleanup.push(close);
    const options = {backend, ownerKind: 'cli' as const, digitalTwinAutoStart: false, kernelPlatform: {additionalTools: [tool]}};
    const runtime = await createApplicationRuntime(options); cleanup.push(() => runtime.dispose());
    const twin = runtime.digitalTwin!, target = (await twin.collectionTools()).find(row => row.target.id === tool.name)!.target;
    const plan = await twin.saveScanRule(null, null, {name: 'Isolated collector', collection: {target}, mode: 'collect', include: [], exclude: [], intervalMinutes: 30, enabled: true, trigger: 'manual'});
    const id = await twin.runScanPlan(plan), scanning = twin.scanOnce();
    const receipt = await admitted; expect(receipt.pid).not.toBe(process.pid);
    const at = Date.now(); await runtime.quiesce(); await scanning;
    expect(Date.now() - at).toBeLessThan(5000); expect(() => process.kill(receipt.pid, 0)).toThrow();
    expect((await twin.snapshot()).scans.runs.find(row => row.id === id)!.data).toMatchObject({state: 'queued'});
    await runtime.dispose();
    const next = await createApplicationRuntime(options); cleanup.push(() => next.dispose());
    await next.digitalTwin!.waitScanRun(id);
    const run = (await next.digitalTwin!.snapshot()).scans.runs.find(row => row.id === id)!;
    expect(run.data).toMatchObject({state: 'succeeded', collectionProgress: {complete: true, processed: 1}});
    expect(invoke).toHaveBeenCalledOnce();
}, 30000);
