import type {TaskHandle} from '@nestos/durable-kernel';
import {TwinSafePoint} from './analysis-lifecycle';

/** Kernel observation abort is distinct from cancelling the persisted collection. */
export async function waitCollection(task: Pick<TaskHandle, 'wait'>, signal?: AbortSignal) {
    try {return await task.wait({until: 'settled', timeoutMs: 180000, signal});}
    catch (error) {if (signal?.aborted && signal.reason instanceof TwinSafePoint) throw signal.reason; throw error;}
}
