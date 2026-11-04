import { invoke } from '@tauri-apps/api/core';
import { createMCPStdioTransportFactory, type MCPProcessBatch } from '@itookit/kernel-adapters/llm/mcp-host';

/** One native process per MCP connection, with explicit lifetime and bounded output. */
export function createTauriMCPTransport() {
    return createMCPStdioTransportFactory({
        start: config => invoke<string>('mcp_start', { command: config.command, args: config.args ?? [], cwd: config.cwd, env: config.env ?? {} }),
        send: (id, line) => invoke('mcp_send', { id, line }),
        poll: id => invoke<MCPProcessBatch>('mcp_poll', { id }),
        stop: id => invoke('mcp_stop', { id }),
    });
}
