import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { nestosReadRequest } from './read-policy.mjs';

const fail = code => Object.assign(new Error(code), { code });

async function apply(page, steps) {
    for (const step of steps) {
        const element = page.getByRole(step.role, { name: step.name, exact: true });
        if (step.action === 'click') await element.click();
        else if (step.action === 'fill') await element.fill(step.value);
    }
    for (let attempt = 0; attempt < 12; attempt++) {
        const snapshot = await page.locator('body').ariaSnapshot({ timeout: 1000 });
        if (snapshot.trim()) return snapshot.slice(0, 24000);
        await setTimeout(200);
    }
    throw fail('BROWSER_EMPTY_VIEW');
}

async function run(config, { steps, path, readOnly }) {
    const target = path ? new URL(path, config.target) : new URL(config.target);
    const browser = await chromium.launch({
        executablePath: config.chrome, headless: true, chromiumSandbox: true, timeout: 8000,
        args: ['--disable-dev-shm-usage'],
    }).catch(error => {
        if (/sandbox|namespace/i.test(error.message) && error.name !== 'TimeoutError') {
            throw fail('BROWSER_SANDBOX_FAILED');
        }
        throw fail(error.name === 'TimeoutError' ? 'BROWSER_LAUNCH_TIMEOUT' : 'BROWSER_LAUNCH_FAILED');
    });
    try {
        const context = await browser.newContext({
            clientCertificates: [{ origin: target.origin, certPath: config.cert, keyPath: config.key }],
            acceptDownloads: false, serviceWorkers: 'block',
        });
        await context.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            return url.origin === target.origin && (!readOnly || nestosReadRequest(request, url))
                ? route.continue() : route.abort();
        });
        await context.routeWebSocket('**/*', ws => ws.close());
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 8000 })
            .catch(error => { throw error.name === 'TimeoutError' ? fail('BROWSER_NAVIGATION_TIMEOUT') : error; });
        if (!response?.ok()) throw fail('BROWSER_HTTP_' + (response?.status() ?? 'NO_RESPONSE'));
        await page.locator(config.readySelector).first().waitFor({ state: 'attached', timeout: 6500 })
            .catch(error => { throw error.name === 'TimeoutError' ? fail('BROWSER_WORKBENCH_TIMEOUT') : error; });
        const snapshot = await apply(page, steps);
        return { status: response.status(), snapshot };
    } finally {
        await browser.close();
    }
}

const [configFile, inputFile, resultFile] = process.argv.slice(2);
try {
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    const input = JSON.parse(await readFile(inputFile, 'utf8'));
    await writeFile(resultFile, JSON.stringify(await run(config, input)), { mode: 0o600 });
} catch (error) {
    const code = typeof error.code === 'string' && /^BROWSER_/.test(error.code)
        ? error.code : error.name === 'TimeoutError' ? 'BROWSER_TARGET_TIMEOUT' : 'BROWSER_EXECUTION_FAILED';
    await writeFile(resultFile, JSON.stringify({ code }), { mode: 0o600 });
}
// The result is durable and the browser has closed. End the worker even if the
// client-certificate proxy retains a connection or an event-loop handle.
process.exit(0);
