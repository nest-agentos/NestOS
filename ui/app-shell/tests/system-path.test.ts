import {getLogger} from '@nestos/common';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseSystemPath, resolveSystemPath, systemLineOffset} from '../src/projects/system-path';
import type {ApplicationBackend} from '@nestos/app-contracts/services';

afterEach(() => vi.unstubAllGlobals());
describe('system paths', () => {
    it('parses same-origin HTTPS paths and line numbers and rejects traversal', () => {
        vi.stubGlobal('location', {origin:'https://example.test'});
        expect(parseSystemPath('https://example.test/home/cells/a.rs:26')).toEqual({path:'/home/cells/a.rs', line:26});
        expect(parseSystemPath('https://example.test/home/cells/a.rs#L26')).toEqual({path:'/home/cells/a.rs', line:26});
        expect(() => parseSystemPath('https://elsewhere.test/a')).toThrow();
        expect(() => parseSystemPath('/workspace/../secret')).toThrow();
        expect(() => parseSystemPath('https://example.test/workspace/%2e%2e/secret')).toThrow();
    });
    it('locates the requested line and rejects out-of-range lines', () => {
        const text = Array.from({length:30}, (_, index) => `line ${index + 1}`).join('\n');
        expect(text.slice(systemLineOffset(text, 26))).toMatch(/^line 26/);
        expect(() => systemLineOffset(text, 31)).toThrow();
    });
    it('logs failure categories without file paths or raw errors', async () => {
        const projects = {openSystemPath:async () => {throw Object.assign(new Error('private-content'), {remoteCode:'EACCES'});}} as unknown as ApplicationBackend;
        await expect(resolveSystemPath(projects, 'a', '/sensitive-project/private-file')).rejects.toThrow();
        const entries = JSON.stringify(getLogger().query({modules:['system-path']}));
        expect(entries).not.toContain('sensitive-project'); expect(entries).not.toContain('private-content');
        expect(entries).toContain('EACCES');
    });
    it('uses one aggregate opening call', async () => {
        const openSystemPath = vi.fn(async () => ({project:{path:'/a'},path:'file',workspace:{}}));
        await resolveSystemPath({openSystemPath} as unknown as ApplicationBackend, 'a', '/workspace/file:26');
        expect(openSystemPath).toHaveBeenCalledExactlyOnceWith('a','/workspace/file',expect.any(String));
    });
});
