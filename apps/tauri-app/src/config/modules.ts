import type { WorkspaceConfig } from '@nestos/app-shell';
import {
    WS_SETTINGS, WS_WORKBENCH, WS_TOOLBOX, WS_TWIN, WS_KANBAN, WS_AGENTS, WS_NOTES,
    WS_EMAILS, WS_CALENDAR, WS_PRIVATE, WS_SKILLS, WS_FLOWS,
    WS_HOME,
} from '@nestos/app-shell';

export const WORKSPACES: WorkspaceConfig[] = [
    WS_SETTINGS,
    WS_TOOLBOX,
    WS_TWIN,
    WS_KANBAN,
    WS_HOME,
    WS_WORKBENCH,
    WS_EMAILS,
    WS_CALENDAR,
    WS_PRIVATE,
    WS_NOTES,
    WS_SKILLS,
    WS_FLOWS,
    { ...WS_AGENTS, mentionScope: ['agents', 'notes', 'projects', 'home'] },
];
