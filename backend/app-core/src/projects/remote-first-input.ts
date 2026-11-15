import {FSError} from '@nestos/vfs-core';
import type {HarnessConversationJournal, HarnessReceipt, HarnessSession, ProjectClient} from '@nestos/cells-driver';

/** The node owns both native steps; the host only persists and observes their receipt. */
export function remoteFirstInput(draftId: string, profileId: string,
    invoke: (input: Parameters<NonNullable<ProjectClient['draft']>>[1]) => ReturnType<NonNullable<ProjectClient['draft']>>,
    checkAccess: () => void): NonNullable<HarnessConversationJournal['firstInput']> {
    const call = async (operationId: string, input: Parameters<NonNullable<ProjectClient['draft']>>[1]): Promise<HarnessReceipt> => {
        checkAccess();
        const {receipt} = await invoke({...input, draftId, profileId, operationId});
        if (!receipt || receipt.requestId !== operationId || !['committed','not-committed','unknown'].includes(receipt.outcome))
            throw Object.assign(new FSError('EIO', 'Invalid Cells first-input receipt'), {outcome: 'unknown'});
        return receipt;
    };
    return {
        operation: id => call(id, {action: 'submission'}),
        submit: async ({requestId, ...input}) => {
            const receipt = await call(requestId, {action: 'submit', ...input});
            if (receipt.outcome !== 'committed') throw Object.assign(new FSError('EIO', receipt.code ?? 'Cells first-input result is unknown'),
                {outcome: receipt.outcome, requestId, remoteCode: receipt.code});
            const result = receipt.result as {session: HarnessSession; turnId: string};
            if (!result || typeof result.turnId !== 'string' || !result.turnId || !result.session)
                throw Object.assign(new FSError('EIO', 'Invalid Cells first-input result'), {outcome: 'unknown', requestId});
            return result;
        },
    };
}
