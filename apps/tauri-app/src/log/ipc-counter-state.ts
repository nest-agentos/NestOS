import { countIpc, type IpcPort } from './ipc-counter';

// Diagnostic writes bypass counting without replacing the immutable Tauri host object.
const host: IpcPort = {
    invoke(command, ...args) {
        const port = (window as unknown as { __TAURI_INTERNALS__: IpcPort }).__TAURI_INTERNALS__;
        return port.invoke(command, ...args);
    },
};
export const ipcCounter = countIpc(host);
