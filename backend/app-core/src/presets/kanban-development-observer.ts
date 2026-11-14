import {registerTaskResultRecovery} from '@nestos/kanban/integration';
import {completedPublication} from './kanban-completed-result';
import {currentNativeSessionReader} from '../kanban/native-session-observer';
import {nativeSessionActivity} from '../kanban/native-session-activity';
import {registerSessionLearnings} from '../kanban/session-learnings';
import type {ChannelMessage} from '../run/channel-results';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {consumeChannelMessages} from '../run/channel-messages';
import {createModuleLogger} from '@nestos/common';
import {DirectorySubscriptions} from '../run/directory-subscriptions';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {readContextCatalog, type ContextInspector} from '../projects/harness-context-catalog';
import type {PreparedWorktree} from '@nestos/git-delivery/worktrees';
import {journalCommand} from '@nestos/kanban/integration';
import type {IFileSystem} from '@nestos/vfs-core';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {KanbanCommand} from '@nestos/kanban/contracts';
import {unresolvedWorkIssues, type WorkMessage} from '@nestos/kanban/execution';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/resource-catalog';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {UserEventService} from '../events/service';

type Input = Parameters<NonNullable<PersonalKanbanAutomationOptions['observeWork']>>[0];
interface Options {learningService(): import('@nestos/kanban/contracts').KanbanService; exchange?: ReturnType<typeof import('./kanban-channel-exchange').developmentWorkExchange>;
    verifyDelivery?(dispatchId: string): Promise<void>;
    handoffReports?(board:string,item:string,dispatch:string,service:import('@nestos/kanban/contracts').KanbanService):Promise<unknown>;
    lifecycle?: Pick<ReturnType<typeof import('./kanban-development-lifecycle').developmentLifecycle>, 'enqueue' | 'scan' | 'dispose' | 'settled'>;
    kernel: ContextInspector; fs: IFileSystem; events: UserEventService; projects: Pick<ProjectService, 'get' | 'openWorkspace'> & Partial<Pick<ProjectService,'forFolder'>>;
    remote?: Pick<import('../projects/remote-mounts').ProjectRemoteMountService, 'projectHarness' | 'sessionChannel'> & Partial<Pick<import('../projects/remote-mounts').ProjectRemoteMountService,'sessionStatus'>>; wake(): void}

