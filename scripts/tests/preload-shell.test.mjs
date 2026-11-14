import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preloadShell} from '../preload-shell.mjs';
test('preloads only the unconditional shell and static dependencies across shared cycles', () => {
    const chunk = (fileName, imports = [], dynamicImports = []) => ({type: 'chunk', fileName, imports, dynamicImports});
    const shell = {...chunk('shell.js', ['shared.js'], ['chat.js', 'settings.js']), viteMetadata: {importedCss: new Set(['shell.css'])}, facadeModuleId: null, modules: {'/client/shell.ts': {}} };
    const bundle = {'shell.js': shell, 'shared.js': chunk('shared.js', ['shell.js']), 'chat.js': chunk('chat.js'), 'settings.js': chunk('settings.js')};
    const handler = preloadShell('/client/shell.ts').transformIndexHtml.handler;
    assert.deepEqual(handler('', {bundle}).map(tag => tag.attrs.href), ['./shell.js', './shell.css', './shared.js']);
    assert.equal(handler('', {}), undefined);
    assert.equal(handler('', {bundle: {}}), undefined);
});
