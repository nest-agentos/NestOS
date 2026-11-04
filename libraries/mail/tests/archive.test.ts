import {afterEach, expect, it, vi} from 'vitest';
import {fixture, write} from './fixture';
import {normalizedSubject, parseMail, SeqMailIndex} from '../src';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function archive(count = 25) {
    const f = await fixture(count); cleanup.push(() => f.manager.dispose());
    const client = f.open(); cleanup.push(() => client.dispose()); return {...f, client};
}
it('paginates twenty threads, searches the complete archive and never transports bodies in lists', async () => {
    const {client, files} = await archive(), read = vi.spyOn(files.driver, 'readContent');
    const first = await client.queryMail();
    expect(first).toMatchObject({total: 25, page: 1, pageSize: 20}); expect(first.threads).toHaveLength(20);
    expect(JSON.stringify(first)).not.toContain('secret'); expect(JSON.stringify(first)).not.toContain('evil');
    expect(read).toHaveBeenCalledTimes(26); read.mockClear();
    const second = await client.queryMail({page: 2}); expect(second.threads).toHaveLength(5); expect(read).not.toHaveBeenCalled();
    expect((await client.queryMail({search: 'sender0@'})).threads.map(row => row.subject)).toEqual(['Topic 0']);
    expect((await client.queryMail({search: 'secret0'})).total).toBe(0);
    expect((await client.queryMail({search: 'secret0', searchMode: 'content'})).total).toBe(1);
    expect((await client.queryMail({search: 'sender0 one@example.test'})).total).toBe(1);
    expect(read).not.toHaveBeenCalled();
});
it('reuses a persistent index after reopening and reads only modified message bodies', async () => {
    const f = await archive(3); await f.client.queryMail(); await f.client.dispose();
    const read = vi.spyOn(f.files.driver, 'readContent'), reopened = f.open(); cleanup.push(() => reopened.dispose());
    await reopened.queryMail(); expect(read.mock.calls.map(([path]) => path)).toEqual(['/first/one/.mail-source.json']);
    read.mockClear(); await f.files.driver.writeContent('/first/one/0.email', 'Subject: Changed\n\nUpdated searchableword');
    await reopened.refreshMail();
    expect(read.mock.calls.filter(([path]) => path.endsWith('.email')).map(([path]) => path)).toEqual(['/first/one/0.email']);
    expect((await reopened.queryMail({search: 'searchableword', searchMode: 'content'})).total).toBe(1);
    await f.files.driver.delete(['/first/one/1.email']); await reopened.refreshMail(); expect((await reopened.queryMail()).total).toBe(2);
});
it('groups reply subjects within each account and resolves legacy file links without cross-account merges', async () => {
    const f = await archive(1);
    await write(f.files, '/first/one/reply.email', 'Subject: Re: Fwd: Topic 0\nFrom: reply@example.test\n\nReply body');
    await write(f.files, '/second/two/other.email', 'Subject: Topic 0\n\nAnother account');
    const page = await f.client.queryMail(); expect(page.total).toBe(2);
    const thread = page.threads.find(row => row.sourceId === '/first/one')!; expect(thread.count).toBe(2);
    const read = vi.spyOn(f.files.driver, 'readContent');
    const opened = await f.client.readThread({id: '/first/one/reply.email'});
    expect(opened.id).toBe(thread.id); expect(opened.messages).toHaveLength(2);
    expect(opened.messages.every(message => message.sourceId === '/first/one')).toBe(true); expect(read).toHaveBeenCalledTimes(2);
    expect(normalizedSubject('RE: Fwd: 回复： Topic 0')).toBe('topic 0');
});
it('bounds thread body pages and rejects changed revisions before appending', async () => {
    const f = await archive(0);
    for (let i = 0; i < 23; i++) await write(f.files, `/first/one/${i}.email`, `Subject: Re: Same\n\nBody ${i}`);
    const list = await f.client.queryMail(); expect(list).toMatchObject({total: 1});
    const first = await f.client.readThread({id: list.threads[0].id}); expect(first.messages).toHaveLength(20); expect(first.nextOffset).toBe(20);
    const next = await f.client.readThread({id: first.id, offset: first.nextOffset, revision: first.revision}); expect(next.messages).toHaveLength(3); expect(next.nextOffset).toBeUndefined();
    await f.files.driver.delete(['/first/one/0.email']); await f.client.refreshMail();
    await expect(f.client.readThread({id: first.id, offset: 20, revision: first.revision})).rejects.toThrow('MAIL_THREAD_CHANGED');
});
it('coalesces simultaneous cold reads', async () => {
    const f = await archive(1), read = vi.spyOn(f.files.driver, 'readContent');
    await Promise.all([f.client.queryMail(), f.client.queryMail({search: 'Topic'})]); expect(read).toHaveBeenCalledTimes(2);
});
it('does not publish a stale index when a message changes during its initial scan', async () => {
    const f = await archive(1), original = f.files.driver.readContent.bind(f.files.driver);
    let release!: () => void, observed = false;
    const held = new Promise<void>(resolve => {release = resolve;});
    vi.spyOn(f.files.driver, 'readContent').mockImplementation(async (path, options: any) => {
        const content = await original(path, options);
        if (path.endsWith('/0.email') && !observed) {observed = true; await held;}
        return content;
    });
    const pending = f.client.queryMail(); await vi.waitFor(() => expect(observed).toBe(true));
    await f.files.driver.writeContent('/first/one/0.email', 'Subject: New\n\nNew'); release();
    expect((await pending).threads[0].subject).toBe('New');
});
it('reports specific failures without logging headers, queries, bodies or account names', async () => {
    const f = await archive(0);
    await write(f.files, '/broken/.mail-source.json', '{private-body'); await write(f.files, '/broken/huge.email', 'private-body'.repeat(60000));
    const page = await f.client.queryMail(); expect(page.warnings).toContain('MAIL_SOURCE_INVALID'); expect(page.warnings).toContain('MAIL_FILE_TOO_LARGE');
    vi.spyOn(f.files.driver, 'getChildren').mockRejectedValueOnce(Object.assign(new Error('private filesystem detail'), {code: 'EACCES'}));
    await expect(f.client.refreshMail()).rejects.toThrow();
    expect(f.records.some(record => record.result === 'failure' && record.code === 'EACCES')).toBe(true);
    expect(JSON.stringify(f.records)).not.toMatch(/private|example.test|secret/);
});
it('validates query bounds and preserves legacy plain drafts', async () => {
    const f = await archive(0);
    await expect(f.client.queryMail({page: -1})).rejects.toMatchObject({code: 'MAIL_QUERY_INVALID'});
    await expect(f.client.queryMail({search: 'x'.repeat(1001)})).rejects.toMatchObject({code: 'MAIL_QUERY_INVALID'});
    expect(parseMail('Legacy draft\n\nBody', 'Draft.email')).toMatchObject({subject: 'Draft.email', body: 'Legacy draft\n\nBody', from: '', date: 0});
});

