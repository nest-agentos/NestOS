import {createModuleLogger, randomUUID} from '@nestos/common';
import {IndependentCallCommand, SessionCommand, type IndependentCallView, type RootTargetCatalog, type SessionInstructionQueue} from '@nestos/llm-session/contracts';
import type {LocalApplicationServices, SessionEditorInitialData, SessionPresentationState, WorkbenchChatControls} from '@nestos/app-contracts/services';
import {agentProjectScopes} from '../configuration/agent-project-scope';
import {readTaskAttachment} from './task-attachment';
import type {ViewObservation} from './view-observation';

const log = createModuleLogger('session-editor-presentation');

export async function prepareEditorPresentation(services: LocalApplicationServices, observation: ViewObservation,
    chat: WorkbenchChatControls, initial: SessionEditorInitialData, projectId?: string, taskAttachmentKey?: string): Promise<SessionPresentationState> {
    const sessionId = initial.sessionId, cursor = observation.getViewCursor();
    const operationId = randomUUID(), started = performance.now();
    const [targets, independentCalls, skills, recovery, queue] = await Promise.allSettled([
        readEditorTargets(services, projectId),
        services.commandBus.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId, branchId: initial.manifest.currentBranch}),
        chat.sessionSkills.list(sessionId),
        taskAttachmentKey ? readTaskAttachment(services, sessionId, taskAttachmentKey) : undefined,
        initial.snapshot.instructionQueue ?? services.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue),
    ]);
    const fields = {operationId, sessionId, durationMs: Math.round(performance.now() - started)};
    reportPresentation(fields, {targets, independentCalls, skills, recovery, queue});
    return {
        presentationCursor: cursor,
        targets: targets.status === 'fulfilled' && !observation.changedSince(cursor, ['configuration', 'agents']) ? targets.value : undefined,
        independentCalls: independentCalls.status === 'fulfilled' && !observation.changedSince(cursor, ['kernel', 'repository'], sessionId) ? independentCalls.value : undefined,
        skills: skills.status === 'fulfilled' && !observation.changedSince(cursor, ['skills', 'agents'], sessionId) ? skills.value : undefined,
        taskAttachment: recovery.status === 'fulfilled' && !observation.changedSince(cursor, ['kernel', 'session'], sessionId) ? recovery.value : undefined,
        instructionQueue: queue.status === 'fulfilled' && queue.value?.sessionId === sessionId
            && !observation.changedSince(cursor, ['session'], sessionId) ? queue.value : undefined,
    };
}

async function readEditorTargets(services: LocalApplicationServices, projectId?: string): Promise<RootTargetCatalog> {
    const catalog = await services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const ids = [...new Set(catalog.entries.filter(entry => entry.target.kind === 'agent').map(entry => entry.target.id))];
    if (!ids.length) return catalog;
    const scopes = await agentProjectScopes(services.vfs, services.projects).read(ids);
    return {...catalog, entries: catalog.entries.filter(({target}) => {
        const scope = scopes[target.id];
        return target.kind !== 'agent' || scope?.kind !== 'selected' || !!projectId && scope.projectIds.includes(projectId);
    })};
}

function reportPresentation(fields: {operationId: string; sessionId: string; durationMs: number}, sections: Record<string, PromiseSettledResult<unknown>>): void {
    let failed = false;
    for (const [stage, result] of Object.entries(sections)) {
        if (result.status === 'fulfilled') continue;
        failed = true;
        const code = (result.reason as {code?: unknown} | undefined)?.code;
        log.warn('session.editor.prepare', {...fields, stage, result: 'failure',
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'EDITOR_PRESENTATION_READ_FAILED'});
    }
    if (!failed) log.debug('session.editor.prepare', {...fields, stage: 'metadata', result: 'success'});
}
