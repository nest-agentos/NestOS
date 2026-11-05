import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { dependencyError, manifestDependencyError, sourceErrors, vfsStyleErrors, importError } from '../check-boundaries.mjs';

const packageGroup = name => name === 'app-shell' ? 'ui/' : ['vfs-ui', 'vfs-core', 'vfs-sync'].includes(name) ? 'libraries/' : 'backend/';
const pkg = (name, host = false) => ({ name: '@nestos/' + name, dir: '/repo/' + (host ? 'apps/' : packageGroup(name)) + name, host, exports: { '.': './src/index.ts', './style.css': './src/style.css' } });
const core = pkg('app-core'), shell = pkg('app-shell'), vfs = pkg('vfs-ui'), host = pkg('web', true);
const packages = [core, shell, vfs, host, pkg('vfs-core'), pkg('vfs-sync')];
const inspect = (source, text, file = source.dir + '/src/index.ts') => sourceErrors(source, file, text, packages);

test('frontend shell cannot import runtime roots or host factories even as a type shortcut', () => {
    for (const expression of ["import type { Runtime } from '@nestos/app-core'", "import { createApplicationRuntime } from '@nestos/app-core'",
        "import('@nestos/app-core/host')"])
        assert.match(inspect(shell, expression)[0], /runtime assembly belongs to hosts/);
});

test('app-shell consumes public VFS events and presentation tokens without internal DOM or CSS selectors', () => {
    assert.match(inspect(shell, "sidebar.querySelector('.vfs-columns__back').click()")[0], /public VFS/);
    assert.match(inspect(shell, "row.classList.contains('vfs-node-item__content')")[0], /public VFS/);
    assert.equal(inspect(shell, 'sidebar.addEventListener(VFS_DOM_EVENTS.resourceActivated, showDetail)').length, 0);
    assert.match(vfsStyleErrors(shell, 'workspace.css', '.toolbox .vfs-node-item__timestamp { display: none; }')[0], /public VFS/);
    assert.equal(vfsStyleErrors(shell, 'workspace.css', '.toolbox { --vfs-item-icon-size: 20px; }').length, 0);
    assert.equal(vfsStyleErrors(vfs, 'style.css', '.vfs-node-item__timestamp { display: none; }').length, 0);
});

test('public execution and conversation capabilities cannot depend on legacy shared contracts', () => {
    for (const source of ['@nestos/tools', '@nestos/device-tty', '@nestos/llm-tasks', '@nestos/llm-flow', '@nestos/llm-session']) {
        for (const target of ['@nestos/common', '@nestos/llm-common'])
            assert.match(dependencyError(source, target), /owned contracts/);
    }
    assert.equal(dependencyError('@nestos/tools', '@nestos/llm-context'), undefined);
    assert.match(dependencyError('@nestos/device-tty', '@nestos/tools'), /owned contracts/);
    assert.equal(dependencyError('@nestos/tools', '@nestos/device-tty'), undefined);
});

test('dependency direction keeps domain capabilities independent of applications', () => {
    assert.equal(dependencyError(shell.name, core.name), undefined);
    assert.equal(dependencyError(core.name, '@nestos/llm-session'), undefined);
    assert.match(dependencyError(vfs.name, shell.name), /must not depend/);
    assert.match(dependencyError(core.name, vfs.name), /platform-neutral/);
    assert.equal(dependencyError(core.name, 'js-yaml'), undefined);
    assert.match(dependencyError(core.name, 'some-sdk'), /platform-neutral/);
});

test('checks static, dynamic, type-only, re-export and CommonJS dependencies', () => {
    for (const expression of ["import type { X } from '@nestos/app-shell'", "export { X } from '@nestos/app-shell'",
        "import('@nestos/app-shell')", "type X = import('@nestos/app-shell').X", "require('@nestos/app-shell')",
        "import X = require('@nestos/app-shell')"]) assert.equal(inspect(vfs, expression).length, 1, expression);
});

test('allows public CSS exports but rejects private paths and relative package access', () => {
    assert.equal(inspect(shell, "import '@nestos/vfs-ui/style.css'").length, 0);
    assert.match(inspect(shell, "import '@nestos/vfs-ui/src/Store'")[0], /declared package export/);
    assert.match(inspect(shell, "import '../../../libraries/vfs-ui/src/Store'")[0], /cross-package relative/);
    assert.match(inspect(shell, "import '@nestos/web'")[0], /app hosts/);
    assert.equal(inspect(host, "import '@nestos/app-shell'").length, 0);
});

