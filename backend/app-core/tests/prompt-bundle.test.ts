import {describe, expect, it, vi} from 'vitest';
import type {IFileSystem} from '@nestos/vfs-core';
import {freezePrompts, publishImmutableFile, readPrompt, type PromptJournal} from '../src/run/prompt-bundle';
import {sha256HexSync} from '@nestos/common';

it('reserves space for host operation instructions in a full project prompt bundle',async()=>{
    const journal:PromptJournal={get:async()=>undefined,update:async(_key,write)=>write(undefined)};
    const file=(name:string)=>({name,source:'fixture',content:'Instructions',sha256:sha256HexSync('Instructions')});
    const authored=Array.from({length:32},(_,index)=>file('project-'+index+'.md'));
    const host=file('management-integration-pre.md');
    await expect(freezePrompts(journal,'review',async()=>authored,[host])).resolves.toMatchObject({files:[...authored,host]});
    await expect(freezePrompts(journal,'too-many',async()=>[...authored,host])).rejects.toMatchObject({code:'PROMPT_BUNDLE_COUNT_LIMIT'});
    const resolved=[...authored,file('prerequisites.json')];
    await expect(freezePrompts(journal,'expanded-profile',async()=>resolved,[host],33)).resolves.toMatchObject({files:[...resolved,host]});
});

function fixture() {
    const bytes = new TextEncoder().encode('original');
    const node = {type: 'file', size: bytes.byteLength, modifiedAt: 1, revision: 'r1'};
    const getNode = vi.fn(async () => ({...node}));
    const readContent = vi.fn(async (_path: string, options: any) => {
        options.onRevision?.(node.revision);
        return bytes.slice().buffer;
    });
    const fs = {driver: {getNode, readContent, exists: async () => true}} as unknown as IFileSystem;
    return {fs, node, getNode, readContent};
}

describe('prompt snapshot reads', () => {
    it('re-reads after an unrelated remote validator invalidation and publishes only the accepted revision', async () => {
        const f = fixture(), revision = vi.fn();
        f.readContent.mockImplementationOnce(async (_path, options) => {
            f.node.revision = 'r2';options.onRevision?.('r2');
            return new TextEncoder().encode('original').buffer;
        });
        expect(await readPrompt(f.fs, '/prompt.md', revision)).toBe('original');
        expect(f.readContent).toHaveBeenCalledTimes(2);
        expect(revision.mock.calls).toEqual([['r2']]);
        expect(f.readContent.mock.calls[0][1]).toMatchObject({representation: 'bytes'});
    });
    it('rejects continuous changes within a bounded number of reads', async () => {
        const f = fixture(), revision = vi.fn();
        f.readContent.mockImplementation(async () => {
            f.node.revision += 'x';return new TextEncoder().encode('original').buffer;
        });
        await expect(readPrompt(f.fs, '/prompt.md', revision)).rejects.toMatchObject({code: 'PROMPT_READ_CONFLICT'});
        expect(f.readContent).toHaveBeenCalledTimes(3);expect(revision).not.toHaveBeenCalled();
    });
    it('rejects a read validator differing from both surrounding stats', async () => {
        const f = fixture();
        f.readContent.mockImplementation(async (_path, options) => {
            options.onRevision?.('other');return new TextEncoder().encode('original').buffer;
        });
        await expect(readPrompt(f.fs, '/prompt.md')).rejects.toMatchObject({code: 'PROMPT_READ_CONFLICT'});
    });
    it('retains immutable publication checks after a real edit settles', async () => {
        const f = fixture();
        f.readContent.mockImplementationOnce(async () => {
            f.node.revision = 'edited';return new TextEncoder().encode('tampered').buffer;
        });
        f.readContent.mockImplementation(async (_path, options) => {
            options.onRevision?.('edited');return new TextEncoder().encode('tampered').buffer;
        });
        await expect(publishImmutableFile(f.fs, '/', 'prompt.md', 'original')).rejects.toMatchObject({code: 'PROMPT_SNAPSHOT_CHANGED'});
    });
    it('does not retry access failures or notify a revision for invalid UTF-8', async () => {
        const f = fixture(), revision = vi.fn();
        f.readContent.mockRejectedValueOnce(Object.assign(Error('denied'), {code: 'EACCES'}));
        await expect(readPrompt(f.fs, '/prompt.md')).rejects.toMatchObject({code: 'EACCES'});
        expect(f.readContent).toHaveBeenCalledTimes(1);
        f.node.size = 1;f.readContent.mockResolvedValueOnce(new Uint8Array([255]).buffer);
        await expect(readPrompt(f.fs, '/prompt.md', revision)).rejects.toMatchObject({code: 'PROMPT_ENCODING_INVALID'});
        expect(revision).not.toHaveBeenCalled();
    });
});