it('keeps a 559-message archive to one small twenty-thread response and zero warm body reads', async () => {
    const f = await archive(559), reads = vi.spyOn(f.files.driver, 'readContent');
    const first = await f.client.queryMail();
    expect(first.total).toBe(559); expect(first.threads).toHaveLength(20);
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(20000);
    expect(reads).toHaveBeenCalledTimes(560); reads.mockClear();
    expect((await f.client.queryMail({page: 28})).threads).toHaveLength(19);
    expect((await f.client.queryMail({search: 'secret558', searchMode: 'content'})).total).toBe(1);
    expect(reads).not.toHaveBeenCalled();
});

it('logs persistence failures separately and retries safely without discarding the source archive', async () => {
    const f = await archive(1), persist = vi.spyOn(SeqMailIndex.prototype, 'write');
    persist.mockImplementationOnce(async () => {throw Object.assign(new Error('private persistence detail'), {code: 'EIO'});});
    await expect(f.client.queryMail()).rejects.toMatchObject({code: 'EIO'});
    expect(f.records.some(record => record.stage === 'index.persist' && record.code === 'EIO')).toBe(true);
    persist.mockRestore(); expect((await f.client.queryMail()).total).toBe(1);
    expect(JSON.stringify(f.records)).not.toContain('private');
});