test('keeps native and browser capabilities outside app-core while allowing portable primitives', () => {
    for (const expression of ["import 'node:fs'", "import 'fs'", "import 'react'", "import '@tauri-apps/api/core'", 'window.location', 'globalThis.document',
        'localStorage.getItem("key")', 'let element: HTMLElement']) assert.equal(inspect(core, expression).length, 1, expression);
    assert.equal(inspect(core, 'new AbortController(); new URL("https://example.com"); const value = "window"; // document\n').length, 0);
});

test('public core exports are explicit and comments do not create false dependencies', () => {
    assert.match(inspect(core, "export * from './private'")[0], /must be explicit/);
    assert.equal(inspect(core, "export { Service } from './service'; // import '@nestos/app-shell'\n").length, 0);
    assert.equal(inspect(core, 'const description = "document and HTMLElement";').length, 0);
});


test('standalone mdxeditor has no internal package dependencies', () => {
    for (const name of ['common', 'ui-common-adapter', 'vfs-core', 'mdx-adapter']) {
        assert.match(dependencyError('@nestos/mdxeditor', '@nestos/' + name), /public ports/);
    }
    assert.equal(dependencyError('@nestos/mdxeditor', 'codemirror'), undefined);
    assert.equal(dependencyError('@nestos/mdx-adapter', '@nestos/mdxeditor'), undefined);
});

test('image-parser keeps VFS optional and outside the root and UI entries', () => {
    const image = {...pkg('image-parser'), dir: '/repo/libraries/image-parser'};
    assert.equal(dependencyError(image.name, 'scanic'), undefined);
    assert.equal(dependencyError(image.name, '@nestos/vfs-core'), undefined);
    assert.match(dependencyError(image.name, '@nestos/common'), /optional VFS/);
    for (const entry of ['src/index.ts', 'src/ui.ts'])
        assert.match(importError(image, resolve(image.dir, entry), '@nestos/vfs-core', packages), /optional vfs entry/);
    assert.equal(importError(image, resolve(image.dir, 'src/vfs.ts'), '@nestos/vfs-core', packages), undefined);
});

test('standalone vfs-ui only depends on vfs-core internally', () => {
    for (const name of ['common', 'ui-common', 'llm-common', 'mdxeditor'])
        assert.match(dependencyError(vfs.name, '@nestos/' + name), /public ports/);
    assert.equal(dependencyError(vfs.name, '@nestos/vfs-core'), undefined);
    assert.match(dependencyError(vfs.name, 'immer'), /public ports/);
});

test('standalone kanban only accepts vfs-core and injected execution ports', () => {
    const name='@nestos/kanban';
    for (const target of ['@nestos/common','@nestos/app-contracts','@nestos/llm-session','@nestos/llm-flow','@nestos/durable-kernel','node:fs','some-agent-sdk'])
        assert.match(dependencyError(name,target), /only depend on vfs-core/);
    assert.equal(dependencyError(name,'@nestos/vfs-core'),undefined);
    assert.equal(manifestDependencyError(name,'@nestos/vfs-core'),undefined);
});

test('public LLM mechanisms reject host dependencies', () => {
    for (const name of ['common', 'ui-common', 'vfs-core', 'kernel-adapters/llm', 'llm-session'])
        assert.match(dependencyError('@nestos/driver-llm', '@nestos/' + name), /public ports/);
    assert.match(dependencyError('@nestos/driver-llm', '@nestos/llm-context'), /public ports/);
    assert.match(dependencyError('@nestos/llm-context', '@nestos/driver-llm'), /public ports/);
    const driver = pkg('driver-llm'), context = pkg('llm-context');
    const inspectDriver = text => sourceErrors(driver, '/repo/libraries/driver-llm/src/test.ts', text, [driver, context]);
    assert.equal(inspectDriver("import type { ChatMessage } from '@nestos/llm-context';").length, 1);
    assert.equal(inspectDriver("import { createContextService } from '@nestos/llm-context';").length, 1);
    assert.equal(inspectDriver("import { Client } from 'some-sdk';").length, 1);
});


