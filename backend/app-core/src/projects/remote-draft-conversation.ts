import type { HarnessClient, HarnessConversationJournal, HarnessConversationPort, HarnessConversationSnapshot, HarnessReceipt } from '@nestos/cells-driver';
import type { RemoteConversationStore } from './remote-conversation-store';
import {formatDefaultFileTitle, t} from '@nestos/common';
import {FSError} from '@nestos/vfs-core';
import {diagnosticFailure} from '../diagnostics/failure';
import {reportRemoteFailure} from './remote-diagnostics';

export function remoteConversationJournal(recovery: RemoteConversationStore, epoch: string, draft: boolean, checkAccess = () => {}, sessionId?: string): HarnessConversationJournal {
    return {epoch, instructions:{
        enqueue:item=>recovery.queueSession({action:'enqueue',item,input:JSON.stringify([item.text,item.attachments,item.selection??null,item.commandKind??null,...(item.allowSteer?[true]:[])])}),
        edit:(edit,binding)=>recovery.queueSession({action:'edit',edit:{...edit,...(binding?{commandBinding:binding}:{})}}),
    }, recoverSession: input=>{checkAccess();return recovery.recoverSession(input);}, load: async () => {
        checkAccess();
        let record = await recovery.load();
        if (sessionId && record?.sessionId !== sessionId) {
            if (record?.sessionId) throw new FSError('ECONFLICT', 'Native recovery session binding changed');
            const started = Date.now();
            try {await recovery.save({...record, sessionId}); record = await recovery.load();}
            catch (error) {console.warn('[Harness] Session binding', {operation: 'harness.journal', stage: 'session-bind', result: 'failure', sessionId, ...diagnosticFailure(error), durationMs: Date.now() - started}); throw error;}
            console.info('[Harness] Session binding', {operation: 'harness.journal', stage: 'session-bind', result: 'success', sessionId, durationMs: Date.now() - started});
        }
        if (draft && record?.submittedTurnId && !hasRecoveryWork(record)) { await recovery.save({}); return undefined; }
        return record;
    }, save: record => {checkAccess(); return recovery.save({...record, submittedTurnId: record.submittedTurnId ?? recovery.submittedTurnId});}};
}

function hasRecoveryWork(record: import('@nestos/cells-driver').HarnessRecovery): boolean {
    return !!(record.pending || record.responses?.length || record.draft || record.draftAttachments?.length
        || record.instructionQueue?.items.length || record.controls?.some(row => row.receipt === 'pending' || row.receipt === 'accepted' && !row.terminal));
}

/** A native create is provisional until the first turn has a committed receipt. */
export function draftHarness(client: HarnessClient, recovery: RemoteConversationStore): HarnessClient {
    return new Proxy(client, {get: (target, key) => {
        if (key === 'turn') return async (...args: Parameters<HarnessClient['turn']>) => {
            const result = await target.turn(...args);
            await persistNativeAdmission(recovery, result.turnId); return result;
        };
        if (key === 'command' && target.command) return async (...args: Parameters<NonNullable<HarnessClient['command']>>) => {
            const result = await target.command!(...args);
            if (result.turnId) await persistNativeAdmission(recovery, result.turnId);
            return result;
        };
        if (key === 'operation') return async (...args: Parameters<HarnessClient['operation']>) => {
            const receipt: HarnessReceipt = await target.operation(...args);
            const result = receipt.result as {turnId?: unknown} | undefined;
            if (receipt.outcome === 'committed' && typeof result?.turnId === 'string') await persistNativeAdmission(recovery, result.turnId);
            return receipt;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    }});
}

async function persistNativeAdmission(recovery: RemoteConversationStore, turnId: string): Promise<void> {
    try {await recovery.submitted(turnId);}
    catch (error) {
        // A rejected metadata write does not reject the already admitted native operation.
        throw Object.assign(error instanceof Error ? error : new FSError('EIO', 'Native admission persistence failed'), {outcome: 'unknown'});
    }
}

/** Hide provisional identities from navigation without changing native ownership. */
export function draftConversation(source: HarnessConversationPort, recovery: RemoteConversationStore, draftTitle?: string): HarnessConversationPort {
    let initialTitle: string | undefined;
    const snapshot = (): HarnessConversationSnapshot => {
        const state = source.snapshot(), submittedTurnId = state.submittedTurnId ?? recovery.submittedTurnId;
        return {...state, submittedTurnId, sessionId: submittedTurnId ? state.sessionId : undefined,
            title: submittedTurnId ? state.title : t('harness.create')};
    };
    return new Proxy(source, {get: (target, key) => {
        if (key === 'snapshot') return snapshot;
        const value = Reflect.get(target, key, target);
        if (key === 'subscribe') return value.bind(target);
        return typeof value === 'function' ? async (...args: unknown[]) => {
            const submitted = !!recovery.submittedTurnId;
            const result = await Reflect.apply(value, target, args);
            if (key === 'rename') initialTitle = undefined;
            if (!submitted && snapshot().submittedTurnId) initialTitle ??= draftTitle ?? formatDefaultFileTitle();
            if (initialTitle && source.snapshot().title === initialTitle) initialTitle = undefined;
            if (initialTitle && ['send', 'command', 'reconcile', 'refresh'].includes(String(key)) && source.snapshot().canRename && source.rename) {
                try { await source.rename(initialTitle); initialTitle = undefined; }
                catch (error) { reportRemoteFailure(error, {stage: 'draft.rename', sessionId: source.snapshot().sessionId}); }
            }
            return result && typeof result === 'object' && 'messages' in result ? snapshot() : result;
        } : value;
    }});
}
