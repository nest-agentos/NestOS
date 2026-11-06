import {MailArchive} from '@nestos/mail';
import type {MailClient} from '@nestos/mail/contracts';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {FileSystemsPort} from '@nestos/app-contracts/services';
import {workspaceRoot} from '@nestos/app-contracts';
const log = createModuleLogger('mail');
interface Shared {refs: number; archive: Promise<MailArchive>}
const archives = new WeakMap<FileSystemsPort, Shared>();
/** One user-scoped index, with explicit leases for every opened application view. */
export async function mailView(vfs: FileSystemsPort): Promise<MailClient> {
    let shared = archives.get(vfs);
    if (!shared) {
        shared = {refs: 0, archive: Promise.all([vfs.openFileSystem(workspaceRoot('emails')), vfs.openFileSystem('/var/lib')]).then(([files, storage]) =>
            new MailArchive({files, storage, indexPath: '/mail/archive.seq', createOperationId: randomUUID,
                diagnostic: record => {if (record.result === 'failure') log.warn(record.operation, record); else log.info(record.operation, record);}}))};
        archives.set(vfs, shared);
    }
    shared.refs++;
    const held = shared; let closed = false;
    const dispose = async () => {
        if (closed) return; closed = true;
        if (--held.refs === 0) {if (archives.get(vfs) === held) archives.delete(vfs); await (await held.archive).dispose();}
    };
    try {
        const archive = await held.archive;
        const requireOpen = () => {if (closed) throw new Error('MAIL_CLOSED');};
        return {queryMail: query => {requireOpen(); return archive.queryMail(query);}, readThread: query => {requireOpen(); return archive.readThread(query);},
            confirmThreadRead: confirmation => {requireOpen(); return archive.confirmThreadRead(confirmation);},
            refreshMail: () => {requireOpen(); return archive.refreshMail();}, dispose};
    } catch (error) {held.refs--; if (!held.refs && archives.get(vfs) === held) archives.delete(vfs); throw error;}
}
