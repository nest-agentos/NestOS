import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, readlink, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {withTemporaryScope, processOutput} from '../tools/temporary-process/node/index.mjs';
import {assessPerformance} from './performance-budget.mjs';

const root = await realpath('.'), environment = await realpath(process.env.PERF_ENV ?? '_nestos/kanban/retained-environment');
const mode = process.argv[2], baselinePath = path.join(environment,'system-path-baseline.json');
const ui = await realpath(process.env.PERF_UI ?? path.join(environment,'system-path-ui'));
const cellsBinary = await realpath(process.env.PERF_CELLS ?? path.join(environment,'cells-target/debug/cells'));
const browser = process.env.KANBAN_BROWSER, playwright = process.env.PERF_PLAYWRIGHT;
if (!['baseline','current'].includes(mode) || !browser || !playwright) throw Error('MODE_OR_BROWSER_REQUIRED');
for (const value of [environment,ui,cellsBinary]) if (!value.startsWith(root + path.sep)) throw Error('WORKTREE_PATH_REQUIRED');
const registry = path.join(environment,'state/nestos/temporary-process'), runId = randomUUID();
const temporary = path.join(environment,'tmp'); await mkdir(temporary,{recursive:true,mode:0o700});
process.env.TMPDIR = await realpath(temporary);
if (!process.env.TMPDIR.startsWith(environment + path.sep)) throw Error('TEMPORARY_PATH_OUTSIDE_WORKTREE');
const fixtureFiles = ['scripts/verify-system-path-performance.mjs','scripts/performance-budget.mjs',
    'scripts/fixtures/system-path-performance/browser.mjs','apps/http-app/tests/system-path-performance-fixture.ts',
    'apps/http-app/tests/system-path-performance-storage.ts'];
const fixtureDigest = await digestFiles(root,fixtureFiles), source = await sourceVersions();
if (mode === 'baseline') {try {await lstat(baselinePath); throw Error('BASELINE_ALREADY_EXISTS');} catch (error) {if (error.code !== 'ENOENT') throw error;}}
await realpath(browser); await realpath(playwright);
const uiDigest = await digestTree(ui), binaryDigest = await digestFile(cellsBinary);
const prior = mode === 'current' ? JSON.parse(await readFile(baselinePath,'utf8')) : undefined;
if (prior && (prior.fixtureDigest !== fixtureDigest || prior.samples?.length !== 3 || prior.baselineType !== 'feature-first')) throw Error('BASELINE_NOT_COMPARABLE');
const samples = [];
await withTemporaryScope({scopeId:`system-path-perf-${runId}`,directory:registry}, async scope => {
    for (let index = 0; index < 3; index++) samples.push(await sample(scope,index));
});
const afterSource = await sourceVersions();
if (JSON.stringify(source) !== JSON.stringify(afterSource) || uiDigest !== await digestTree(ui) || binaryDigest !== await digestFile(cellsBinary)) throw Error('SOURCE_CHANGED_DURING_MEASUREMENT');
const gates = samples.map((sample,index) => assessPerformance(sample,prior?.samples[index]));
const passed = gates.every(gate => gate.passed) && samples.every(row => !row.errors.length && row.cellsRequests >= 1 && !row.cellsFailures && row.apiCalls >= 1 && row.httpsVerified === true);
const result = {schema:'system-path-performance/1',baselineType:'feature-first',fixtureDigest,source,uiDigest,binaryDigest,
    samples,gates,passed,cleanup:'confirmed',nodeVersion:process.version,platform:process.platform,arch:process.arch,createdAt:new Date().toISOString()};
const output = mode === 'baseline' && passed ? baselinePath : path.join(environment,`system-path-${passed?'current':'failed'}-${runId}.json`);
const file = await open(output,'wx',0o600); try {await file.writeFile(JSON.stringify(result,null,2)); await file.sync();} finally {await file.close();}
console.log(JSON.stringify({operation:'system-path-performance',mode,result:passed?'success':'failure',cleanup:'confirmed',output,samples,gates}));
if (!passed) process.exitCode = 1;

