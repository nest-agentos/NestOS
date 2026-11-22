import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {cleanHealthyRelease, pinSharedReleases, sharedReleaseLease} from '../httpd-retention.mjs';
import {launchFile} from '../httpd-launch-state.mjs';
import {acquireBuildLock} from '../httpd-build-cache.mjs';

function fixture(t) {
    const root = mkdtempSync(path.join(tmpdir(), 'retention-'));
    t.after(() => rmSync(root, {recursive:true, force:true}));
    const previous = process.env.NESTOS_HTTPD_CONTROL_DIR;
    process.env.NESTOS_HTTPD_CONTROL_DIR = path.join(root,'controls');
    t.after(() => {
        if (previous === undefined) delete process.env.NESTOS_HTTPD_CONTROL_DIR;
        else process.env.NESTOS_HTTPD_CONTROL_DIR = previous;
    });
    const releases = path.join(root,'release/httpd'), libraries = path.join(root,'release/local-libraries');
    const old = '20260101T010101-12345678', current = '20260102T010101-12345678';
    for (const id of [old,current]) {
        mkdirSync(path.join(releases,id), {recursive:true});
        writeFileSync(path.join(releases,id,'release.json'), JSON.stringify({id}));
    }
    mkdirSync(libraries,{recursive:true});
    writeFileSync(path.join(releases,'current.json'),JSON.stringify({id:current}));
    const file = launchFile(root,'release');
    mkdirSync(path.dirname(file), {recursive:true});
    writeFileSync(file,JSON.stringify({schema:1,root,mode:'release',desiredState:'running',serviceId:'test',args:[],
        childRelease:current,currentRelease:current}));
    return {root,releases,libraries,old, clean:()=>cleanHealthyRelease(root,releases,current),
        hasOld:()=>existsSync(path.join(releases,old))};
}

test('preserves releases during a shared launch and across loss of its launcher', async t => {
    const f=fixture(t), foreign=path.join(f.root,'worktree');
    const unlock=sharedReleaseLease(foreign,f.releases);
    try {
        assert.equal(await f.clean(),true);
        assert.ok(f.hasOld());
        pinSharedReleases(foreign,f.releases,[f.old]);
    } finally {unlock();}
    assert.equal(await f.clean(),true);
    assert.ok(f.hasOld());
    pinSharedReleases(foreign,f.releases,[]);
    assert.equal(await f.clean(),true);
    assert.equal(f.hasOld(),false);
});

test('defers cleanup while building or when a library selection cannot be read', async t => {
    const f=fixture(t), unlock=acquireBuildLock(path.join(f.releases,'.build-cache'));
    try {assert.equal(await f.clean(),false); assert.ok(f.hasOld());} finally {unlock();}
    writeFileSync(path.join(f.libraries,'prepared.json'),'{');
    assert.equal(await f.clean(),false);
    assert.ok(f.hasOld());
});
