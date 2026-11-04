import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

// A deterministic local fixture for the protocol version used by this repository.
const version = '2026-07-28';
const tools = [{ name: 'lookup', description: 'Look up a local validation rule; no network access.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'], additionalProperties: false } }];

function handle(request) {
    if (request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== version) throw new Error(`Expected MCP ${version}`);
    if (request.method === 'server/discover') return { supportedVersions: [version], capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'harness-validation', version: '1' } } };
    if (request.method === 'tools/list') return { tools };
    if (request.method !== 'tools/call' || request.params?.name !== 'lookup') throw new Error('Unknown method or tool');
    const topic = request.params.arguments?.topic;
    if (typeof topic !== 'string' || !topic.trim()) throw new Error('topic must be a nonempty string');
    if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify({ name: 'lookup', topic }) + '\n');
    const data = { marker: 'MCP_VALIDATION_OK', topic, rule: 'Two reviewers must approve the release.' };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

createInterface({ input: process.stdin }).on('line', line => {
    let request;
    try {
        request = JSON.parse(line);
        if (request.id === undefined) return;
        const result = { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...handle(request) };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null,
            error: { code: -32602, message: String(error.message ?? error) } }) + '\n');
    }
});
