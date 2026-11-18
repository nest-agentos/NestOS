import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {PhysicalSeqTransactions,physicalSeqSchema} from '../../apps/node-host/src/storage/physical-seq.mjs';

function fixture(t,count) {
    const root = mkdtempSync(path.join(os.tmpdir(),'seq-tx-'));
    const resolve = name => path.join(root,name+'.seq'), journal = path.join(root,'publish.db');
    for (let i=0;i<count;i++) {
        const db = new DatabaseSync(resolve(String(i)));
        db.exec(physicalSeqSchema);
        db.close();
    }
    const open = () => new PhysicalSeqTransactions(journal,resolve);
    const one = open(), two = open();
    t.after(async () => {await one.close();await two.close();rmSync(root,{recursive:true,force:true});});
    return {one,two,resolve,journal};
}

test('publishes more files than the attachment limit and pins a concurrent reader',async t => {
    const {one,two} = fixture(t,16);
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const read = one.read(async tx => {
        assert.equal(tx.get('0','key'),undefined);
        started.resolve();await release.promise;
        assert.equal(tx.get('15','key'),undefined);
    });
    await started.promise;
    const staged = Promise.withResolvers();
    const write = two.write(tx => {
        for (let i=0;i<16;i++) tx.set(String(i),'key',i);
        assert.equal(tx.get('15','key'),15);
        staged.resolve();
    });
    await staged.promise;release.resolve();await Promise.all([read,write]);
    await one.read(tx => {for(let i=0;i<16;i++) assert.equal(tx.get(String(i),'key'),i);});
    await assert.rejects(two.write(tx => {tx.delete('0','key');throw new Error('abort');}),/abort/);
    await one.read(tx => assert.equal(tx.get('0','key'),0));
});

test('recovers a committed batch before exposing any partially published file',async t => {
    const {one,resolve,journal} = fixture(t,2);
    let fail = true;
    // The second resolution is during publication, after validation and the coordinator commit.
    const visits = new Map();
    const writer = new PhysicalSeqTransactions(journal,name => {
        visits.set(name,(visits.get(name) ?? 0)+1);
        if (fail && name === '1' && visits.get(name) === 2) throw new Error('injected publication interruption');
        return resolve(name);
    });
    await assert.rejects(writer.write(tx => {tx.set('0','key',true);tx.set('1','key',true);}),{message:'SEQ_PUBLICATION_PENDING',committed:true});
    await writer.close();fail=false;
    await one.read(tx => {assert.equal(tx.get('0','key'),true);assert.equal(tx.get('1','key'),true);});
    const db = new DatabaseSync(journal);
    try {assert.equal(db.prepare('SELECT count(*) AS n FROM changes').get().n,0);} finally {db.close();}
});

test('reopening after process death finishes both files and the metadata transaction',async t => {
    const {one,resolve,journal} = fixture(t,2);
    const init = new DatabaseSync(journal);
    init.exec('CREATE TABLE application_metadata(id TEXT PRIMARY KEY)');
    init.close();
    const module = new URL('../../apps/node-host/src/storage/physical-seq.mjs',import.meta.url).href;
    const worker = `
        import {PhysicalSeqTransactions} from ${JSON.stringify(module)};
        const [journal,...files] = process.argv.slice(1);
        const visits = new Map();
        const store = new PhysicalSeqTransactions(journal,name => {
            visits.set(name,(visits.get(name) ?? 0)+1);
            if (name === '1' && visits.get(name) === 2) process.kill(process.pid,'SIGKILL');
            return files[Number(name)];
        });
        await store.write((tx,meta) => {
            meta.exec("INSERT INTO application_metadata VALUES('batch')");
            tx.set('0','key',1); tx.set('1','key',2);
        });
    `;
    const child = spawnSync(process.execPath,['--input-type=module','-e',worker,journal,resolve('0'),resolve('1')],{timeout:5000});
    assert.equal(child.signal,'SIGKILL',String(child.stderr));
    await one.read((tx,meta) => {
        assert.deepEqual([tx.get('0','key'),tx.get('1','key')],[1,2]);
        assert.equal(meta.prepare('SELECT id FROM application_metadata').get().id,'batch');
        assert.equal(meta.prepare('SELECT count(*) n FROM publication').get().n,0);
    });
});

test('reads ordered key ranges and bounded pages after opening files again',async t => {
    const {one,two} = fixture(t,1);
    await one.write(tx => {for (const k of ['a/1','a/22','a/3','b/4']) tx.set('0',k,k);});
    await two.read(tx => {
        assert.deepEqual(tx.getMany('0',['a/3','missing','a/3']),['a/3',undefined,'a/3']);
        const page = {lower:'a/',upper:'a0',after:'a/1',limit:1};
        assert.deepEqual(tx.page('0',page),[{key:'a/22',value:'a/22'}]);
        assert.deepEqual(tx.page('0',{...page,keysOnly:true,offset:1}),['a/3']);
    });
});

test('a secondary unique index rejects an invalid batch before any participant commits',async t => {
    const {one,resolve} = fixture(t,2);
    const file = new DatabaseSync(resolve('1'));
    file.exec("CREATE UNIQUE INDEX ticket_number ON entries(json_extract(value,'$.number'))");
    file.close();
    await one.write(tx => tx.set('1','first',{number:1}));
    await assert.rejects(one.write(tx => {
        tx.set('0','summary','changed');tx.set('1','second',{number:1});
    }),/UNIQUE/);
    await one.read(tx => {
        assert.equal(tx.get('0','summary'),undefined);
        assert.equal(tx.get('1','second'),undefined);
        assert.deepEqual(tx.get('1','first'),{number:1});
    });
});