test('common and shared UI cannot regain hidden LLM dependencies', () => {
    const common = pkg('common'), ui = pkg('ui-common-adapter'), session = pkg('llm-session');
    for (const source of [common, ui]) {
        assert.match(dependencyError(source.name, session.name), /capability packages|generic ports/);
        for (const expression of ["import type { ISession } from '@nestos/llm-session'",
            "export * from '@nestos/llm-session'", "type Submission = import('@nestos/llm-session').Signal"])
            assert.equal(sourceErrors(source, source.dir + '/src/index.ts', expression, [common, ui, session]).length, 1);
    }
    assert.equal(dependencyError(ui.name, common.name), undefined);
    assert.equal(dependencyError(ui.name, '@nestos/vfs-core'), undefined);
});

test('kernel adapters cannot depend on the task, flow or session implementations', () => {
    for (const name of ['llm-tasks', 'llm-flow', 'llm-session'])
        assert.match(dependencyError('@nestos/kernel-adapters', '@nestos/' + name), /execution or conversation layers/);
    assert.equal(dependencyError('@nestos/kernel-adapters', '@nestos/tools'), undefined);
});


test('driver dependencies reject context types as well as runtime imports', () => {
    assert.match(manifestDependencyError('@nestos/driver-llm', '@nestos/llm-context'), /no runtime dependencies/);
    assert.match(dependencyError('@nestos/driver-llm', '@nestos/llm-context'), /public ports/);
});

test('optional settings may only load through the explicit settings or compatibility entry', () => {
    const ui = pkg('llm-ui-adapter');
    for (const statement of ["import '@nestos/llm-ui/settings'", "import('./settings')", "export * from './settings'", "import './settings/host'"]) {
        assert.match(inspect(ui, statement, ui.dir + '/src/chat.ts')[0], /optional settings/);
        assert.equal(inspect(ui, statement, ui.dir + '/src/settings.ts').length, 0);
    }
});

test('chat uses session contracts and rejects session implementation imports', () => {
    const ui = pkg('llm-ui-adapter');
    const session = { ...pkg('llm-session'), exports: { '.': './src/index.ts', './contracts': './src/contracts.ts' } };
    const check = (file, expression) => sourceErrors(ui, ui.dir + '/src/' + file, expression, [ui, session]);
    assert.match(check('chat.ts', "import { getSessionManager } from '@nestos/llm-session'")[0], /runtime instances belong to the host/);
    assert.equal(check('chat.ts', "import { SessionCommand } from '@nestos/llm-session/contracts'").length, 0);
    assert.match(check('index.ts', "import { getSessionManager } from '@nestos/llm-session'")[0], /runtime instances belong to the host/);
    assert.match(check('legacy.ts', "import { SessionManager } from '@nestos/llm-session'")[0], /runtime instances belong to the host/);
});


test('chat must receive business flow templates from the host', () => {
    const ui = pkg('llm-ui-adapter');
    assert.match(inspect(ui, "import template from './library/product.flow?raw'", ui.dir + '/src/chat.ts')[0], /template catalogs/);
});


test('public LLM capabilities cannot choose NestOS default tool grants', () => {
    for (const name of ['kernel-adapters', 'llm-session', 'llm-ui-adapter']) {
        const source = pkg(name);
        assert.match(inspect(source, "export const DEFAULT_HARNESS_TOOL_IDS = ['Bash'];")[0], /injected policy/);
    }
    assert.equal(inspect(core, "export const DEFAULT_HARNESS_TOOL_IDS = ['Bash'];").length, 0);
});


test('settings cannot load the model management aggregate for config conversion', () => {
    const ui = pkg('llm-ui-adapter');
    assert.match(inspect(ui, "import { parseLLMConfig } from '@nestos/kernel-adapters/llm'")[0], /management aggregate/);
});


test('settings use service capabilities instead of process-global MCP state', () => {
    const ui = pkg('llm-ui-adapter');
    assert.match(inspect(ui, "import { hasMCPStdioHost } from '@nestos/kernel-adapters/llm/mcp-host'")[0], /service instance capabilities/);
});


test('production hosts cannot rely on implicit LLM presets through the compatibility aggregate', () => {
    for (const source of [pkg('app-core'), pkg('app-shell'), pkg('cli', true)])
        assert.match(inspect(source, "import { LLMDeviceDriver } from '@nestos/kernel-adapters/llm'")[0], /explicit LLM/);
});


