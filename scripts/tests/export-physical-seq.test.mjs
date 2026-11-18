import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {exportPhysicalSeq} from '../export-physical-seq.mjs';

test('exports separate indexed files from one snapshot and rejects incomplete exports',t => {
    const root = mkdtempSync(path.join(os.tmpdir(),'seq-export-'));
    t.after(() => rmSync(root,{recursive:true,force:true}));
    const input = path.join(root,'index.db'), output = path.join(root,'out');
    const db = new DatabaseSync(input);
    t.after(() => db.close());
    db.exec('CREATE TABLE records(path TEXT,field TEXT,value TEXT,PRIMARY KEY(path,field))');
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?)');
    for (const file of ['a','b']) insert.run('/data/'+file+'.seq','__vfs_seq__:k','"'+file+'"');
    assert.deepEqual(exportPhysicalSeq(input,output,['/data']),{files:2,entries:2});
    const copy = new DatabaseSync(path.join(output,'files/data/a.seq'));
    try {
        assert.equal(copy.prepare('SELECT value FROM entries WHERE key=?').get('k').value,'"a"');
        assert.match(copy.prepare('EXPLAIN QUERY PLAN SELECT value FROM entries WHERE key=?').get('k').detail,/USING (?:COVERING )?INDEX sqlite_autoindex_entries_/);
        copy.exec("CREATE UNIQUE INDEX by_value ON entries(value)");
        assert.throws(() => copy.prepare('INSERT INTO entries VALUES(?,?)').run('dup','"a"'),/UNIQUE/);
    } finally {copy.close();}
    assert.throws(() => exportPhysicalSeq(input,output,['/data']),{code:'EEXIST'});
    insert.run('/data/c.seq','foreign','{}');
    const aborted = path.join(root,'aborted');
    assert.throws(() => exportPhysicalSeq(input,aborted,['/data']),/SEQ_UNSUPPORTED_RECORD_FIELD/);
    assert.equal(existsSync(aborted),false);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,3);
});
