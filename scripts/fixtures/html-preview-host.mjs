import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, join, extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const artifact = resolve('_nestos/kanban/artifacts/html-preview');
const source = '<!doctype html><style>button{color:rgb(1,2,3)}</style><button onclick="this.textContent=\'clicked\'">Try</button>';

async function hostServer() {
    const directory = resolve('apps/web-app/dist');
    await readFile(join(directory, 'index.html'));
    const requests = [];
    const server = createServer(async (req, res) => {
        requests.push(req.url);
        try {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            const path = resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
            if (!path.startsWith(directory + '/')) throw new Error('FIXTURE_INVALID_PATH');
            const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml'};
            res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
            res.end(await readFile(path));
        } catch {res.statusCode = 404; res.end();}
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return {server, requests, origin: 'http://127.0.0.1:' + server.address().port};
}

async function seedDocument(page) {
    return page.evaluate(async source => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('MindOS-v3'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const transaction = db.transaction('nodes', 'readwrite'), store = transaction.objectStore('nodes');
        const bytes = new TextEncoder().encode(source);
        store.put({path: '/home/admin/notes/fixture.HTML', parentPath: '/home/admin/notes', type: 'file', content: bytes.buffer,
            size: bytes.byteLength, createdAt: 1, modifiedAt: 1, version: 1, tags: [], metadata: '{}'});
        const count = await new Promise(resolve => {const request = store.count(); request.onsuccess = () => resolve(request.result);});
        await new Promise((resolve, reject) => {transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);});
        db.close(); return count;
    }, source);
}

async function openDocument(page, requests, temperature) {
    const row = page.locator('[data-item-id="/fixture.HTML"] [data-action="select-and-open"]');
    await row.evaluate(node => node.addEventListener('click', () => {window.htmlClickStarted = performance.now();window.htmlStorageMetrics={};}, {once: true}));
    const preexistingPreviewFrames = await page.locator('.mdx-html-preview__frame').count();
    const before = requests.length;
    await row.click();
    await page.locator('.mdx-html-preview__frame[data-html-preview-state=ready]').waitFor({timeout: 5000});
    const button = page.frameLocator('.mdx-html-preview__frame').frameLocator('iframe').locator('button');
    await button.waitFor({state: 'attached', timeout: 5000});
    await button.click(); assert.equal(await button.textContent(), 'clicked');
    const durationMs = await page.evaluate(() => performance.now() - window.htmlClickStarted);
    assert(durationMs < 5000);
    return {temperature, preexistingPreviewFrames, durationMs, logicalRpc: 0, httpRequests: requests.length - before, storage: await page.evaluate(() => window.htmlStorageMetrics)};
}

function storageProbe() {
    window.htmlStorageMetrics = {};
    for (const constructor of [IDBObjectStore, IDBIndex]) for (const method of ['get','getAll','getAllKeys','count','openCursor','openKeyCursor','put','add','delete']) {
        const original = constructor.prototype[method]; if (!original) continue;
        constructor.prototype[method] = function(...args) {
            const metrics = window.htmlStorageMetrics;
            metrics[method] = (metrics[method] ?? 0) + 1;
            const request = original.apply(this, args);
            request.addEventListener('success', () => {
                const rows = Array.isArray(request.result) ? request.result.length : request.result && typeof request.result.continue === 'function' ? 1 : 0;
                metrics.returnedRows = (metrics.returnedRows ?? 0) + rows;
            });
            return request;
        };
    }
}

/** Runs only inside the caller's managed temporary-process scope, with a fresh browser profile. */
export async function verifyHtmlWebHost(chromium) {
    const {server, requests, origin} = await hostServer();
    let browser;
    try {
        browser = await chromium.launch({args: ['--no-sandbox'], env: {...process.env, TMPDIR: artifact}});
        const context = await browser.newContext({serviceWorkers: 'block'}), page = await context.newPage();
        await page.addInitScript(storageProbe);
        await page.goto(origin); await page.waitForSelector('body:not([data-app-starting])', {timeout: 30000});
        const nodes = await seedDocument(page);
        await page.goto(origin + '/#/notes/'); await page.reload();
        await page.waitForSelector('body:not([data-app-starting])', {timeout: 30000});
        const metrics = [await openDocument(page, requests, 'cold document/editor/runtime')];
        await page.goto(origin + '/#/notes/'); await page.reload();
        await page.waitForSelector('[data-item-id="/fixture.HTML"]', {timeout:30000});
        metrics.push(await openDocument(page, requests, 'warm browser cache and storage; reloaded page'));
        const report = {result: 'passed', version: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), source: 'dirty worktree',
            boundary: 'complete production Web host, IndexedDB, actual notes-row click through successful HTML button interaction',
            metrics, dataset: {nodes, seededHtmlDocuments: 1, seededHtmlBytes: Buffer.byteLength(source)},
            state: 'cold document/editor modules; application boot completed before click',
            transport: 'in-process local application client; no logical or remote protocol RPC',
            backgroundLoad: process.env.HTML_PREVIEW_BACKGROUND_LOAD ?? 'not recorded', browser: browser.version()};
        await writeFile(join(artifact, 'full-app-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    } finally {await browser?.close(); await new Promise(r => server.close(r));}
}
