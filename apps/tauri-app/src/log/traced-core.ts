// The build instruments the official core invoke so its internal callers are counted too.
export * from '../../node_modules/@tauri-apps/api/core';
export { ipcCounter } from './ipc-counter-state';
