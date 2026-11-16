import {verifyConfinement} from './fixtures/html-confinement-cases.mjs';
import {verifyHtmlWebHost} from './fixtures/html-preview-host.mjs';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, join, extname} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {withTemporaryScope, processOutput} from '../tools/temporary-process/node/index.mjs';

const root = process.cwd(), artifacts = resolve(root, '_nestos/kanban/artifacts/html-preview');
const original = '<!doctype html><html><head><style>button{color:rgb(1,2,3)}</style></head><body><button onclick="this.textContent=\'clicked\'">Try</button><script>window.inlineWorks=true;document.body.dataset.inlineWorks="yes"</script></body></html>';

async function bundle() {
    const require = createRequire(import.meta.url), vite = createRequire(require.resolve('vite/package.json'));
    vite('esbuild').buildSync({entryPoints: ['scripts/fixtures/html-preview.ts'], bundle: true, format: 'esm', splitting: true,
        outdir: join(artifacts, 'site'), logLevel: 'warning'});
}
async function createFixtureServer(state) {
    const {requests, saves} = state;
    const server = createServer(async (req, res) => {
        requests.push(req.url);
        if (req.url === '/document') {res.end(original); return;}
        if (req.url === '/save') {
            let body = ''; for await (const chunk of req) body += chunk;
            saves.push(JSON.parse(body)); res.statusCode = state.rejectSave ? 409 : 200; res.end(); return;
        }
        if (req.url === '/') {
            res.setHeader('Set-Cookie', 'session=fixture-host-secret; SameSite=Strict');
            res.end('<!doctype html><link rel="stylesheet" href="/html-preview.css"><button id="open">Open</button><main></main><script type="module">import "/html-preview.js";document.querySelector("#open").onclick=async()=>{window.openStarted=performance.now();const text=await(await fetch("/document")).text();await window.htmlFixture.open("/page.HtMl",text);window.openFinished=performance.now();};</script>'); return;
        }
        const name = req.url?.slice(1);
        if (!name || !/^[\w.-]+$/.test(name)) {res.statusCode = 404; res.end(); return;}
        try {res.setHeader('Content-Type', extname(name) === '.css' ? 'text/css' : 'text/javascript'); res.end(await readFile(join(artifacts, 'site', name)));}
        catch {res.statusCode = 404; res.end();}
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return server;
}
async function measure(page, requests) {
    const metrics = [];
    for (const temperature of ['cold-document', 'warm-document']) {
        const before = requests.length;
        await page.evaluate(() => {delete window.openFinished;}); await page.click('#open');
        await page.waitForFunction(() => window.openFinished);
        const elapsed = await page.evaluate(() => window.openFinished - window.openStarted);
        const http = requests.slice(before), rpc = http.filter(path => ['/document', '/save'].includes(path)).length;
        assert(elapsed < 5000 && rpc < 30);
        metrics.push({temperature, durationMs: elapsed, logicalRpc: rpc, httpRequests: http.length});
    }
    return metrics;
}
async function verifyInteraction(page) {
    const child = page.frames().find(frame => frame.parentFrame()?.parentFrame());
    assert.equal(await child.locator('body').getAttribute('data-inline-works'), 'yes');
    assert.equal(await child.evaluate(() => window.inlineWorks), undefined, 'authored JS must not execute in the browser realm');
    assert.equal(await child.locator('button').evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
    await child.locator('button').click(); assert.equal(await child.locator('button').textContent(), 'clicked');
    assert.equal((await page.evaluate(() => window.htmlFixture.state())).text, original);
}
async function verifyModes(page, state) {
    const {saves} = state;
    await page.evaluate(() => window.htmlFixture.mode('edit'));
    assert.equal(await page.locator('main iframe').count(), 0);
    const changed = original.replace('Try', 'Changed');
    await page.evaluate(text => window.htmlFixture.save(text), changed); assert.equal(saves.at(-1).content, changed);
    assert.equal((await page.evaluate(() => window.htmlFixture.state())).dirty, false);
    state.rejectSave = true;
    const failed = await page.evaluate(async () => {try {await window.htmlFixture.save('retained');return false;} catch {return window.htmlFixture.state().dirty;}});
    assert(failed); state.rejectSave = false; await page.evaluate(text => window.htmlFixture.save(text), changed);
    await page.evaluate(() => window.htmlFixture.mode('render'));
    const previous = page.frames().find(frame => frame.parentFrame()?.parentFrame());
    await page.getByRole('button', {name: '刷新预览'}).click(); await page.waitForTimeout(80); assert(previous.isDetached());
    await page.evaluate(() => window.htmlFixture.rename('/page.txt')); await page.waitForTimeout(30);
    assert.equal((await page.evaluate(() => window.htmlFixture.state())).mode, 'edit');
    assert.equal(await page.locator('main iframe').count(), 0);
    await page.evaluate(() => window.htmlFixture.rename('/page.HTM')); await page.waitForTimeout(80);
    assert.equal((await page.evaluate(() => window.htmlFixture.state())).format, 'html');
    await page.evaluate(() => window.htmlFixture.rename('/page.mind')); await page.waitForTimeout(80);
    assert.equal((await page.evaluate(() => window.htmlFixture.state())).format, 'markdown');
}
function attackScripts(attack) {
    return [
        `fetch('${attack}')`, `new Image().src='${attack}'`, `navigator.sendBeacon('${attack}','x')`,
        `new XMLHttpRequest()`, `new WebSocket('${attack.replace('http:', 'ws:')}')`, `new EventSource('${attack}')`,
        `new Worker('${attack}')`, `new SharedWorker('${attack}')`, `import('${attack}').catch(()=>{})`,
        `location.href='${attack}'`, `location.replace('${attack}')`,
        `const m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url=${attack}';document.head.append(m)`,
        `const a=document.createElement('a');a.href='${attack}';document.body.append(a);a.click()`,
        `const f=document.createElement('form');f.action='${attack}';document.body.append(f);f.submit()`,
        `window.open('${attack}');top.location.href='${attack}'`,
        `parent.location.href='${attack}'`,
        `const a=document.createElement('a');a.href='${attack}';a.download='file';document.body.append(a);a.click()`,
        `const b=new Blob(['<script>fetch("${attack}")<'+ '/script>'],{type:'text/html'});location.href=URL.createObjectURL(b)`,
        `location.href='data:text/html,<script>fetch("${attack}")<'+ '/script>'`,
        `document.open();document.write('<script>fetch("${attack}")<'+ '/script>');document.close()`,
        `const f=document.createElement('iframe');f.srcdoc='<script>fetch("${attack}")<'+ '/script>';document.body.append(f)`,
    ];
}
async function verifyAttacks(page, requests, origin) {
    const scripts = attackScripts(origin + '/attack');
    for (const script of scripts) {
        await page.evaluate(async source => window.htmlFixture.open('/attack.html', source),
            '<!doctype html><body><script>setTimeout(()=>{' + script + '},30)</script>');
        await page.waitForTimeout(150);
    }
    assert(!requests.some(url => url.includes('/attack')), 'untrusted preview emitted a request');
    assert.equal(page.url(), origin + '/');
    return scripts.length;
}
async function verifyFailureAndDestroy(page) {
    await page.evaluate(() => window.htmlFixture.open('/broken.html', '<script>throw Error("private-body")</script>'));
    await page.waitForTimeout(50); assert.match(await page.locator('.mdx-html-preview__toolbar [role=status]').textContent(), /脚本执行出错/);
    await page.evaluate(() => window.htmlFixture.destroy()); assert.equal(await page.locator('main iframe').count(), 0);
}
async function saveReport(browser, metrics, securityCases, popups, downloads, confinement) {
    const report = {result: 'passed', version: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        source: 'dirty worktree', browser: browser.version(), dataset: {documents: 1, bytes: Buffer.byteLength(original)},
        backgroundLoad: process.env.HTML_PREVIEW_BACKGROUND_LOAD ?? 'not recorded', boundary: 'real browser shell format + adapter + core; fixture HTTP read/save; module loaded before click',
        metrics, securityCases, confinement, popups, downloads, attackRequests: 0, framesAfterDestroy: 0};
    await writeFile(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
async function run() {
    await bundle();
    const {chromium} = await import(process.env.HTML_PREVIEW_PLAYWRIGHT ?? 'playwright');
    const state = {requests: [], saves: [], rejectSave: false};
    const server = await createFixtureServer(state), origin = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({args: ['--no-sandbox'], env: {...process.env, TMPDIR: artifacts}});
    let popups = 0, downloads = 0;
    try {
        const context = await browser.newContext(), page = await context.newPage();
        await page.addInitScript(() => {
            const active = new Set(), originalSet = window.setTimeout, originalClear = window.clearTimeout;
            window.__htmlTimers = active;
            window.setTimeout = (callback, delay, ...args) => {const id = originalSet(() => {active.delete(id); callback(...args);}, delay); active.add(id); return id;};
            window.clearTimeout = id => {active.delete(id); originalClear(id);};
        });
        page.on('popup', () => popups++); page.on('download', () => downloads++);
        await page.goto(origin); await page.waitForFunction(() => window.htmlFixture);
        const metrics = await measure(page, state.requests);
        await verifyInteraction(page); await verifyModes(page, state);
        const securityCases = await verifyAttacks(page, state.requests, origin);
        assert.equal(popups, 0); assert.equal(downloads, 0);
        const confinement = await verifyConfinement(page, state.requests, origin);
        await verifyFailureAndDestroy(page);
        await saveReport(browser, metrics, securityCases, popups, downloads, confinement);
    } finally {await browser.close(); await new Promise(r => server.close(r));}
}

if (!process.argv.includes('--driver')) {
    await withTemporaryScope({scopeId: 'html-preview-browser', directory: join(artifacts, 'processes')}, async scope => {
        const result = await (await scope.start(process.execPath, [resolve('scripts/verify-html-preview.mjs'), '--driver', ...process.argv.slice(2)],
            {cwd: root, timeoutMs: 180000})).result;
        const output = await processOutput(join(artifacts, 'processes'), result.id);
        await writeFile(join(artifacts, 'browser.log'), output.output);
        if (result.outcome !== 'succeeded') throw new Error('HTML_BROWSER_FAILED: ' + output.output.slice(-6000));
        console.log(output.output);
    });
    console.log(JSON.stringify({operation: 'html.preview.browser', result: 'success', cleanup: 'confirmed'}));
} else {
    await run();
    const {chromium} = await import(process.env.HTML_PREVIEW_PLAYWRIGHT ?? 'playwright');
    if (!process.argv.includes('--component')) await verifyHtmlWebHost(chromium);
}

