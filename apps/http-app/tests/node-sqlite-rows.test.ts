import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NodeSqliteSidecarDb} from '@nestos/node-host/storage';
import {SEQ_FIELD_PREFIX,type SeqRowSchema,type SeqRowPage,type SeqRowQuery} from '@nestos/vfs-core/seq';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const release of cleanup.splice(0).reverse()) await release();});
const schema: SeqRowSchema = {version:1,keyPrefix:'run:',columns:{label:{type:'text',nullable:true},ready:{type:'boolean'},ratio:{type:'real'}},
    indexes:[{name:'ready_label',columns:[{column:'ready',direction:'asc'},{column:'label',direction:'desc'}]}]};
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(),'node-seq-rows-')); cleanup.push(() => rm(directory,{recursive:true,force:true}));
    const file = join(directory,'index.db'), db = await NodeSqliteSidecarDb.open(file); cleanup.push(() => db.close());
    await db.rowControl('/rows.seq','seq.rows.define.v1',{schema,expectedVersion:null});
    return {db,file};
}
const query: SeqRowQuery = {select:['label','ready','ratio'],where:{column:'ready',op:'eq',value:true},orderBy:[{column:'label',direction:'desc'}],limit:1};

it('executes native SQLite projections, boolean filters and nullable cursor pages with binary Unicode order', async () => {
    const {db} = await fixture();
    for (const [key,label] of [['run:\ue000','中文'],['run:😀','中文'],['run:null',null]] as const)
        await db.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+key,JSON.stringify({label,ready:true,ratio:1.25,cold:'PRIVATE_BODY'.repeat(100)}));
    const first = await db.rowControl('/rows.seq','seq.rows.query.v1',query) as SeqRowPage;
    expect(first.rows).toEqual([{key:'run:\ue000',values:{label:'中文',ready:true,ratio:1.25}}]);
    const second = await db.rowControl('/rows.seq','seq.rows.query.v1',{...query,after:first.next}) as SeqRowPage;
    expect(second.rows[0].key).toBe('run:😀');
    expect(await db.rowControl('/rows.seq','seq.rows.query.v1',{...query,after:second.next})).toEqual({rows:[{key:'run:null',values:{label:null,ready:true,ratio:1.25}}]});
    expect(JSON.stringify(first)).not.toContain('PRIVATE_BODY');
    await expect(db.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:bad',JSON.stringify({label:'\ud800',ready:true,ratio:1}))).rejects.toMatchObject({code:'ETYPEMISMATCH'});
    await expect(db.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:bad',JSON.stringify({label:'ok',ready:1,ratio:1}))).rejects.toMatchObject({code:'ETYPEMISMATCH'});
});

it('preserves exact raw values and typed layouts across reopen and rolls a schema change and receipt back atomically', async () => {
    const {db,file} = await fixture(), raw = ' {"label":"old","ready":true,"ratio":2} ';
    await db.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:a',raw);
    await db.begin();
    await db.rowControl('/rows.seq','seq.rows.define.v1',{schema:{...schema,version:2},expectedVersion:1});
    await db.setRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:a','{"label":"new","ready":true,"ratio":3}');
    await db.setRecordField('/receipt.seq','committed',true); await db.rollback();
    const second = await NodeSqliteSidecarDb.open(file); cleanup.push(() => second.close());
    expect(await second.getRecordField('/rows.seq',SEQ_FIELD_PREFIX+'run:a')).toBe(raw);
    expect(await second.getRecordField('/receipt.seq','committed')).toBeUndefined();
    expect(await second.rowControl('/rows.seq','seq.rows.describe.v1')).toMatchObject({version:1});
    expect((await second.rowControl('/rows.seq','seq.rows.query.v1',query) as SeqRowPage).rows[0].values.ratio).toBe(2);
    await second.clearRecordFields('/rows.seq'); expect(await second.rowControl('/rows.seq','seq.rows.describe.v1')).toBeNull();
});