export function developmentObserver(options: Options) {
    const journal = new KanbanAutomationJournal(options.fs, kanbanJournalOptions);
    const watches = new DirectorySubscriptions(),nativeActivity=nativeSessionActivity(journal); let stopped = false;
    const sessionObservation=options.remote?.sessionStatus&&options.projects.forFolder?currentNativeSessionReader({cached:nativeActivity.read,
        status:options.remote.sessionStatus,projects:{forFolder:options.projects.forFolder.bind(options.projects)}}):nativeActivity.read;
    const observe: NonNullable<PersonalKanbanAutomationOptions['observeWork']> = async input => {
        if (stopped) return input.observation;
        const worktree = await journal.get<PreparedWorktree>('worktree:' + input.dispatch.id);
        if (!worktree) return input.observation;
        const {item} = await input.service.item(input.boardId, input.dispatch.itemId);
        const stopping = (await input.service.read(input.boardId)).lifecycle !== undefined;
        if (['failed', 'cancelled'].includes(input.observation.outcome)) {
            const started=Date.now();
            if (!stopping && item.control?.action !== 'cancel') try {await options.lifecycle?.enqueue(input.boardId, input.dispatch, item, input.observation);}
            catch (error) {
                const code = (error as {code?: string}).code;
                createModuleLogger('kanban').warn('Stopped execution postload unavailable', {operation:'kanban.observe', operationId:input.dispatch.id, stage:'lifecycle.enqueue', result:'failure',
                    code:code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'LIFECYCLE_PREPARATION_FAILED', durationMs:Date.now()-started});
            }
            await close(input.dispatch.id); return input.observation;
        }
        const projectId = item.externalRefs?.find(ref => ref.system === REMOTE_PROJECT_REFERENCE)?.id;
        if (!projectId) throw Object.assign(new Error('Missing workspace project binding'), {code: 'WORKSPACE_PROJECT_MISSING'});
        const workspace = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id);
        if (!workspace?.channelId || !options.remote) throw Object.assign(new Error('Session channel required'), {code: 'SESSION_CHANNEL_REQUIRED'});
        if(options.remote)await watches.ensure(input.dispatch.id,async()=>{
            const client=await options.remote!.projectHarness(projectId);
            try {
                if (!client.subscribeChannel) throw Object.assign(new Error('Channel subscription unavailable'), {code: 'SESSION_CHANNEL_REQUIRED'});
                const stop=client.subscribeChannel(workspace.channelId!,options.wake);
                return async()=>{stop?.();await client.close();};
            }catch(error){await client.close();throw error;}
        });
        await linkReference(journal, input, {system: 'nestos-worktree', id: workspace?.worktreeId ?? worktree.id ?? input.dispatch.id,
            revision: JSON.stringify({projectId, directory: worktree.directory, branch: worktree.branch, baseCommit: worktree.baseCommit})});
        await linkResult(options, journal, input, projectId);
        const scope = {runId: item.externalRefs?.find(ref => ref.system === 'nestos-decision-run')?.id ?? input.dispatch.planId,
            itemId: item.id, attemptId: input.dispatch.id};
        const envelope=await options.remote.sessionChannel(projectId,'messages',{scopeId:workspace.channelId}) as {messages?:unknown;execution?:{status?:string;sessionId?:string;turnId?:string;observedAt?:number}};
        await nativeActivity.record(input.boardId,input.observation.executionSessionId??input.dispatch.executionSessionId,envelope.execution);
        const completed=completedPublication(envelope as Parameters<typeof completedPublication>[0]);
        if(completed)await registerTaskResultRecovery(journal,{boardId:input.boardId,itemId:item.id,dispatchId:input.dispatch.id,resultId:completed.id});
        const messages = await consumeChannelMessages(envelope,scope,journal,
            message => deliver(options, journal, input, message), async message => {await options.remote!.sessionChannel(projectId, 'acknowledge', {scopeId: workspace.channelId, id: message.id, ack: {status: 'delivered'}});});
            const unresolved = unresolvedWorkIssues(messages);
            await reconcileIssues(journal, input, messages);
            if(envelope.execution?.sessionId&&['running','submitting'].includes(envelope.execution.status??''))return {...input.observation,outcome:'running',outputs:undefined,code:unresolved.some(message=>message.type==='error')?'WORKSPACE_ERROR_REPORTED':unresolved.some(message=>message.type==='clarification')?'WORKSPACE_INPUT_REQUIRED':undefined};
            if (options.exchange && !unresolved.length) input = {...input, observation: await options.exchange({id: input.dispatch.id, record: workspace, service: input.service, observation: input.observation,
                finalPublished: messages.some(message => message.type === 'result')})};
            if (['failed', 'cancelled'].includes(input.observation.outcome)) {
                if (!stopping) await options.lifecycle?.enqueue(input.boardId, input.dispatch, item, input.observation);
                await close(input.dispatch.id);
            }
            if (!['running','succeeded'].includes(input.observation.outcome)) return input.observation;
            if (unresolved.some(message => message.type === 'error')) return {...input.observation,outcome:'running',outputs:undefined,code:'WORKSPACE_ERROR_REPORTED'};
            if (unresolved.some(message => message.type === 'clarification')) return {...input.observation, outcome: 'running', outputs: undefined, code: 'WORKSPACE_INPUT_REQUIRED'};
            if (input.observation.outcome !== 'succeeded') return input.observation;
            if (!messages.some(message=>message.type==='result')&&messages.some(message=>message.type==='resolved'))return {...input.observation,outcome:'running',outputs:undefined,code:'WORKSPACE_RESULT_PENDING'};
            if (!messages.some(message => message.type === 'result')) return {...input.observation, outcome: 'unknown', outputs: undefined, code: 'WORKSPACE_RESULT_MISSING'};
            const publications = envelope.messages as ChannelMessage[];
            const results = publications.filter(row => row.message.type === 'result');
            if (results.length !== 1) return {...input.observation, outcome: 'unknown', outputs: undefined, code: 'CHANNEL_RESULT_INVALID'};
            const result = results[0];
            if (result) try {
                await registerSessionLearnings({boardId: input.boardId, sessionId: input.observation.executionSessionId ?? input.dispatch.executionSessionId,
                    messageId: result.id, payload: result.message.payload, publications, service: options.learningService(), journal});
            } catch (error) {
                return {...input.observation, outcome: 'unknown', outputs: undefined, code: (error as {code: string}).code};
            }
            try {await options.verifyDelivery?.(input.dispatch.id);await options.handoffReports?.(input.boardId,item.id,input.dispatch.id,input.service);}
            catch (error) {
                const raw = (error as {code?: unknown})?.code;
                const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'DELIVERY_VERIFICATION_FAILED';
                await journal.update('delivery-blocked:' + input.dispatch.id, () => ({code}));
                await deliver(options, journal, input, {schema: 'work-message/1', ...scope, id: 'delivery-' + code, type: 'error', content: code});
                if(['VERIFICATION_RUNNING_VERSION_MISMATCH','VERIFICATION_CHANGED_SOURCE'].includes(code)){
                    const failed={...input.observation,outcome:'failed' as const,outputs:undefined,code};
                    if(!stopping)await options.lifecycle?.enqueue(input.boardId,input.dispatch,item,failed);
                    await close(input.dispatch.id);return failed;
                }
                return {...input.observation, outcome: 'unknown', outputs: undefined, code};
            }
            const {item: current} = await input.worker.item(input.boardId, input.dispatch.itemId);
            if (current.blocked?.reason === 'WORKSPACE_ERROR_REPORTED' && await journal.get('delivery-blocked:' + input.dispatch.id))
                await once(journal, input, 'delivery-unblock', {type: 'unblock-item', itemId: current.id, token: input.dispatch.fence});
            if (!stopping) await options.lifecycle?.enqueue(input.boardId, input.dispatch, item, input.observation);
            if (!stopping && options.lifecycle && !await options.lifecycle.settled(input.dispatch.id, input.observation.outcome))
                return {...input.observation, outcome: 'running', outputs: undefined, code: 'LIFECYCLE_PENDING'};
            const outputs=await journal.artifact(input.dispatch.id,messages.filter(message=>message.type==='result'));
            await close(input.dispatch.id); return {...input.observation,outputs};
    };
    async function close(id:string){await watches.close(id);}
    return {observe,sessionObservation:(...args:Parameters<typeof sessionObservation>)=>stopped?nativeActivity.read(...args):sessionObservation(...args), scan: () => options.lifecycle?.scan(), async quiesce() {stopped = true; await options.lifecycle?.dispose();}, async dispose() {stopped = true; await options.lifecycle?.dispose(); await watches.dispose();nativeActivity.clear();}};
}

