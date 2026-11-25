import {sha256HexSync} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {EffectExecutionContext, Kernel} from '@nestos/durable-kernel';
import {DREAM_SCHEDULE_INDEX, dreamScheduleKey, type DreamScheduleRow} from './config-store';
import type {DreamRoundInput} from './schedule-program';

/** Only a child of the currently registered schedule may advance its cursor or scan. */
export async function authorizeScheduledRound(request: DreamRoundInput, context: EffectExecutionContext,
    dependencies: {fs: IFileSystem; kernel: Pick<Kernel, 'task'>; authorizeOwner(owner: string): Promise<void>}): Promise<void> {
    await dependencies.authorizeOwner(request.owner);
    const session = 'dream-schedule-' + sha256HexSync(JSON.stringify([request.owner, request.dream]));
    const operation = 'schedule-' + sha256HexSync(JSON.stringify([request.owner, request.dream, request.configRevision, request.scheduledAt]));
    if (context.sessionId !== session || context.effectId !== 'scan' || context.idempotencyKey !== operation || request.operationId !== operation)
        throw new Error('DREAM_SCHEDULE_AUTHORIZATION_FAILED');
    const child = await dependencies.kernel.task(session, context.taskId);
    if (child.program.kind !== 'dream.scan-round' || !child.parentTaskId || child.spawnKey !== `round:${request.scheduledAt}`
        || JSON.stringify(child.input) !== JSON.stringify(request)) throw new Error('DREAM_SCHEDULE_AUTHORIZATION_FAILED');
    const parent = await dependencies.kernel.task(session, child.parentTaskId);
    const state = parent.state as {owner?: string; dream?: string; configRevision?: number; child?: string; nextAt?: number} | undefined;
    const raw = await dependencies.fs.meta.seq!.getEntry(DREAM_SCHEDULE_INDEX, dreamScheduleKey(request.owner, request.dream));
    const row = raw ? JSON.parse(raw) as DreamScheduleRow : undefined;
    if (parent.program.kind !== 'dream.schedule' || state?.owner !== request.owner || state.dream !== request.dream
        || state.configRevision !== request.configRevision || state.child !== child.spawnKey || state.nextAt !== request.nextAt
        || row?.configRevision !== request.configRevision || !row.enabled || row.recurrence.state !== 'active'
        || !row.tasks?.some(item => item.revision === request.configRevision && item.sessionId === session && item.taskId === parent.id))
        throw new Error('DREAM_SCHEDULE_AUTHORIZATION_FAILED');
    await dependencies.authorizeOwner(request.owner);
}
