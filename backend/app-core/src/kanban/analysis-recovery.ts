import {analysisSignature, safeCode, type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanBoard, KanbanItem, KanbanService} from '@nestos/kanban/contracts';
import type {IFileSystem} from '@nestos/vfs-core';
import {recoverOperation, transientOperationFailure, type RecoveryPolicy} from '../run/operation-recovery';
import {readPrompt} from '../run/prompt-bundle';
import defaults from '../resources/kanban/kanban-recovery-policy.json';
import {requireValue} from './validation';

/** Retry only the same analysis identity and phase; execution admission stays in its journal. */
export function recoverAnalysis(options: {fs: IFileSystem; journal: KanbanAutomationJournal}, board: KanbanBoard, item: KanbanItem,
    service: KanbanService, active: () => boolean, work: () => Promise<void>): Promise<void> {
    const identity = JSON.stringify([board.id, item.id, item.launch?.analysisEpoch, item.launch?.requestedAt, analysisSignature(board, item.id)]);
    return recoverOperation({journal: options.journal, key: 'analysis-recovery:' + identity, active, retryable: transientOperationFailure,
        code: error => safeCode(error, 'AUTOMATION_RECOVERY_FAILED'), policy: () => readPolicy(options.fs),
        deferred: async recovery => {
            const current = await service.read(board.id), target = current.items.find(row => row.id === item.id);
            if (!active() || !target || target.control?.action === 'cancel' || ['completed', 'cancelled'].includes(target.status)) return;
            await service.execute(board.id, {operationId: 'analysis-recovery:' + item.id + ':' + current.revision, expectedRevision: current.revision,
                command: {type: 'report-analysis', itemId: item.id, operationId: item.id, status: {itemId: item.id, state: 'analyzing', recovery}}});
        }}, work);
}
async function readPolicy(fs: IFileSystem): Promise<RecoveryPolicy> {
    const path = '/etc/kanban/development/recovery-policy.json';
    const value: RecoveryPolicy = await fs.driver.exists(path) ? JSON.parse(await readPrompt(fs, path)) : defaults;
    requireValue(Number.isInteger(value.retries) && value.retries >= 0 && value.retries <= 100 && Number.isInteger(value.delayMs)
        && value.delayMs >= 100 && value.maxDelayMs >= value.delayMs && value.maxDelayMs <= 300000, 'RECOVERY_POLICY_INVALID');
    return value;
}