async function linkResult(options: Options, journal: KanbanAutomationJournal, input: Input, projectId: string): Promise<void> {
    const sessionId = input.observation.executionSessionId;
    if (!sessionId) return;
    const catalog = await readContextCatalog(options.kernel, sessionId);
    const workspace = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id);
    const binding = Object.values(catalog.value.bindings).find(binding => binding.connectionId === 'work-' + (workspace?.worktreeId ?? input.dispatch.id));
    if (!binding?.nativeRef?.sessionId) return;
    await linkReference(journal, input, {system: 'nestos-native-session', id: binding.nativeRef.sessionId,
        revision: JSON.stringify({projectId, connectionId: binding.connectionId, profileId: binding.nativeRef.profileId,
            turnId: binding.knownHeadRef, dispatchId: input.dispatch.id})});
}
async function linkReference(journal: KanbanAutomationJournal, input: Input, reference: import('@nestos/kanban/contracts').KanbanExternalReference): Promise<void> {
    const {item} = await input.service.item(input.boardId, input.dispatch.itemId);
    if (item.externalRefs?.some(ref => JSON.stringify(ref) === JSON.stringify(reference))) return;
    const key = 'workspace-reference:' + input.dispatch.id + ':' + reference.system + ':' + (reference.revision ?? '');
    await journalCommand(journal, input.service, input.boardId, key, {type: 'link-reference', itemId: item.id, reference});
}

