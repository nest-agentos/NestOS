import type {SubmissionRequest} from '@nestos/llm-session/contracts';
import type {Kernel} from '@nestos/durable-kernel';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../projects/remote-mounts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {createSessionSubmission as sessionSubmission, SessionSubmissionObservation} from '@nestos/llm-session';
import {failure} from '../run/prompt-bundle';
import {advanceChannelExchange} from '../run/channel-exchange';
import {channelRequests, type ChannelResponse} from '../run/channel-protocol';
import {resolveChannelPlugin} from '../run/channel-request-plugins';
import {serviceDiagnosticsPlugins} from '../kanban/service-diagnostics-plugin';
import {safeCode} from '@nestos/kanban/integration';
import {channelMessages} from '../run/channel-results';
import {prepareChannelContinuation} from '../run/channel-session-continuation';
import {resolveCommitRequest} from './kanban-commit-query';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {dedicatedRecoveryRequests} from '../kanban/task-recovery-channel';
export interface DevelopmentExchangeOptions {
    remote: ProjectRemoteMountService; provider: RemoteFileSourceProvider;
    kernel: Pick<Kernel, 'inspectSession' | 'sessionActivity'>; journal: KanbanAutomationJournal;
    submission: ReturnType<typeof sessionSubmission>;
    recovery?(boardId:string,itemId:string):Promise<unknown>;
    serviceControl?:import('@nestos/app-contracts/services').RuntimeServiceControl;
}
/** Product context resolution plugs into a generic, channel-based request/response mechanism. */
export async function developmentChannelExchange(options: DevelopmentExchangeOptions, input: {id: string; record: DevelopmentWorkspaceRecord;
    service: KanbanService; base: SubmissionRequest; observation: SessionSubmissionObservation; targetHead?: string;
    finalPublished?: boolean | (() => Promise<boolean>); beforeResume?(): Promise<void>; report?(stage: string, id: string, code?: string): Promise<void>}): Promise<SessionSubmissionObservation> {
    if (input.record.channelId !== input.id) throw failure('CHANNEL_SCOPE_REQUIRED');
    const channel = (operation: 'requests' | 'respond', value: Record<string, unknown> = {}) =>
        options.remote.sessionChannel(input.record.projectId, operation, {scopeId: input.id, ...value});
    return advanceChannelExchange({id: input.id, scopeId: input.id, journal: options.journal,
        readRequests: async () => {
            const rows=channelRequests(await channel('requests'),input.id);
            if(!rows.some(row=>row.request.method.startsWith('kanban.recovery.')))return rows;
            const ownsRecovery=await dedicatedRecoveryRequests(options.journal,input.id);
            return rows.filter(row=>!ownsRecovery(row.request));
        },
        publishResponse: async response => await channel('respond', {...response}) as ChannelResponse,
        submission: options.submission, report: input.report,
        finalPublished: input.finalPublished ?? (async () => (await channelMessages(options.remote, input.record.projectId, input.id)).some(row => row.message.type === 'result')),
        resolve: request => {
            if(['kanban.discover','kanban.describe','kanban.invoke'].includes(request.method))
                return resolveChannelPlugin(request,serviceDiagnosticsPlugins(options.serviceControl,options.remote,input.record.projectId))
                    .catch(error=>{throw Object.assign(failure(safeCode(error,'SERVICE_DIAGNOSTICS_QUERY_FAILED')),{channelResponse:true});});
            if(request.method.startsWith('kanban.recovery.')) {
                const scope=input.record.context as {board?:{id:string};task?:{id:string}};
                if(request.method!=='kanban.recovery.inspect'||!options.recovery||!scope.board?.id||!scope.task?.id)throw Object.assign(failure('RECOVERY_FINISH_ATTEMPT_FIRST'),{channelResponse:true});
                if(request.params.itemId!==undefined&&request.params.itemId!==scope.task.id)throw Object.assign(failure('RECOVERY_SCOPE_MISMATCH'),{channelResponse:true});
                return options.recovery(scope.board.id,scope.task.id);
            }
            return developmentWorkspace(options.remote,options.provider,input.record.projectId,process=>resolveCommitRequest({...options,service:input.service,record:input.record,targetHead:input.targetHead,process},request));
        },
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
