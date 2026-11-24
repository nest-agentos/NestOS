import {resolveBrowserTarget} from '@nestos/app-contracts';
import type {ProjectDraftOpening, ProjectService} from '@nestos/app-contracts/services';
import {createModuleLogger, randomUUID, t} from '@nestos/common';
import {FSError} from '@nestos/vfs-core';

const log = createModuleLogger('project-draft');

export async function openProjectDraft(projects: ProjectService, path: string): Promise<ProjectDraftOpening> {
    const started = performance.now(), operationId = randomUUID();
    let stage = 'resolve-project';
    try {
        const target = resolveBrowserTarget(path);
        if (target.kind !== 'project-draft') throw new FSError('EINVAL', 'Invalid project draft target');
        const project = await projects.forFolder(target.folder);
        if (project?.path !== target.folder) throw new FSError('ENOENT', 'Project draft unavailable');
        stage = 'check-access';
        const id = project.project.id, remote = projects.remoteMounts;
        if (remote?.projectOffline(id)) throw new FSError('EIO', t('remote.projectOffline'));
        if (remote?.list(id).some(mount => mount.at === '/' && mount.access === 'ro'))
            throw new FSError('EROFS', t('project.creationReadOnly'));
        stage = 'open-composer';
        const folder = await projects.sessionFolder(project);
        const composer = await projects.drafts.open(id, folder);
        log.info('draft.open', {operationId, stage, result: 'success', durationMs: Math.round(performance.now() - started)});
        return {project, folder, composer};
    } catch (error) {
        const raw = (error as {code?: unknown})?.code;
        log.warn('draft.open', {operationId, stage, result: 'failure',
            code: typeof raw === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/.test(raw) ? raw : 'DRAFT_OPEN_FAILED',
            durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}
