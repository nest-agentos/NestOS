import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NodeSqliteSidecarDb} from '@nestos/node-host/storage';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function open() {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-sql-cache-'));
    cleanup.push(() => rm(directory, {recursive: true, force: true}));
    const sidecar = await NodeSqliteSidecarDb.open(path.join(directory, 'index.db'));
    cleanup.push(() => sidecar.close());
    const native = (sidecar as unknown as {db: {prepare(sql: string): unknown}}).db;
    return {sidecar, prepare: vi.spyOn(native, 'prepare')};
}

it('reuses SQL compilation while reading fresh values and preserving rollback', async () => {
    const {sidecar, prepare} = await open();
    await sidecar.setRecordField('/a.seq', 'value', 1);
    expect(await sidecar.getRecordField('/a.seq', 'value')).toBe(1);
    await sidecar.begin(); await sidecar.setRecordField('/a.seq', 'value', 2);
    expect(await sidecar.getRecordField('/a.seq', 'value')).toBe(2);
    await sidecar.rollback();
    expect(await sidecar.getRecordField('/a.seq', 'value')).toBe(1);
    await sidecar.setRecordField('/b.seq', 'other', 3);
    expect(await sidecar.getRecordField('/b.seq', 'other')).toBe(3);
    expect(prepare).toHaveBeenCalledTimes(2);
});

it('bounds the cache for variable-size batch SQL and recompiles evicted shapes', async () => {
    const {sidecar, prepare} = await open();
    for (let size = 1; size <= 140; size++) await sidecar.getRecordFieldsMany(
        Array.from({length: size}, (_, i) => ({path: '/fixture.seq', field: `field-${i}`})));
    expect((sidecar as unknown as {statements: Map<string, unknown>}).statements.size).toBe(128);
    expect(prepare).toHaveBeenCalledTimes(140);
    await sidecar.getRecordFieldsMany([{path: '/fixture.seq', field: 'field-0'}]);
    expect(prepare).toHaveBeenCalledTimes(141);
});
it('seeks binary field ranges with the composite index and preserves exact prefix semantics',async()=>{
 const {sidecar}=await open(),names=['a','A','a_%/1','a_%/2','aXother','a\\back','中文/项','😀/1','😀/2','\u{10ffff}','\u{10ffff}/next','\ufeffx','\ud7ffx','\ue000x','embedded\0key','trail\ud800'];
 const normalize=(value:string)=>new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(value));
 for(const name of names)await sidecar.setRecordField('/r',name,1);
 for(const prefix of ['','a','A','a_%/','a\\','中','😀','\u{10ffff}','\ufeff','\ud7ff','embedded\0','trail\ud800','missing']) {
  const expected=names.map(normalize).filter(name=>name.startsWith(normalize(prefix))).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  expect((await sidecar.listRecordFields('/r',prefix)).map(row=>row.field)).toEqual(expected);
  const page=await sidecar.listRecordFieldsPage('/r',prefix,0,100);expect(page.total).toBe(expected.length);expect(page.rows.map(row=>row.field)).toEqual(expected);
 }
 const {RECORD_FIELD_RANGE,recordPrefixBounds}=await import('@nestos/vfsdriver-local');
 const db=(sidecar as unknown as {db:{prepare(sql:string):{all(...values:unknown[]):Array<{detail:string}>}}}).db;
 const plan=db.prepare('EXPLAIN QUERY PLAN SELECT field,value FROM records WHERE path=? AND '+RECORD_FIELD_RANGE).all('/r',...recordPrefixBounds('a'));
 expect(plan.map(row=>row.detail).join(' ')).toMatch(/path=\? AND field>\? AND field<\?/);
});
