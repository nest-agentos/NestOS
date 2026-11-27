import {createModuleLogger, getLocale, randomUUID, t} from '@nestos/common';
import type {DreamService, ProjectService} from '@nestos/app-contracts/services';
import {DreamPage as PortableDreamPage, type DreamViewHost} from '@nestos/dream-ui';
import '@nestos/dream-ui/style.css';

type Project = Awaited<ReturnType<ProjectService['list']>>[number];

const host: DreamViewHost = {
    translate: (key, values) => t(key as Parameters<typeof t>[0], values),
    locale: getLocale,
    randomUUID,
    log: createModuleLogger('dream-page'),
};

export class DreamPage extends PortableDreamPage {
    constructor(service: DreamService, projects: ProjectService, openSession: (id: string) => Promise<void>,
        openTask: (board: string, item: string) => Promise<void>,
        openDecision: (board: string, record: string) => Promise<void>, project?: Project) {
        super(service, projects, openSession, openTask, openDecision, host, project);
    }
}
