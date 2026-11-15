import { escapeHTML, t, createModuleLogger, randomUUID } from '@nestos/common';
import type { ProjectService, ProjectFolder } from '@nestos/app-contracts/services';

const log = createModuleLogger('webdav-mount');

/** Configuration and observation never call this explicit user action. */
export async function showWebDavMountDialog(projects: ProjectService, connectionId: string): Promise<void> {
    const catalog = (await projects.list()).filter(project => project.project.source?.kind !== 'remote');
    const dialog = document.createElement('dialog'); dialog.className = 'session-mount-dialog';
    dialog.innerHTML = template(catalog); document.body.append(dialog); dialog.showModal();
    await bindDialog(dialog, projects, connectionId, catalog);
}
function template(catalog: ProjectFolder[]): string {
    return `<form><h2>${escapeHTML(t('webdav.mount'))}</h2>
        <label>${escapeHTML(t('cells.project'))}<select name="project" required>${catalog.map(project => `<option value="${escapeHTML(project.project.id)}">${escapeHTML(project.displayName ?? project.name)}</option>`).join('')}</select></label>
        <label>${escapeHTML(t('cells.remoteDirectory'))}<input name="root" value="/" required></label>
        <label>${escapeHTML(t('cells.mountPoint'))}<input name="at" value="/webdav" required pattern="/[a-zA-Z0-9_-]+"></label>
        <label>${escapeHTML(t('cells.access'))}<select name="access"><option value="ro">${escapeHTML(t('cells.readOnly'))}</option><option value="rw">${escapeHTML(t('cells.readWrite'))}</option></select></label>
        <p>${escapeHTML(t('webdav.mountHint'))}</p><p role="status"></p>
        <button type="submit" ${catalog.length?'':'disabled'}>${escapeHTML(t('webdav.mount'))}</button><button type="button">${escapeHTML(t('cells.cancel'))}</button></form>`;
}
function bindDialog(dialog: HTMLDialogElement, projects: ProjectService, connectionId: string, catalog: ProjectFolder[]): Promise<void> {
    return new Promise(resolve => {
        let busy = false;
        const close = () => { if (!busy) {dialog.close(); dialog.remove(); resolve();} };
        dialog.oncancel = event => {event.preventDefault(); close();};
        dialog.querySelector<HTMLButtonElement>('button[type=button]')!.onclick = close;
        const form = dialog.querySelector('form')!;
        form.onsubmit = event => {
            event.preventDefault(); if (busy) return; busy=true;
            dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled=true);
            void mount(projects, connectionId, catalog, new FormData(form)).then(() => {busy=false; close();}).catch(error => {
                dialog.querySelector('[role=status]')!.textContent=error instanceof Error?error.message:t('cells.failed');
            }).finally(() => {busy=false; dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled=false);});
        };
    });
}
async function mount(projects: ProjectService, connectionId: string, catalog: ProjectFolder[], fields: FormData): Promise<void> {
    const operationId=randomUUID(), started=performance.now(), connection=projects.remoteMounts!.connection(connectionId);
    try {
        const project=catalog.find(item=>item.project.id===fields.get('project'));
        if (!project) throw new Error(t('cells.missing'));
        const owner=await projects.openFiles(project.path);
        try { await projects.remoteMounts!.add(project.project.id, {connectionId, protocol:'webdav', endpoint:connection.endpoint, alias:'webdav',
            root:String(fields.get('root')), at:String(fields.get('at')), access:fields.get('access')==='rw'?'rw':'ro'}, '', owner.fs, {timeoutMs:10000}); }
        finally {await owner.dispose();}
        log.info('webdav.mount.finished', {operationId, stage:'mount', result:'success', durationMs:performance.now()-started});
    } catch (error) {
        log.warn('webdav.mount.finished', {operationId, stage:'mount', result:'failure', code:(error as {code?:string})?.code??'EIO', durationMs:performance.now()-started});
        throw error;
    }
}
