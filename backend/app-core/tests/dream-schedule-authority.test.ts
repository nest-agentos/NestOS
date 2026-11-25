import {expect, it, vi} from 'vitest';
import {sha256HexSync} from '@nestos/common';
import {authorizeScheduledRound} from '../src/dream/schedule-authority';

it('accepts only a registered schedule child and rejects a forged or superseded round', async () => {
    const owner = 'owner', dream = 'dream', revision = 2, scheduledAt = 1000, nextAt = 61_000;
    const sessionId = 'dream-schedule-' + sha256HexSync(JSON.stringify([owner, dream]));
    const operationId = 'schedule-' + sha256HexSync(JSON.stringify([owner, dream, revision, scheduledAt]));
    const request = {owner, dream, configRevision: revision, operationId, scheduledAt, nextAt};
    const child = {id: 'child', program: {kind: 'dream.scan-round'}, parentTaskId: 'parent', spawnKey: 'round:1000', input: request};
    const parent = {id: 'parent', program: {kind: 'dream.schedule'}, state: {owner, dream, configRevision: revision, child: 'round:1000', nextAt}};
    let row = {owner, dream, configRevision: revision, enabled: true, recurrence: {state: 'active'}, tasks: [{revision, sessionId, taskId: 'parent'}]};
    const fs = {meta: {seq: {getEntry: async () => JSON.stringify(row)}}} as never;
    const kernel = {task: async (_session: string, id: string) => id === 'child' ? child : parent} as never;
    const authorizeOwner = vi.fn(async () => {}), context = {sessionId, taskId: 'child', effectId: 'scan', idempotencyKey: operationId} as never;
    await authorizeScheduledRound(request, context, {fs, kernel, authorizeOwner});
    expect(authorizeOwner).toHaveBeenCalledTimes(2);
    await expect(authorizeScheduledRound({...request, nextAt: 120_000}, context, {fs, kernel, authorizeOwner}))
        .rejects.toThrow('DREAM_SCHEDULE_AUTHORIZATION_FAILED');
    row = {...row, enabled: false};
    await expect(authorizeScheduledRound(request, context, {fs, kernel, authorizeOwner})).rejects.toThrow('DREAM_SCHEDULE_AUTHORIZATION_FAILED');
});
