import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@nestos/vfs-core';
import { SessionRepository, RoundLog, type Round } from '@nestos/llm-session';
import { NestosTwinSourceReader } from '../src/digital-twin/source-reader';
import type {ProjectService} from '@nestos/app-contracts/services';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), repository = new SessionRepository(fs);
    await repository.init(); cleanup.push(() => repository.dispose());
    return { fs, repository, reader: new NestosTwinSourceReader(fs, repository) };
}
it('reads only authorized ordinary VFS documents and rejects private paths, protected ancestors and oversized sources', async () => {
    const { fs, reader } = await setup();
    await fs.driver.createFile({ parentPath: '/home/admin/notes', name: 'source.md', content: 'public source', recursive: true });
    expect((await reader.read({ kind: 'file', target: '/home/admin/notes/source.md', label: '' })).text).toBe('public source');
    for (const target of ['/var/lib/kernel/input.md', '/home/admin/private/note.md', '/home/admin/notes/../private/note.md', '/home/admin/.config/secrets.md']) {
        await expect(reader.read({ kind: 'file', target, label: '' })).rejects.toThrow('SOURCE_SCOPE');
    }
    await fs.driver.createFile({ parentPath: '/home/admin/notes', name: 'protected.md', content: 'secret', metadata: { isProtected: true }, recursive: true });
    await expect(reader.read({ kind: 'file', target: '/home/admin/notes/protected.md', label: '' })).rejects.toThrow('PRIVATE_SOURCE');
    await fs.driver.createFile({ parentPath: '/home/admin/notes', name: 'large.md', content: 'x'.repeat(1024 * 1024 + 1), recursive: true });
    await expect(reader.read({ kind: 'file', target: '/home/admin/notes/large.md', label: '' })).rejects.toThrow('SOURCE_LIMIT');
});
it('preserves user and assistant attribution while excluding system prompts, thinking and tool outputs from native history', async () => {
    const { reader, repository } = await setup();
    const id = await repository.createSession('Native history');
    const log = new RoundLog(repository, id);
    const round: Round = { id: 'round', kind: 'chat', historyParentIds: [], origin: 'user', status: 'completed', createdAt: 1,
        input: [{ role: 'user', content: '我决定使用 Alpha。' }, { role: 'system', content: 'SECRET_SYSTEM_PROMPT' }],
        output: [{ role: 'assistant', content: '建议考虑 Beta。', thinking: 'SECRET_REASONING' }, { role: 'tool', content: 'SECRET_TOOL_OUTPUT' }] };
    await log.append('main', round);
    const content = await reader.read({ kind: 'session', target: id, label: '' });
    expect(content.text).toContain('我决定使用 Alpha'); expect(content.text).toContain('建议考虑 Beta');
    expect(content.text).toContain('"role":"user"'); expect(content.text).toContain('"role":"assistant"');
    expect(content.text).not.toContain('SECRET');
});

it('reads only the selected bounded head window without listing sessions', async () => {
    const {reader, repository} = await setup();
    const id = await repository.createSession('Window');
    const log = new RoundLog(repository, id);
    for (let index = 0; index < 3; index++) await log.append('main', {id: `round-${index}`, kind: 'chat',
        historyParentIds: index ? [`round-${index - 1}`] : [], origin: 'user', status: 'completed', createdAt: index + 1,
        input: [{role: 'user', content: `message-${index}`}], output: []});
    const read = vi.spyOn(RoundLog.prototype, 'readRound'), list = vi.spyOn(repository, 'listSummaryPage');
    try {
        const window = await reader.readSessionWindow(id, 2);
        expect(window.text).toContain('message-1'); expect(window.text).toContain('message-2'); expect(window.text).not.toContain('message-0');
        expect(window).toMatchObject({scannedRounds: 2, hasOlder: true});
        expect(read).toHaveBeenCalledTimes(2); expect(list).not.toHaveBeenCalled();
    } finally {read.mockRestore(); list.mockRestore();}
});

