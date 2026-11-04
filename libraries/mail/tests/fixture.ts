import {createVFS, MemoryBackend, type IFileSystem} from '@itookit/vfs-core';
import {MailArchive} from '../src';
import type {MailDiagnostic} from '../src/contracts';
export async function write(files: IFileSystem, path: string, content: string) {
    const at = path.lastIndexOf('/');
    return files.driver.createFile({parentPath: path.slice(0, at) || '/', name: path.slice(at + 1), content, recursive: true});
}
export async function fixture(count = 25) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const files = await manager.openFileSystem('/emails'), storage = await manager.openFileSystem('/indexes');
    await write(files, '/first/one/.mail-source.json', JSON.stringify({format: 'nestos.mail-source', version: 1,
        provider: {id: 'first', name: 'First'}, account: {id: 'one', name: 'one@example.test'}, name: 'Inbox'}));
    for (let i = 0; i < count; i++) await write(files, `/first/one/${i}.email`, `Subject: Topic ${i}\nFrom: sender${i}@example.test\nTo: one@example.test\nDate: ${new Date(Date.UTC(2026, 10, 1, 0, i)).toUTCString()}\n\nBody secret${i} <script>evil()</script>`);
    const records: MailDiagnostic[] = [];
    const open = () => new MailArchive({files, storage, indexPath: '/mail/archive.seq', createOperationId: () => 'test-operation', diagnostic: record => records.push(record)});
    return {manager, files, storage, open, records};
}
