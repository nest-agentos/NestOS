import { invoke } from '@tauri-apps/api/core';
import type { IToolService } from '@itookit/tools/contracts';
import { errorDetails } from '@itookit/common';

export async function recordDiagnostic(event: string, value: unknown): Promise<void> {
    const text = diagnosticText(value);
    // Bound UTF-8 bytes as well as JS string length before crossing IPC.
    const message = (text ?? '').slice(0, 4000);
    await invoke('diagnostic_event', { event, message }).catch(error => console.error('[Diagnostics]', error));
}

function diagnosticText(value: unknown): string {
    if (value instanceof Error) return `${errorDetails(value)}\n${value.stack ?? ''}`;
    try { return typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }
    catch { return String(value); }
}

export function observeTools(service: IToolService, sessionId: string): void {
    const invokeTool = service.invoke.bind(service);
    service.invoke = async request => {
        const identity = { sessionId, toolId: request.toolId };
        await recordDiagnostic('tool.running', { ...identity, cwd: request.cwd,
            ...(request.toolId === 'Grep' ? { input: request.args } : {}) });
        try {
            const result = await invokeTool({ ...request, onProgress: async progress => {
                await recordDiagnostic('tool.progress', { ...identity, message: progress.message });
                await request.onProgress?.(progress);
            } });
            await recordDiagnostic(result.success ? 'tool.success' : 'tool.error', { ...identity, durationMs: result.durationMs, error: result.error });
            return result;
        } catch (error) { await recordDiagnostic('tool.exception', { ...identity, error: String(error) }); throw error; }
    };
}

window.addEventListener('error', event => recordDiagnostic('error', event.error ?? event.message));
window.addEventListener('unhandledrejection', event => recordDiagnostic('unhandledrejection', event.reason));
