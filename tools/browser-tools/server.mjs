import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTemporaryScope } from '../temporary-process/node/index.mjs';

const fail = code => Object.assign(new Error(code), { code });
const version = '2026-07-28';
const info = { name: 'managed-browser', version: '0.1.0' };
const readTool = {
    name: 'browser_read',
    description: 'Read the accessibility tree of a NestOS page. Use this tool before requesting browser_operate for a click or fill.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', maxLength: 2048, description: 'Use / for the workbench home or /#/… for a NestOS route.' },
    } },
};
const writeTool = {
    name: 'browser_operate',
    description: 'Open the authorized NestOS workbench in a temporary browser, optionally at a workbench hash route, then perform steps and read the accessibility tree. Each call starts a fresh browser.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', maxLength: 2048, description: 'Use / for the workbench home or /#/… for a NestOS route.' },
        steps: { type: 'array', maxItems: 8, items: { type: 'object',
            additionalProperties: false, required: ['action', 'role', 'name'],
            properties: { action: { enum: ['click', 'fill'] }, role: { type: 'string', maxLength: 32 },
                name: { type: 'string', maxLength: 256 }, value: { type: 'string', maxLength: 8000 } } } },
    } },
};

const configFile = process.argv[2];
const config = JSON.parse(await readFile(configFile, 'utf8'));
const credential = Buffer.from((await readFile(config.tokenFile, 'utf8')).trim());
if (credential.length < 32 || !config.readySelector || !Number.isInteger(config.port)
    || new URL(config.target).origin !== 'https://127.0.0.1:2000') {
    throw fail('BROWSER_SERVICE_CONFIG_INVALID');
}

let active = false;
function validate(args, readOnly) {
    if (readOnly && args?.steps !== undefined) throw fail('BROWSER_READ_STEPS_FORBIDDEN');
    const steps = args?.steps ?? [];
    const path = args?.path;
    if (path !== undefined && (typeof path !== 'string' || path.length > 2048
        || (path !== '/' && !path.startsWith('/#/')) || /[\x00-\x20\x7f\\]/.test(path))) {
        throw fail('BROWSER_PATH_INVALID');
    }
    const valid = args && typeof args === 'object' && !Array.isArray(args)
        && Object.keys(args).every(key => key === 'steps' || key === 'path')
        && Array.isArray(steps) && steps.length <= 8 && steps.every(step =>
        step && ['click', 'fill'].includes(step.action)
        && Object.keys(step).every(key => ['action', 'role', 'name', 'value'].includes(key))
        && typeof step.role === 'string' && /^[a-z]+$/.test(step.role) && step.role.length <= 32
        && typeof step.name === 'string' && step.name.length <= 256
        && (step.action === 'click' || (typeof step.value === 'string' && step.value.length <= 8000)));
    if (!valid) throw fail('BROWSER_STEPS_INVALID');
    return { steps, path, readOnly };
}

async function execute(inputData, operationId, signal) {
    const dir = await mkdtemp(join(tmpdir(), 'managed-browser-'));
    try {
        const input = join(dir, 'input.json'), result = join(dir, 'result.json');
        await writeFile(input, JSON.stringify(inputData), { mode: 0o600 });
        await withTemporaryScope({ scopeId: operationId, signal }, async scope => {
            const script = fileURLToPath(new URL('./browser.mjs', import.meta.url));
            const child = await scope.start(process.execPath, [script, configFile, input, result], { timeoutMs: 35000 });
            const receipt = await child.result;
            if (receipt.outcome !== 'succeeded') {
                throw fail(receipt.reason === 'deadline' ? 'BROWSER_PROCESS_TIMEOUT' : receipt.code ?? 'BROWSER_PROCESS_FAILED');
            }
        });
        return JSON.parse(await readFile(result, 'utf8'));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

async function call(params, signal) {
    const operationId = randomUUID();
    const started = Date.now();
    let value;
    try {
        if (![readTool.name, writeTool.name].includes(params?.name)) throw fail('BROWSER_TOOL_UNKNOWN');
        const input = validate(params.arguments ?? {}, params.name === readTool.name);
        if (active) throw fail('BROWSER_BUSY');
        active = true;
        try { value = await execute(input, operationId, signal); }
        finally { active = false; }
    } catch (error) {
        value = { code: /^BROWSER_|^TEMP_PROCESS_/.test(error.code ?? '') ? error.code : 'BROWSER_EXECUTION_FAILED' };
    }
    console.info(JSON.stringify({ operation: 'browser.operate', operationId, stage: 'release',
        result: value.code ? 'failure' : 'success', code: value.code, durationMs: Date.now() - started }));
    return { isError: Boolean(value.code), content: [{ type: 'text', text: JSON.stringify(value) }] };
}

async function dispatch(body, signal) {
    const modern = body.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === version;
    const complete = modern ? { resultType: 'complete' } : {};
    switch (body.method) {
        case 'initialize':
            return { protocolVersion: '2025-11-25', serverInfo: info, capabilities: { tools: {} } };
        case 'server/discover':
            return { ...complete, ttlMs: 0, cacheScope: 'private', supportedVersions: [version],
                capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': info } };
        case 'tools/list':
            return { ...complete, tools: [readTool, writeTool], ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}) };
        case 'tools/call':
            return { ...complete, ...await call(body.params, signal) };
        case 'ping':
            return complete;
        default:
            throw fail('METHOD_NOT_FOUND');
    }
}

async function parse(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 100000) throw fail('REQUEST_TOO_LARGE');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(request) {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.concat([Buffer.from('Bearer '), credential]);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function handle(request, response) {
    if (request.url !== '/mcp' || request.method !== 'POST') return response.writeHead(405).end();
    if (request.headers.origin || !authorized(request)) return response.writeHead(401).end();
    let body;
    try { body = await parse(request); }
    catch { return response.writeHead(400).end(); }
    if (body?.jsonrpc !== '2.0') return response.writeHead(400).end();
    if (body.method === 'notifications/initialized' && body.id === undefined) return response.writeHead(202).end();
    if (typeof body.id !== 'string' && !Number.isFinite(body.id)) return response.writeHead(400).end();
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    let payload;
    try { payload = { result: await dispatch(body, controller.signal) }; }
    catch { payload = { error: { code: -32601, message: 'Method not found' } }; }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }));
}

const server = createServer({ requestTimeout: 15000 }, (req, res) => {
    void handle(req, res).catch(() => res.destroy());
});
server.listen(config.port, '127.0.0.1');
