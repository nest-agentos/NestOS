import {remoteSessionPath, KANBAN_EXECUTION_SESSION} from '@nestos/app-contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {KanbanBoard} from '@nestos/kanban/contracts';

interface NativeTarget {projectId: string; profileId: string; sessionId: string}
/** Resolve explicit dispatch references before falling back to a generic context lookup. */
export function kanbanSessionResource(projects: Pick<ProjectService, 'get'>,
    fallback: (sessionId: string, branch: string) => Promise<string | undefined>) {
    const indexes = new WeakMap<KanbanBoard, {revision: number; targets: Map<string, NativeTarget[]>}>();
    return async (sessionId: string, branch: string, board?: KanbanBoard): Promise<string | undefined> => {
        if (!board) return fallback(sessionId, branch);
        let index = indexes.get(board);
        if (!index || index.revision !== board.revision) {index = {revision: board.revision, targets: nativeTargets(board)}; indexes.set(board, index);}
        const targets = [...new Map((index.targets.get(sessionId) ?? []).map(target => [JSON.stringify(target), target])).values()];
        if (targets.length !== 1) return fallback(sessionId, branch);
        const target = targets[0], project = await projects.get(target.projectId);
        return remoteSessionPath(project.path, target.profileId, target.sessionId);
    };
}
function nativeTargets(board: KanbanBoard): Map<string, NativeTarget[]> {
    const index = new Map<string, NativeTarget[]>();
    for (const item of board.items) {
        const refs = item.externalRefs ?? [];
        for (const execution of refs.filter(ref => ref.system === KANBAN_EXECUTION_SESSION)) {
            const targets = index.get(execution.id) ?? []; index.set(execution.id, targets);
            for (const native of refs.filter(ref => ref.system === 'nestos-native-session')) {
                let scope: {projectId?: unknown; profileId?: unknown; dispatchId?: unknown};
                try {scope = JSON.parse(native.revision ?? '{}');} catch {continue;}
                if (typeof scope.projectId !== 'string' || typeof scope.profileId !== 'string' ||
                    execution.revision && scope.dispatchId !== execution.revision ||
                    !refs.some(ref => ref.system === 'nestos-remote-project' && ref.id === scope.projectId)) continue;
                targets.push({projectId: scope.projectId, profileId: scope.profileId, sessionId: native.id});
            }
        }
    }
    return index;
}
