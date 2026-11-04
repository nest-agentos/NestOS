import type { Window } from '@tauri-apps/api/window';
import type { AppHandle } from '@itookit/app-shell';
import { recordDiagnostic } from '../log/desktop-diagnostics';

/** Keep the WebView alive until consumers, kernel work and Session leases are released. */
export async function installWindowClose(window: Pick<Window, 'onCloseRequested' | 'destroy'>,
    app: Pick<AppHandle, 'destroy'>): Promise<void> {
    let closing: Promise<void> | undefined;
    const unlisten = await window.onCloseRequested(event => {
        event.preventDefault();
        closing ??= close().catch(error => {
            closing = undefined;
            void recordDiagnostic('shutdown.failed', error);
        });
        return closing;
    });
    async function close(): Promise<void> {
        try { await app.destroy(); }
        catch (error) { await recordDiagnostic('shutdown.cleanup.failed', error); }
        await window.destroy();
        unlisten();
    }
}
