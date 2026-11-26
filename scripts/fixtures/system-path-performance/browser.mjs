import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [readyPath, outputPath, browserPath, playwrightPath] = process.argv.slice(2);
const ready = JSON.parse(await readFile(readyPath,'utf8'));
const {chromium} = await import(pathToFileURL(playwrightPath).href);
// Chrome's Unix socket must fit within Linux's sockaddr_un limit.
process.env.TMPDIR = '/tmp';
const browser = await chromium.launch({executablePath:browserPath,headless:true,chromiumSandbox:true,args:['--disable-dev-shm-usage']});
const context = await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900},clientCertificates:[{origin:ready.origin,
    certPath:path.join(ready.certs,'client.crt'),keyPath:path.join(ready.certs,'client.key')}]});
const page = await context.newPage(); const requests = [], errors = [];
let measuring = false, stage = 'session-open', wallStart = 0, wallEnd = 0;
page.on('request', request => {
    if (!measuring) return;
    const url = new URL(request.url()); let logical = 0, unknown = false;
    if (url.pathname === '/api/application' && request.method() === 'POST') {
        try {const packet = JSON.parse(request.postData() ?? '');
            if (['queries','bindings'].includes(packet.kind)) {if (!Array.isArray(packet.calls) || !packet.calls.length) unknown = true; else logical = packet.calls.length;}
            else if (packet.kind === 'call' && packet.call?.method || ['bootstrap','bootstrap-data','updates-read','close','reply'].includes(packet.kind)) logical = 1;
            else unknown = true;
        } catch {unknown = true;}
    } else if (url.pathname.startsWith('/api/') && !url.pathname.includes('/events')) logical = 1;
    requests.push({logical,unknown});
});
page.on('pageerror', () => {if (measuring) errors.push('PAGE_ERROR');});
page.on('response', response => {if (measuring && response.status() >= 400) errors.push(`HTTP_${response.status()}`);});
page.on('requestfailed', () => {if (measuring) errors.push('REQUEST_FAILED');});
try {
    await page.goto(ready.origin + '/#/workbench/' + encodeURIComponent(ready.resource), {waitUntil:'domcontentloaded',timeout:30000});
    const link = page.getByRole('link', {name:ready.displayedPath, exact:true});
    await link.waitFor({state:'visible',timeout:45000});
    await page.locator('.llm-chat__input').waitFor({state:'visible',timeout:30000});
    stage = 'path-click'; wallStart = Date.now(); const started = performance.now(); measuring = true;
    await link.click();
    const panel = page.locator('.workbench-tabs__panel:not([hidden])');
    await panel.locator('.cm-content[contenteditable=true]').waitFor({state:'visible',timeout:30000});
    await panel.locator('.cm-activeLine').filter({hasText:ready.expectedLine}).waitFor({state:'visible',timeout:30000});
    const durationMs = performance.now() - started; wallEnd = Date.now(); measuring = false; stage = 'https-link-visible';
    // Use a new document for the independent HTTPS-link check.
    await page.goto(ready.origin + '/?verify=https-path#/workbench/' + encodeURIComponent(ready.resource), {waitUntil:'domcontentloaded',timeout:30000});
    const httpsLink = page.getByRole('link', {name:ready.httpsPath, exact:true});
    await httpsLink.waitFor({state:'visible',timeout:15000});
    stage = 'https-link-click'; await httpsLink.click();
    stage = 'https-file-open';
    const httpsPanel = page.locator('.workbench-tabs__panel:not([hidden])');
    await httpsPanel.locator('.cm-content[contenteditable=true]').waitFor({state:'visible',timeout:30000});
    await httpsPanel.locator('.cm-activeLine').filter({hasText:ready.expectedLine}).waitFor({state:'visible',timeout:30000});
    await writeFile(outputPath, JSON.stringify({completed:true,httpsVerified:true,durationMs,apiCalls:requests.reduce((n,r)=>n+r.logical,0),
        httpRequests:requests.length,unknownRequests:requests.filter(r=>r.unknown).length,errors,wallStart,wallEnd,
        dataset:'one-remote-one-local-one-session-one-40-line-file-v1',scope:'https-session-path-click',backgroundLoad:'fixture-server-normal; host load unmeasured',
        browserVersion:browser.version(), cache:'fresh-browser-context-session-loaded-server-warm'},null,2));
} catch (error) {
    measuring = false;
    const failure = error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED';
    await writeFile(outputPath,JSON.stringify({completed:false,httpsVerified:false,durationMs:null,apiCalls:requests.reduce((n,r)=>n+r.logical,0),
        httpRequests:requests.length,unknownRequests:requests.filter(r=>r.unknown).length,errors:[...errors,`SCENARIO_${stage}_${failure}`],wallStart,wallEnd,
        dataset:'one-remote-one-local-one-session-one-40-line-file-v1',scope:'https-session-path-click',
        backgroundLoad:'fixture-server-normal; host load unmeasured',browserVersion:browser.version(),cache:'fresh-browser-context-session-loaded-server-warm'},null,2));
} finally {await context.close(); await browser.close();}
