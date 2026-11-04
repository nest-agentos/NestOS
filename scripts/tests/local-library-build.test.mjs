import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import state from '../local-library-state.cjs';
import { preparedSnapshot } from '../local-library-plan.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'incremental-libraries-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(join(repository, 'node_modules/yaml'), join(root, 'node_modules/yaml'));
    const catalog = ['core', 'parent', 'leaf', 'other'].map(directory => ({ name: `@nestos/${directory}`, directory, version: '1.0.0' }));
    writeFileSync(join(root, 'scripts/npm-libraries.json'), JSON.stringify(catalog));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'build-fixture', private: true, packageManager: 'pnpm@10.20.0' }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - libraries/*\noverrides:\n' + catalog.map(item => `  "${item.name}": "workspace:*"`).join('\n') + '\n');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    writeFileSync(join(root, 'tsconfig.base.json'), '{}');
    for (const item of catalog) createLibrary(root, item, { parent: 'core', leaf: 'parent' }[item.directory]);
    return root;
}
function createLibrary(root, item, dependency) {
    const directory = join(root, 'libraries', item.directory); mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: item.name, version: item.version,
        exports: { '.': './src/index.cjs' }, publishConfig: { exports: { '.': './dist/index.cjs' } },
        files: ['dist'], scripts: { build: 'node build.cjs' }, ...(dependency && { dependencies: { [`@nestos/${dependency}`]: '1.0.0' } }) }));
    writeFileSync(join(directory, 'src/index.cjs'), dependency ? `module.exports=require('@nestos/${dependency}');` : 'module.exports={value:1};');
    writeFileSync(join(directory, 'build.cjs'), `const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.copyFileSync('src/index.cjs','dist/index.cjs');
const value=${dependency ? `require('@nestos/${dependency}').value` : `require('./src/index.cjs').value`};
fs.appendFileSync(process.env.BUILD_LOG, '${item.directory}:'+value+'\\n');`);
}
function build(root, library) {
    return spawnSync(process.execPath, ['scripts/local-libraries.mjs', 'build', ...(library ? [library] : [])], {
        cwd: root, encoding: 'utf8', env: { ...process.env, NESTOS_LIBRARY_SNAPSHOT: '', BUILD_LOG: join(root, 'build.log') }, timeout: 60_000,
    });
}
function buildSeeded(root, seed) {
    return spawnSync(process.execPath, ['scripts/local-libraries.mjs', 'build'], {
        cwd: root, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, NESTOS_LIBRARY_SNAPSHOT: '', NESTOS_LIBRARY_SEED_ROOT: seed, BUILD_LOG: join(root, 'build.log') },
    });
}
const lines = root => readFileSync(join(root, 'build.log'), 'utf8').trim().split('\n');

test('incremental builds reuse artifacts, rebuild dependents, and freeze unselected dirty sources', t => {
    const root = fixture(t);
    let result = build(root); assert.equal(result.status, 0, result.stdout + result.stderr);
    const first = preparedSnapshot(root);
    assert.equal(lines(root).length, 4);
    assert.equal(state.readSelection(root), null, 'building must not activate dependencies');
    result = build(root); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(preparedSnapshot(root).id, first.id); assert.equal(lines(root).length, 4);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, scripts: { test: 'unrelated root command' } }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\nimporters:\n  apps/web:\n    dependencies:\n      business:\n        specifier: 1.0.0\n        version: 1.0.0\n');
    result = build(root); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(preparedSnapshot(root).id, first.id); assert.equal(lines(root).length, 4);
    assert.match(result.stdout, /rebuild=0 reuse=4/);
    assert.doesNotMatch(result.stdout, /stage=install/);
    writeFileSync(join(root, 'libraries/core/src/index.cjs'), 'module.exports={value:2};');
    result = build(root); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /library=@itookit\/core reasons=source-changed/);
    assert.match(result.stdout, /library=@itookit\/parent reasons=dependency-rebuilt/);
    const second = preparedSnapshot(root);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(lines(root).slice(4), ['core:2', 'parent:2', 'leaf:2']);
    assert.equal(second.packages.find(item => item.directory === 'other').sha256, first.packages.find(item => item.directory === 'other').sha256);
    writeFileSync(join(root, 'libraries/core/src/index.cjs'), 'module.exports={value:3};');
    writeFileSync(join(root, 'libraries/other/package.json'), 'unfinished unrelated manifest');
    result = build(root, '@nestos/parent'); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(lines(root).slice(7), ['parent:2', 'leaf:2']);
    const third = preparedSnapshot(root);
    assert.equal(third.packages.find(item => item.directory === 'core').sha256, second.packages.find(item => item.directory === 'core').sha256);
    result = build(root, 'not-a-library'); assert.equal(result.status, 1);
    assert.match(result.stderr, /LOCAL_LIBRARIES_UNKNOWN/);
    result = build(root); assert.equal(result.status, 1);
    assert.equal(preparedSnapshot(root).id, third.id, 'failed builds must retain the usable prepared snapshot');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'invalid: [secret-lock-content');
    result = build(root); assert.equal(result.status, 1);
    assert.match(result.stderr, /stage=plan result=failure .*code=LOCAL_LIBRARIES_YAML_INPUT/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-lock-content/);
    assert.equal(preparedSnapshot(root).id, third.id);
    assert.equal(existsSync(state.activeFile(root)), false);
});

test('a linked checkout seeds its plan from another checkout and adopts the snapshot locally', t => {
    const main = fixture(t), worktree = fixture(t);
    let result = build(main); assert.equal(result.status, 0, result.stdout + result.stderr);
    const snapshot = preparedSnapshot(main);
    result = buildSeeded(worktree, main); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /stage=plan-base result=seed id=/);
    assert.match(result.stdout, /rebuild=0 reuse=4/);
    assert.equal(existsSync(join(worktree, 'build.log')), false, 'a seeded build must not compile any library');
    assert.equal(preparedSnapshot(worktree).id, snapshot.id);
    assert.equal(existsSync(join(state.localRoot(worktree), 'snapshots', snapshot.id, 'snapshot.json')), true);
    writeFileSync(join(state.localRoot(main), 'prepared.json'), JSON.stringify({format: 2, id: snapshot.id}));
    const fallback = fixture(t);
    result = buildSeeded(fallback, main); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /result=seed-fallback code=LOCAL_LIBRARIES_SEED/);
    assert.equal(lines(fallback).length, 4, 'an unusable seed falls back to a full build');
    writeFileSync(join(state.localRoot(fallback), 'prepared.json'), JSON.stringify({format: 1, id: 'b'.repeat(64)}));
    result = buildSeeded(fallback, fallback); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /result=rebuild code=PREPARED_MISSING/);
    assert.equal(preparedSnapshot(fallback).id.length, 64, 'a missing local snapshot is rebuilt instead of failing');
});
