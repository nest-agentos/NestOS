import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gitSourceFiles} from '../git-source-files.mjs';

function fixture(t) {
    const root = mkdtempSync(path.join(tmpdir(), 'git-source-files-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    execFileSync('git', ['init', '--quiet', root]);
    return root;
}

test('includes tracked and new source but excludes ignored builds and dangling links', t => {
    const root = fixture(t);
    writeFileSync(path.join(root, '.gitignore'), 'build/\n');
    writeFileSync(path.join(root, 'tracked.ts'), '');
    execFileSync('git', ['add', 'tracked.ts'], {cwd: root});
    writeFileSync(path.join(root, 'new.css'), '');
    mkdirSync(path.join(root, 'build'));
    symlinkSync('missing', path.join(root, 'build', 'broken'));
    writeFileSync(path.join(root, 'build', 'generated.ts'), '');
    symlinkSync('missing', path.join(root, 'broken'));
    assert.deepEqual(gitSourceFiles(root), ['.gitignore', 'new.css', 'tracked.ts']);
});

test('recurses initialized Git repositories and can exclude them before enumeration', t => {
    const root = fixture(t), nested = path.join(root, 'libraries', 'widget');
    mkdirSync(nested, {recursive: true});
    execFileSync('git', ['init', '--quiet', nested]);
    writeFileSync(path.join(nested, 'source.ts'), '');
    execFileSync('git', ['add', 'source.ts'], {cwd: nested});
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], {cwd: nested});
    execFileSync('git', ['add', 'libraries/widget'], {cwd: root, stdio: 'pipe'});
    assert.deepEqual(gitSourceFiles(root), ['libraries/widget/source.ts']);
    assert.deepEqual(gitSourceFiles(root, '', name => !name.startsWith('libraries/')), []);
});