it('reads a provenance-filtered bounded native page and fences its history revision', async () => {
    const {fs, repository} = await setup();
    const session = {id: 'session', title: 'Remote', cwd: null, status: 'idle', createdAt: 1, updatedAt: 2, resumable: true, historyRevision: 'a'.repeat(64)};
    const value = {version: 1, session, revision: 'b'.repeat(64), omittedUnclassified: 0, nextCursor: 'older', scan: {historyBytes: 900, contextBytes: 40},
        messages: [0, 1, 2].map(index => ({id: `message-${index}`, turnId: `turn-${index}`, role: 'user', text: `message-${index}`}))};
    const digest = vi.fn(async (..._args: unknown[]) => structuredClone(value));
    const close = vi.fn(async () => {}), list = vi.fn(), read = vi.fn();
    const projects = {remoteMounts: {list: () => [{at: '/', connectionId: 'connection', serverId: 'node', serverProjectId: 'remote'}],
        projectHarness: async () => ({digest, read, close, list})}} as unknown as ProjectService;
    const reader = new NestosTwinSourceReader(fs, repository, projects);
    const result = await reader.readHarnessWindow('project', 'profile', 'session', 2);
    expect(result.text).toContain('message-1'); expect(result.text).toContain('message-2'); expect(result.text).not.toContain('message-0');
    expect(result).toMatchObject({scannedRounds: 3, hasOlder: true, historyBytes: 900, contextBytes: 40});
    expect(digest).toHaveBeenCalledTimes(3);
    expect(digest.mock.calls[1][2]).toMatchObject({expectedRevision: value.revision});
    expect(digest.mock.calls[2][2]).toMatchObject({metadataOnly: true, expectedRevision: value.revision});
    expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    digest.mockImplementationOnce(async () => structuredClone(value))
        .mockImplementationOnce(async () => ({...structuredClone(value), revision: 'c'.repeat(64)}));
    await expect(reader.readHarnessWindow('project', 'profile', 'session', 2)).rejects.toThrow('TWIN_SOURCE_CHANGED');
    digest.mockResolvedValueOnce(structuredClone(value)).mockResolvedValueOnce({...structuredClone(value), omittedUnclassified: 1});
    await expect(reader.readHarnessWindow('project', 'profile', 'session', 2)).rejects.toThrow('TWIN_DIGEST_UNAVAILABLE');
    digest.mockResolvedValueOnce(structuredClone(value)).mockResolvedValueOnce({...structuredClone(value), scan: undefined} as never);
    await expect(reader.readHarnessWindow('project', 'profile', 'session', 2)).rejects.toThrow('TWIN_DIGEST_UNAVAILABLE');
    digest.mockClear();
    expect(await reader.readHarnessWindow('project', 'profile', 'session', 2, result.cursor)).toMatchObject({text: '', historyBytes: 0, contextBytes: 0});
    expect(digest).toHaveBeenCalledOnce(); expect(digest.mock.calls[0][2]).toMatchObject({metadataOnly: true});
});

it('accepts a Harness digest up to 256 KiB and rejects an oversized one', async () => {
    const {fs, repository} = await setup();
    const session = {id: 'session', title: 'Remote', cwd: null, status: 'idle', createdAt: 1, updatedAt: 2, resumable: true, historyRevision: 'a'.repeat(64)};
    const value = {version: 1, session, revision: 'b'.repeat(64), omittedUnclassified: 0, nextCursor: null,
        scan: {historyBytes: 300000, contextBytes: 0}, messages: [{id: 'm', turnId: 'turn', role: 'user', text: 'x'.repeat(200 * 1024)}]};
    const digest = vi.fn(async () => structuredClone(value));
    const projects = {remoteMounts: {list: () => [{at: '/', connectionId: 'connection', serverId: 'node', serverProjectId: 'remote'}],
        projectHarness: async () => ({digest, close: async () => {}})}} as unknown as ProjectService;
    const reader = new NestosTwinSourceReader(fs, repository, projects);
    expect((await reader.readHarnessWindow('project', 'profile', 'session', 1)).text.length).toBeGreaterThan(32 * 1024);
    const overhead = new TextEncoder().encode(JSON.stringify([{...value.messages[0], text: ''}])).length;
    value.messages[0].text = 'x'.repeat(256 * 1024 - overhead);
    expect(new TextEncoder().encode((await reader.readHarnessWindow('project', 'profile', 'session', 1)).text).length).toBe(256 * 1024);
    value.messages[0].text += 'x';
    await expect(reader.readHarnessWindow('project', 'profile', 'session', 1)).rejects.toThrow('TWIN_SOURCE_LIMIT');
});
