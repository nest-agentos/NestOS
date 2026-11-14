import {
    WS_SETTINGS, WS_WORKBENCH, WS_TOOLBOX, WS_TWIN, WS_KANBAN, WS_AGENTS, WS_NOTES,
    WS_EMAILS, WS_CALENDAR, WS_PRIVATE, WS_SKILLS, WS_FLOWS,
} from '@nestos/app-shell/workspaces';
import type { WorkspaceConfig } from '@nestos/app-shell';

export {ROUTE_ALIASES} from './route-aliases';

export const WORKSPACES: WorkspaceConfig[] = [
    WS_SETTINGS,
    WS_TOOLBOX,
    WS_TWIN,
    WS_KANBAN,
    // Extend agents mentionScope to cover all reachable content modules
    { ...WS_AGENTS, mentionScope: ['agents', 'notes', 'projects'] },
    WS_NOTES,
    WS_EMAILS,
    WS_CALENDAR,
    WS_PRIVATE,
    WS_SKILLS,
    WS_FLOWS,
    WS_WORKBENCH,
];