async function sample(scope, index) {
    const directory = path.join(environment,`system-path-${runId}-${index}`), work = path.join(directory,'work');
    const sourceFile = path.join(work,'tools/cells/src/http/agent_mcp.rs');
    await mkdir(path.dirname(sourceFile),{recursive:true});
    for (const name of ['catalog','tool-data','tool-config']) await mkdir(path.join(directory,name),{recursive:true});
    const content = Array.from({length:40},(_,i)=>i===25?'// PATH_FIXTURE_LINE_26':`// fixture line ${i+1}`).join('\n')+'\n';
    await writeFile(sourceFile,content);
    const config = path.join(directory,'cells.toml');
    await writeFile(config,`listen="127.0.0.1:0"\nserver_id="system-path-fixture"\ntoken="fixture-system-path-token-at-least-24-bytes"\nexecution=true\n[projects]\nroot=${JSON.stringify(path.join(directory,'catalog'))}\nisolation="bubblewrap"\n[[exports]]\nalias="work"\npath=${JSON.stringify(work)}\naccess="rw"\n`);
    const cells = await scope.start(cellsBinary,[config],{cwd:root,timeoutMs:300000});
    try {
        const endpoint = await waitForCells(cells);
        const fixture = await scope.start(process.execPath,
            ['--import','tsx','tests/system-path-performance-fixture.ts',directory,ui,endpoint,work],
            {cwd:path.join(root,'apps/http-app'),timeoutMs:240000});
        let result;
        try {
            const ready = path.join(directory,'ready.json'); await waitForFile(ready,fixture);
            const output = path.join(directory,'browser-result.json');
            const driver = await scope.start(process.execPath,[path.join(root,'scripts/fixtures/system-path-performance/browser.mjs'),ready,output,browser,playwright],{cwd:root,timeoutMs:120000});
            const receipt = await driver.result;
            if (receipt.outcome !== 'succeeded') throw Error(`BROWSER_FAILED resource=${driver.id} outcome=${receipt.outcome}`);
            result = JSON.parse(await readFile(output,'utf8'));
        } finally {
            await writeFile(path.join(directory,'stop'),'');
            const receipt = await fixture.result;
            if (receipt.outcome !== 'succeeded') throw Error(`FIXTURE_STOP_FAILED resource=${fixture.id} outcome=${receipt.outcome}`);
        }
        const audit = JSON.parse(await readFile(path.join(directory,'audit.json'),'utf8'));
        const cellsRequests = audit.events.filter(event => event.event === 'cells.request' && event.timestamp >= result.wallStart && event.timestamp <= result.wallEnd);
        const storage = audit.storageEvents.filter(event=>event.timestamp >= result.wallStart && event.timestamp <= result.wallEnd);
        const storageSummary = {operations:storage.reduce((counts,e)=>{const key=e.source+'.'+e.method;counts[key]=(counts[key]??0)+1;return counts;},{}),
            returnedEntries:storage.reduce((n,e)=>n+e.returned,0),fileBytesRead:storage.filter(e=>e.source==='fs').reduce((n,e)=>n+e.bytes,0),
            fileBytesWritten:storage.filter(e=>e.source==='fs').reduce((n,e)=>n+e.bytesWritten,0),
            scope:'host-port-calls-and-returned-items; physical-disk-scan-and-cells-storage-unmeasured'};
        delete result.wallStart; delete result.wallEnd;
        return {...result,cellsRequests:cellsRequests.length,cellsFailures:cellsRequests.filter(event=>event.result==='failure').length,storage:storageSummary,sample:index+1};
    } finally {await cells.stop();}
}
async function waitForCells(handle) {
    let ended; void handle.result.then(value=>{ended=value;},()=>{ended={outcome:'failed'};});
    for (let i=0;i<600&&!ended;i++) {
        const output = await processOutput(registry,handle.id).catch(()=>({output:''}));
        const match = output.output.match(/cells listening on (127\.0\.0\.1:\d+)/);
        if (match) return `http://${match[1]}`;
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('CELLS_NOT_READY');
}
async function waitForFile(file,handle) {
    let ended; void handle.result.then(value=>{ended=value;},()=>{ended={outcome:'failed'};});
    for (let i=0;i<600&&!ended;i++) {try {await readFile(file); return;} catch {await new Promise(resolve=>setTimeout(resolve,100));}}
    throw Error(`FIXTURE_NOT_READY resource=${handle.id}`);
}
async function digestFile(file) {const hash=createHash('sha256');for await (const chunk of createReadStream(file)) hash.update(chunk);return hash.digest('hex');}
async function digestFiles(base,files) {
    const hash = createHash('sha256');
    for (const name of files) {hash.update(name); hash.update(await readFile(path.join(base,name)));}
    return hash.digest('hex');
}
async function digestTree(directory) {
    const hash = createHash('sha256');
    async function visit(relative) {
        for (const entry of (await readdir(path.join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
            const name = path.join(relative,entry.name), full = path.join(directory,name); hash.update(name);
            if (entry.isSymbolicLink()) throw Error('UI_SYMLINK_NOT_ALLOWED');
            if (entry.isDirectory()) await visit(name); else if (entry.isFile()) hash.update(await readFile(full));
        }
    }
    await visit(''); return hash.digest('hex');
}
async function sourceVersions() {
    const repositories = ['.','tools/cells','libraries/cells-driver','libraries/llm-ui'], versions = {};
    for (const repo of repositories) {
        const cwd = path.join(root,repo), git = (...args) => execFileSync('git',args,{cwd,maxBuffer:32*1024*1024});
        const head = git('rev-parse','HEAD').toString().trim(), hash = createHash('sha256');
        hash.update(git('diff','--binary','HEAD')); hash.update(git('status','--porcelain=v1','-z'));
        const untracked = git('ls-files','--others','--exclude-standard','-z').toString().split('\0').filter(Boolean).sort();
        for (const name of untracked) {const file = path.join(cwd,name), stat = await lstat(file); hash.update(name);
            if (stat.isSymbolicLink()) hash.update(await readlink(file)); else if (stat.isFile()) hash.update(await readFile(file));}
        versions[repo] = {head,worktreeDigest:hash.digest('hex')};
    }
    return versions;
}
