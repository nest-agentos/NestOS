import type {EffectAdapter} from '@nestos/durable-kernel';
import type {DreamHost} from './host';
import type {DreamRoundInput} from './schedule-program';

type Result = Awaited<ReturnType<DreamHost['runAll']>>;

/** Every replay reuses the frozen batch and its per-source durable scanner identities. */
export function dreamScheduleEffect(host: Pick<DreamHost, 'runAll'>, mark: (owner: string, dream: string, revision: number, nextAt: number) => Promise<void>,
    authorize: (request: DreamRoundInput, context: import('@nestos/durable-kernel').EffectExecutionContext) => Promise<void>): EffectAdapter<DreamRoundInput, Result> {
    return {kind: 'dream.scan', version: '1', recoveryPolicy: 'idempotent-retry',
        async execute(request, context) {
            if (context.abortSignal.aborted) throw new Error('DREAM_SCHEDULE_INTERRUPTED');
            if (!request || typeof request.owner !== 'string' || typeof request.dream !== 'string'
                || typeof request.operationId !== 'string' || !Number.isSafeInteger(request.configRevision) || request.configRevision < 1
                || !Number.isSafeInteger(request.nextAt) || request.nextAt < 0 || !Number.isSafeInteger(request.scheduledAt) || request.scheduledAt < 0)
                throw new Error('DREAM_SCHEDULE_INVALID');
            await authorize(request, context);
            await mark(request.owner, request.dream, request.configRevision, request.nextAt);
            return host.runAll(request.owner, request.dream, request.operationId, request.configRevision);
        }};
}
