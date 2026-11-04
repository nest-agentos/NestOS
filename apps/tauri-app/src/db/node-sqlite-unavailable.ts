/** The webview uses TauriSqlSidecarDb; the Node fallback must never execute here. */
export default class NodeSqliteUnavailable {
    constructor() {
        throw new Error('Node SQLite is unavailable in the Tauri webview; inject TauriSqlSidecarDb through createDb');
    }
}
