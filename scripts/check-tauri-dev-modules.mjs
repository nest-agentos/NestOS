import { createServer } from '../apps/tauri-app/node_modules/vite/dist/node/index.js';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceTextModule, createContext } from 'node:vm';

// Native ESM linking catches missing exports that production bundling can hide.
const root = fileURLToPath(new URL('../apps/tauri-app', import.meta.url));
const httpServer = createHttpServer();
const server = await createServer({ root, configFile: join(root, 'vite.config.ts'),
    cacheDir: mkdtempSync(join(tmpdir(), 'x1-tauri-dev-modules-')),
    server: { middlewareMode: true, hmr: { server: httpServer } }, optimizeDeps: { force: true } });
const modules = new Map(), context = createContext({});
async function moduleAt(url) {
    if (!modules.has(url)) modules.set(url, (async () => {
        const result = await server.transformRequest(url);
        if (!result) throw new Error(`No transformed module: ${url}`);
        return new SourceTextModule(result.code, { context, identifier: url });
    })());
    return modules.get(url);
}
try {
    const entry = await moduleAt('/src/main.ts');
    await entry.link(async (specifier, parent) => {
        const url = new URL(specifier, 'http://localhost' + parent.identifier);
        return moduleAt(url.pathname + url.search);
    });
    console.log(`Linked Tauri development graph: ${modules.size} modules`);
} finally { await server.close(); }