async function deliver(options: Options, journal: KanbanAutomationJournal, input: Input, message: WorkMessage): Promise<void|{pending:true}> {
    await once(journal, input, message.id + ':log', {type: 'message', itemId: message.itemId, message: message.content, recipientSessionIds: []});
    if(message.type==='resolved') {
        await journalCommand(journal,input.service,input.boardId,'workspace-resolved:'+input.dispatch.id+':'+message.id,{type:'resolve-issue',itemId:message.itemId,attemptId:message.attemptId,issueId:message.replyTo!,resolvedBy:message.id});return;
    }
    if (!['clarification', 'error'].includes(message.type)) return;
    await journalCommand(journal,input.service,input.boardId,'workspace-issue:'+input.dispatch.id+':'+message.id,
        {type:'report-issue',itemId:message.itemId,issue:{id:message.id,attemptId:message.attemptId,type:message.type as 'clarification'|'error',...(message.handler?{handler:message.handler}:{})}});
    await once(journal, input, message.id + ':block', {type: 'block-item', itemId: message.itemId, token: input.dispatch.fence,
        reason: message.type === 'clarification' ? 'WORKSPACE_INPUT_REQUIRED' : 'WORKSPACE_ERROR_REPORTED'});
    const started=Date.now();
    try {
    await options.events.journal.transaction(async tx => {
        const key = 'work-message:' + message.attemptId + ':' + message.id;
        if (await tx.getState(key)) return;
        await tx.append(key, {type: 'kanban.workspace.' + message.type, operationId: message.attemptId,
            resourceId: 'kanban:' + JSON.stringify(['personal:user-store', input.boardId, message.itemId]), notification: message.type === 'error' ? 'error' : 'info'}, Date.now());
        await tx.setState(key, 'delivered');
    });
    }catch {
        createModuleLogger('kanban').warn('Workspace notification pending',{operation:'workspace.notify',stage:'global.notify',result:'failure',code:'WORKSPACE_NOTIFICATION_PENDING',operationId:message.id,attemptId:message.attemptId,durationMs:Date.now()-started});
        return {pending:true};
    }
}
async function once(journal: KanbanAutomationJournal, input: Input, suffix: string, command: KanbanCommand): Promise<void> {
    const key = 'workspace-command:' + input.dispatch.id + ':' + suffix;
    await journalCommand(journal, input.worker, input.boardId, key, command);
}

async function reconcileIssues(journal: KanbanAutomationJournal, input: Input, messages: WorkMessage[]): Promise<void> {
    for (const message of messages.filter(m => m.type === 'clarification' || m.type === 'error'))
        await journalCommand(journal,input.service,input.boardId,'workspace-issue:'+input.dispatch.id+':'+message.id,
            {type:'report-issue',itemId:message.itemId,issue:{id:message.id,attemptId:message.attemptId,type:message.type as 'clarification'|'error',...(message.handler?{handler:message.handler}:{})}});
    for (const message of messages.filter(m => m.type === 'resolved'))
        await journalCommand(journal,input.service,input.boardId,'workspace-resolved:'+input.dispatch.id+':'+message.id,
            {type:'resolve-issue',itemId:message.itemId,attemptId:message.attemptId,issueId:message.replyTo!,resolvedBy:message.id});
    const {item}=await input.service.item(input.boardId,input.dispatch.itemId);
    if (!unresolvedWorkIssues(messages).length && ['WORKSPACE_INPUT_REQUIRED','WORKSPACE_ERROR_REPORTED'].includes(item.blocked?.reason ?? '')
        && !await journal.get('delivery-blocked:'+input.dispatch.id))
        await journalCommand(journal,input.worker,input.boardId,'workspace-resolution-unblock:'+input.dispatch.id+':'+messages.filter(m=>m.type==='resolved').map(m=>m.id).join(':'),
            {type:'unblock-item',itemId:item.id,token:input.dispatch.fence});
}
