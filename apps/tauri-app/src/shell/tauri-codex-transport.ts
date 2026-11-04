import { invoke } from '@tauri-apps/api/core';
import { JsonRpcLineTransport } from '@itookit/driver-llm';

/** Persistent Codex app-server transport backed by Tauri Rust commands. */
export class TauriCodexTransport extends JsonRpcLineTransport {
  private constructor() {
    super();
  }

  static async create(cwd: string): Promise<TauriCodexTransport> {
    await invoke('codex_start', { cwd });
    const transport = new TauriCodexTransport();
    void transport.poll();
    await transport.request('initialize', {
      clientInfo: { name: 'itookit-tauri', title: 'iTooKit', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    transport.notify('initialized');
    return transport;
  }

  protected async writeLine(line: string): Promise<void> {
    await invoke('codex_send', { message: line });
  }

  async close(): Promise<void> {
    await super.close();
    await invoke('codex_stop');
  }

  private async poll(): Promise<void> {
    // Polling (rather than Tauri event emit) is a deliberate trade-off: the
    // Rust side owns the app-server stdout reader, and a single polling loop
    // keeps line ordering trivial without a listen/emit race window. Idle
    // polls are cheap (20 ms) and only run while the transport is open.
    while (!this.isClosed) {
      try {
        const lines = await invoke<string[]>('codex_poll');
        for (const line of lines) this.handleLine(line);
        await new Promise(resolve => setTimeout(resolve, lines.length ? 0 : 20));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }
}