test('adapter diagnostics and UI creation state are instance scoped', () => {
    assert.match(dependencyError('@nestos/kernel-adapters', '@nestos/common'), /injected ports/);
    const ui = pkg('llm-ui-adapter');
    assert.match(sourceErrors(ui, ui.dir + '/src/StateManager.ts', "sessionStorage.getItem('app_create_params')", [ui])[0], /instance options/);
});

test('VFS drivers have no sync runtime or type dependencies', () => {
    for (const name of ['vfsdriver-indexeddb', 'vfsdriver-local']) {
        const driver = pkg(name);
        assert.match(manifestDependencyError(driver.name, '@nestos/vfs-sync'), /only depend on vfs-core/);
        assert.match(inspect(driver, "import type { StateStore } from '@nestos/vfs-sync'")[0], /only depend on vfs-core/);
        assert.equal(inspect(driver, "import type { IStorageBackend } from '@nestos/vfs-core'").length, 0);
    }
    assert.match(dependencyError('@nestos/vfs-core', '@nestos/vfs-sync'), /remain independent/);
    assert.equal(dependencyError('@nestos/cells-driver','@nestos/vfs-sync'),undefined);
    assert.match(dependencyError('@nestos/cells-driver','@nestos/vfsdriver-agent'),/public ports/);
});

test('UI consumes application capabilities instead of backend construction contracts', () => {
    for (const name of ['LocalBackendPort', 'LocalApplicationServices', 'IVFSManager', 'SessionFilesService', 'DirectoryMountService'])
        assert.match(inspect(shell, `import type { ${name} } from '@nestos/app-contracts/services'`)[0], /construction contracts/);
    assert.equal(inspect(shell, "import type { ApplicationClient } from '@nestos/app-contracts/services'").length, 0);
});
test('RPC mechanism cannot import application metadata or domain policy', () => {
    const file = resolve(host.dir, 'src/rpc/peer.ts');
    for (const specifier of ['../application/capabilities', '@nestos/app-contracts', '../client/projections'])
        assert.match(importError(host, file, specifier, packages), /metadata through injection/);
    assert.equal(importError(host, file, './protocol', packages), undefined);
    assert.equal(importError(host, file, '@nestos/vfs-core', packages), undefined);
});

test('shared RPC transport keeps application descriptors outside its mechanism directory', () => {
    const transport = pkg('app-transport');
    const file = resolve(transport.dir, 'src/rpc/peer.ts');
    assert.match(importError(transport, file, '../application/capabilities', packages), /metadata through injection/);
    assert.equal(importError(transport, file, './protocol', packages), undefined);
});


test('standalone llm-ui rejects all runtime and contract dependencies except mdxeditor', () => {
    const ui = pkg('llm-ui');
    for (const name of ['@nestos/common', '@nestos/llm-ui-adapter', '@nestos/llm-session/contracts', 'marked', 'node:fs']) {
        assert.match(sourceErrors(ui, ui.dir + '/src/index.ts', `import type { Contract } from '${name}'`, [ui])[0], /only import mdxeditor/);
        assert.match(manifestDependencyError(ui.name, name), /only depend on mdxeditor/);
    }
    assert.equal(inspect(ui, "import { MDxRenderer } from '@nestos/mdxeditor'").length, 0);
});

test('application contracts consume Kanban ports without forwarding the library API', () => {
    const source = {name: '@nestos/app-contracts', dir: '/repo/shared/app-contracts'};
    const file = '/repo/shared/app-contracts/src/index.ts';
    assert.ok(sourceErrors(source, file, "export type {KanbanItem} from '@nestos/kanban/contracts';", []).some(error => error.includes('import its public entry directly')));
    assert.deepEqual(sourceErrors(source, file, "import type {KanbanClient} from '@nestos/kanban/contracts'; export interface Client {kanban?: KanbanClient}", []), []);
});

test('Kanban adapters export their bindings rather than duplicate the library surface', () => {
    assert.ok(inspect(core, "export {SeqKanbanStore} from '@nestos/kanban/storage';", '/repo/backend/app-core/src/kanban/index.ts').some(error => error.includes('must not forward')));
    assert.deepEqual(inspect(core, "export {createKanbanModule} from './module';", '/repo/backend/app-core/src/kanban/index.ts'), []);
});

test('mail permits its documented shared reader dependency while retaining application isolation',()=>{
    assert.equal(manifestDependencyError('@nestos/mail','@nestos/mdxeditor'),undefined);
    assert.match(manifestDependencyError('@nestos/mail','@nestos/app-core'),/mail only depends/);
});
