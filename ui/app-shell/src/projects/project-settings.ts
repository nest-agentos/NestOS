import {t,createModuleLogger,randomUUID} from '@nestos/common';
import {projectFileSource} from '@nestos/app-contracts';
import type {ProjectFolder, ProjectService} from '@nestos/app-contracts/services';
import {showNameDialog} from '../files/project-dialog';
import {environmentFields, parseEnvironment, projectExecutionSettings} from './project-execution-settings';
import {remoteConnectionError} from '../files/remote-connection-error';

interface SettingsRecovery {configureConnection?(): Promise<void>; remount?(): Promise<void>}

/** Every entry captures its own project ID, including overflow and context menus. */
export async function showProjectSettings(projects: ProjectService, id: string, signal: AbortSignal,
    changed: (before: ProjectFolder, after: ProjectFolder) => Promise<void>, beforeSave?: (project: ProjectFolder) => Promise<void>, mountStatus?: (container: HTMLElement, signal: AbortSignal) => void,
    recovery?: SettingsRecovery): Promise<void> {
    if (signal.aborted) return;
    const lifetime = new AbortController(), stop = () => lifetime.abort();
    signal.addEventListener('abort',stop,{once:true});
    try {await openProjectSettings(projects,id,lifetime.signal,changed,beforeSave,mountStatus,recovery);}
    finally {stop(); signal.removeEventListener('abort',stop);}
}

async function openProjectSettings(projects: ProjectService, id: string, signal: AbortSignal,
    changed: (before: ProjectFolder, after: ProjectFolder) => Promise<void>, beforeSave?: (project: ProjectFolder) => Promise<void>,
    mountStatus?: (container: HTMLElement, signal: AbortSignal) => void, recovery?: SettingsRecovery): Promise<void> {
    const project = await projects.get(id), remote = projectFileSource(project, projects.remoteMounts).kind === 'remote';
    const form = await settingsEnvironment(projects,id,signal,remote,recovery);
    if (signal.aborted) return;
    const identity = document.createElement('label'); identity.textContent = t('project.id');
    const input = document.createElement('input'); input.readOnly = true; input.value = id; identity.append(input); form.panel.prepend(identity);
    if (project.protected) {const hint = document.createElement('p'); hint.textContent = t('project.localNameHint'); form.panel.prepend(hint);}
    const nameInput = document.createElement('input'); nameInput.id = 'project-settings-name';
    const status = document.createElement('section'); form.panel.prepend(status); mountStatus?.(status,signal);
    await showNameDialog(`${t('project.settings')} · ${project.displayName ?? project.name}`, t('project.name'), signal, async name => {
        if (!name || /[/\\\0]/.test(name) || ['.','..','@sessions'].includes(name)) throw new Error(t('project.error.name'));
        await beforeSave?.(project);
        await form.save();
        const latest = await projects.get(id);
        if (name !== latest.name) await projects.renameProject(latest.path, `${latest.parentPath ?? ''}/${name}`);
        await changed(project,await projects.get(id));
    }, form.panel, {initialName:project.name,nameInput,confirmLabel:t('action.confirm')});
}
async function localEnvironment(projects: ProjectService, id: string) {
    let settings = await projects.localExecutionSettings(id);
    const fields = environmentFields(settings.variables,'project.localEnvironmentHint');
    return {panel:fields.panel,save:async () => {
        const variables = parseEnvironment(fields.text.value);
        if (JSON.stringify(variables) === JSON.stringify(settings.variables)) return;
        await projects.setLocalExecution(id,settings.revision,variables);
        settings = {revision:settings.revision+1,variables};
    }};
}

async function settingsEnvironment(projects: ProjectService,id: string,signal: AbortSignal,remote: boolean,recovery?: SettingsRecovery): Promise<{panel: HTMLElement; save(): Promise<void>}> {
    const started = Date.now(), operationId = randomUUID();
    try {return remote ? await projectExecutionSettings(projects.remoteMounts!,id,signal) : await localEnvironment(projects,id);}
    catch (error) {
        if (signal.aborted) throw error;
        const raw = (error ?? {}) as {remoteCode?:string;code?:string};
        const code = raw.remoteCode ?? raw.code;
        const reason = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'ENVIRONMENT_READ_FAILED';
        createModuleLogger('project-settings').warn('project.settings.load',{operationId,projectId:id,stage:'environment-read',result:'failure',code:reason,durationMs:Date.now()-started});
        return unavailableEnvironment(projects,id,signal,remote,reason,recovery);
    }
}

function unavailableEnvironment(projects: ProjectService,id: string,signal: AbortSignal,remote: boolean,reason: string,recovery?: SettingsRecovery) {
    const panel = document.createElement('section'), message = document.createElement('p'), controls = document.createElement('div');
    const root = remote ? projects.remoteMounts?.list(id).find(mount => mount.at === '/') : undefined;
    const missingBinding = remote && (!root?.connectionId || !root.serverProjectId);
    const missingConnection = remote && !!root?.connectionId && !projects.remoteMounts?.connections().some(item => item.id === root.connectionId);
    message.textContent = t(missingConnection ? 'project.connectionMissing' : missingBinding ? 'project.bindingMissing'
        : remote ? 'project.environmentUnavailable' : 'project.localEnvironmentUnavailable',{reason});
    panel.append(message,controls);
    let current: {save(): Promise<void>} = {save: async () => {}}, busy = false;
    const button = (label: Parameters<typeof t>[0], action: () => Promise<void>) => {
        const element = document.createElement('button'); element.type = 'button'; element.textContent = t(label); controls.append(element);
        element.onclick = () => {
            if (busy || signal.aborted) return;
            busy = true; controls.querySelectorAll('button').forEach(item => {item.disabled = true;});
            void action().catch(error => {if (!signal.aborted) message.textContent = remoteConnectionError(error);})
                .finally(() => {busy = false; controls.querySelectorAll('button').forEach(item => {item.disabled = false;});});
        };
    };
    const reload = async () => {
        const next = await settingsEnvironment(projects,id,signal,remote,recovery);
        if (!signal.aborted && panel.isConnected) {current = next; panel.replaceChildren(next.panel);}
    };
    if ((missingBinding || missingConnection) && recovery?.configureConnection) button('project.configureCells', async () => {
        await recovery.configureConnection!(); panel.closest('dialog')?.dispatchEvent(new Event('cancel',{cancelable:true}));
    });
    if (remote && !missingBinding && !missingConnection && recovery?.remount) button('project.remountAndRetry',async () => {await recovery.remount!(); await reload();});
    button('application.retry',reload);
    return {panel,save:async () => {if (busy) throw new Error(t('remote.state.checking')); await current.save();}};
}
