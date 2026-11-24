import {expect, it, vi} from 'vitest';
import {PromptHistoryService} from '../src/services/prompt-history-service';

it('persists explicit prompts separately and serializes concurrent saves', async () => {
    const files = new Map<string, string>();
    const driver = {exists: async (path: string) => files.has(path), readContent: async (path: string) => files.get(path)!,
        writeContent: async (path: string, content: string) => {files.set(path, content);},
        createFile: async ({parentPath, name, content}: {parentPath: string; name: string; content: string}) => {files.set(`${parentPath}/${name}`, content);}};
    const fs = {driver} as never, first = new PromptHistoryService(fs), second = new PromptHistoryService(fs);
    await Promise.all([first.savePrompt('one', '00000000-0000-4000-8000-000000000001'), second.savePrompt('two', '00000000-0000-4000-8000-000000000002'), first.savePrompt('one', '00000000-0000-4000-8000-000000000003')]);
    expect(await second.listSaved()).toEqual(['two', 'one']);
    await second.savePrompt('one', '00000000-0000-4000-8000-000000000001');
    await expect(second.savePrompt('different', '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({code: 'OPERATION_CONFLICT'});
    expect(files.has('/__config/history.yaml')).toBe(false);
});

it('propagates a storage failure without reporting success', async () => {
    const driver = {exists: vi.fn(async () => false), createFile: vi.fn(async () => {throw Object.assign(new Error('denied'), {code: 'EACCES'});})};
    const service = new PromptHistoryService({driver} as never);
    await expect(service.savePrompt('private', '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({code: 'EACCES'});
    expect(await service.listSaved()).toEqual([]);
});
