import type {SubmissionRequest} from '@nestos/llm-session/contracts';
import type {Kernel} from '@nestos/durable-kernel';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../projects/remote-mounts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {sessionSubmission, SessionSubmissionObservation} from '../run/session-submission';
import {failure} from '../run/prompt-bundle';
import {advanceChannelExchange} from '../run/channel-exchange';
import {channelRequests, type ChannelResponse} from '../run/channel-protocol';
import {channelMessages} from '../run/channel-results';
import {prepareChannelContinuation} from '../run/channel-session-continuation';
import {resolveCommitRequest} from './kanban-commit-query';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
export interface DevelopmentExchangeOptions {
    remote: ProjectRemoteMountService; provider: RemoteFileSourceProvider;
    kernel: Pick<Kernel, 'inspectSession' | 'sessionActivity'>; journal: KanbanAutomationJournal;
    submission: ReturnType<typeof sessionSubmission>;
}
/** Product context resolution plugs into a generic, channel-based request/response mechanism. */
export async function developmentChannelExchange(options: DevelopmentExchangeOptions, input: {id: string; record: DevelopmentWorkspaceRecord;
    service: KanbanService; base: SubmissionRequest; observation: SessionSubmissionObservation; targetHead?: string;
    finalPublished?: boolean | (() => Promise<boolean>); beforeResume?(): Promise<void>; report?(stage: string, id: string, code?: string): Promise<void>}): Promise<SessionSubmissionObservation> {
    if (input.record.channelId !== input.id) throw failure('CHANNEL_SCOPE_REQUIRED');
    const channel = (operation: 'requests' | 'respond', value: Record<string, unknown> = {}) =>
        options.remote.sessionChannel(input.record.projectId, operation, {scopeId: input.id, ...value});
    return advanceChannelExchange({id: input.id, scopeId: input.id, journal: options.journal,
        readRequests: async () => channelRequests(await channel('requests'), input.id),
        publishResponse: async response => await channel('respond', {...response}) as ChannelResponse,
        submission: options.submission, report: input.report,
        finalPublished: input.finalPublished ?? (async () => (await channelMessages(options.remote, input.record.projectId, input.id)).some(row => row.message.type === 'result')),
        resolve: request => developmentWorkspace(options.remote, options.provider, input.record.projectId,
            process => resolveCommitRequest({...options, service: input.service, record: input.record, targetHead: input.targetHead, process}, request)),
        prepare: async (id, replies) => {await input.beforeResume?.(); return prepareChannelContinuation({kernel: options.kernel, base: input.base,
            sessionId: input.observation.sessionId, connectionId: 'work-' + (input.record.worktreeId ?? input.id), id, replies});},
    }, input.observation);
}

export function developmentWorkExchange(options: DevelopmentExchangeOptions & {calls: Pick<import('@nestos/llm-session').IndependentCallService, 'list'>}) {
    return async (input: {id: string; record: DevelopmentWorkspaceRecord; service: KanbanService;
        observation: import('@nestos/kanban/execution').KanbanExecutionObservation; finalPublished?: boolean | (() => Promise<boolean>); report?(stage: string, id: string, code?: string): Promise<void>}) => {
        const sessionId = input.observation.executionSessionId;
        if (!sessionId) return input.observation;
        const original = (await options.calls.list({sessionId: input.record.worktreeId ?? input.id})).find(row => row.receipt.executionSessionId === sessionId);
        if (!original) throw Object.assign(new Error('Original Session unavailable'), {code: 'CHANNEL_ORIGIN_UNAVAILABLE'});
        const row = await developmentChannelExchange(options, {...input, base: original.input.request,
            observation: {sessionId, outcome: input.observation.outcome, code: input.observation.code}});
        return {...input.observation, outcome: row.outcome, code: row.code, outputs: row.outcome === 'succeeded' ? input.observation.outputs : undefined};
    };
}
