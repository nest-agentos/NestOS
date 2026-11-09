import {attachmentMetadata} from '../contracts/chat';
import {identifyRuntimeAttachments} from './attachment-integrity';
import type { InstructionQueueEdit, SessionInstruction, SessionInstructionInput, SessionInstructionQueue } from '../contracts/instruction-queue';
import type { SessionStatus } from '../core/types';
import type { InstructionQueueStore, StoredInstructionQueue } from '../persistence/instruction-queue-store';
import { instructionQueueProjection } from '../persistence/instruction-queue-store';
import type { SessionHost } from '../utils/host-ports';
import { assertInstructionSize, assertPreparedInstruction, editInstructionQueue, prepareInstruction, instructionDigest, queueError } from './instruction-queue-rules';
import { ulid } from '../persistence/ulid';

export interface InstructionQueuePorts {
    store: Pick<InstructionQueueStore, 'read' | 'write'>;
    host: SessionHost;
    assertWritable(sessionId: string): Promise<void>;
    branch(sessionId: string): Promise<string>;
    ready(sessionId: string): Promise<boolean>;
    submit(sessionId: string, item: SessionInstruction): Promise<string>;
    recover(sessionId: string, item: SessionInstruction): Promise<'running' | 'completed' | 'failed' | 'uncertain'>;
    inspect?(sessionId: string, item: SessionInstruction, stop: boolean): Promise<SessionInstruction['observation']>;
    mark?(sessionId: string): Promise<void>;
    unmark?(sessionId: string): Promise<void>;
    prepare?(sessionId: string, item: SessionInstruction, immediate: boolean): Promise<SessionInstruction>;
    revise?(sessionId: string, item: SessionInstruction): Promise<SessionInstruction>;
    capture?(sessionId: string, item: SessionInstruction, source: SessionInstructionInput): Promise<SessionInstruction>;
    intercept?(sessionId: string, item: SessionInstruction): Promise<boolean>;
    previouslyAccepted?(sessionId: string, item: SessionInstruction, digest: string): Promise<boolean>;
    changed(queue: SessionInstructionQueue): void;
    idle?(sessionId: string): void;
}

/** Backend-owned queue. CAS arbitrates competing clients; local tails serialize dispatch and edits. */
export class SessionInstructionQueues {
    private readonly tails = new Map<string, Promise<unknown>>();
    private readonly active = new Map<string, string>();
    private readonly observed = new Map<string, number>();
    private readonly tracked = new Set<string>();
    private closed = false;
    private readonly inspections = new Map<string, Promise<void>>();
    private readonly inspectAgain = new Set<string>();
    constructor(private readonly ports: InstructionQueuePorts) {}

    get(sessionId: string): Promise<StoredInstructionQueue> { return this.ports.store.read(sessionId); }
    async view(sessionId: string): Promise<SessionInstructionQueue> {
        const queue = instructionQueueProjection(await this.get(sessionId));
        const item = queue.items[0];
        if (item && ['dispatching', 'uncertain'].includes(item.state) && this.ports.inspect)
            item.observation = await this.ports.inspect(sessionId, item, false);
        return queue;
    }
    observe(sessionId: string): Promise<void> {
        if (this.closed || !this.tracked.has(sessionId)) return Promise.resolve();
        const current = this.inspections.get(sessionId);
        if (current) {this.inspectAgain.add(sessionId); return current;}
        const pending = (async () => {
            do {
                this.inspectAgain.delete(sessionId);
                try {if (!this.closed) this.ports.changed(await this.view(sessionId));}
                catch (error) {this.log('inspect', sessionId, ulid(), error, 0);}
            } while (!this.closed && this.inspectAgain.has(sessionId));
        })().finally(() => this.inspections.delete(sessionId));
        this.inspections.set(sessionId, pending);
        return pending;
    }
    hasWork(owns: (sessionId: string) => boolean): boolean { return [...this.tails.keys()].some(owns); }

    enqueue(sessionId: string, input: SessionInstructionInput): Promise<string> {
        const snapshot = structuredClone({ ...input, files: input.files.map(file => ({
            ...attachmentMetadata(file), fileRef: file.fileRef,
        })) });
        return this.serialize(sessionId, async () => this.accept(sessionId, {...snapshot,
            files: await identifyRuntimeAttachments(snapshot.files)}), 'enqueue', input.sendIntent?.submission?.id);
    }

    private async accept(sessionId: string, snapshot: SessionInstructionInput): Promise<string> {
        if (this.closed) throw queueError('QUEUE_CLOSED', 'Session execution runtime is closed');
        await this.ports.assertWritable(sessionId);
        let item = prepareInstruction(snapshot, sessionId, await this.ports.branch(sessionId));
        const queue = await this.get(sessionId);
        if (queue.cancelledIds?.includes(item.id)) throw Object.assign(queueError('SUBMISSION_CANCELLED', 'Submission was cancelled before execution'), {executionOutcome: 'not-started'});
        const digest = await instructionDigest(item), receipt = queue.accepted?.find(entry => entry.id === item.id);
        if (receipt) {
            if (receipt.digest !== digest) throw queueError('QUEUE_CONFLICT', 'Instruction identity already belongs to another request');
            return item.id;
        }
        if (await this.ports.previouslyAccepted?.(sessionId, item, digest)) return item.id;
        if (snapshot.expectedBranch !== undefined && snapshot.expectedBranch !== item.branch)
            throw queueError('QUEUE_BRANCH_CHANGED', 'Branch changed before instruction admission');
        if (await this.ports.intercept?.(sessionId, item)) {
            queue.accepted=[...(queue.accepted??[]),{id:item.id,digest}].slice(-256);
            await this.save(queue,'host-consumed',item.id);
            return item.id;
        }
        if (queue.items.length >= 100) throw queueError('QUEUE_LIMIT', 'Instruction queue is full (100 instructions)');
        const immediate = !queue.paused && !queue.items.length && await this.ports.ready(sessionId);
        item = await this.ports.prepare?.(sessionId, item, immediate) ?? item;
        await this.ports.mark?.(sessionId);
        item = await this.ports.capture?.(sessionId, item, snapshot) ?? item;
        assertPreparedInstruction(item);
        item = { ...item, submissionDigest: digest }; assertInstructionSize(item);
        queue.items.push(item);
        queue.accepted = [...(queue.accepted ?? []), { id: item.id, digest }].slice(-256);
        if (new TextEncoder().encode(JSON.stringify(queue)).byteLength > 4 * 1024 * 1024) throw queueError('QUEUE_LIMIT', 'Instruction queue exceeds 4 MiB');
        await this.save(queue, 'enqueue', item.id);
        this.tracked.add(sessionId);
        // The same durable ingress serves idle and busy Sessions. Paid work starts only after the write.
        await this.dispatch(sessionId);
        return item.id;
    }

    edit(sessionId: string, edit: InstructionQueueEdit): Promise<SessionInstructionQueue> {
        edit = structuredClone(edit);
        return this.serialize(sessionId, async () => {
            await this.ports.assertWritable(sessionId);
            const previous = await this.get(sessionId);
            if (edit.action === 'check' || edit.action === 'stop') return this.control(previous, edit);
            const next = editInstructionQueue(previous, edit);
            await this.reviseEdit(sessionId, previous, next);
            return this.save(next, edit.action);
        }, `edit.${edit.action}`).then(queue => { this.wake(sessionId); return instructionQueueProjection(queue); });
    }

    private async control(queue: StoredInstructionQueue, edit: InstructionQueueEdit & {action: 'check' | 'stop'; id: string}): Promise<StoredInstructionQueue> {
        if (queue.revision !== edit.expectedRevision) throw queueError('QUEUE_CONFLICT', 'Queue changed; refresh before continuing');
        const item = queue.items[0];
        if (!item || item.id !== edit.id || !['dispatching', 'uncertain'].includes(item.state) || !this.ports.inspect)
            throw queueError('QUEUE_EXECUTION_UNSETTLED', 'The original execution is unavailable for this action');
        item.observation = await this.ports.inspect(queue.sessionId, item, edit.action === 'stop');
        const outcome = await this.ports.recover(queue.sessionId, item);
        if (outcome === 'completed' || outcome === 'failed') {
            this.active.delete(queue.sessionId);
            queue.items.shift();
            queue.paused = outcome === 'failed' && queue.items.length > 0;
            queue.reason = queue.paused ? 'recovery' : undefined;
        }
        return this.save(queue, edit.action, item.id);
    }

    private async reviseEdit(sessionId: string, previous: SessionInstructionQueue, next: SessionInstructionQueue): Promise<void> {
        for (let index = 0; index < next.items.length; index++) {
            const item = next.items[index], old = previous.items.find(entry => entry.id === item.id);
            const sourceChanged = item.source && JSON.stringify(item.source) !== JSON.stringify(old?.source);
            if (!sourceChanged && item.text === old?.text) continue;
            if (sourceChanged) {
                if (!this.ports.revise) throw queueError('QUEUE_INPUT_EDIT_UNAVAILABLE', 'Input revision requires the owning execution host');
                next.items[index] = await this.ports.revise(sessionId, item);
            }
            next.items[index] = await this.ports.capture?.(sessionId, next.items[index], next.items[index]) ?? next.items[index];
            assertPreparedInstruction(next.items[index]); assertInstructionSize(next.items[index]);
        }
        if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 4 * 1024 * 1024)
            throw queueError('QUEUE_LIMIT', 'Instruction queue exceeds 4 MiB');
    }

    pause(sessionId: string): Promise<void> {
        return this.serialize(sessionId, async () => {
            await this.ports.assertWritable(sessionId);
            const queue = await this.get(sessionId);
            if (!queue.items.length || queue.paused) return;
            queue.paused = true;
            await this.save(queue, 'pause');
        }, 'pause');
    }

    async restore(sessionId: string): Promise<SessionInstructionQueue> {
        const queue = await this.get(sessionId);
        if (queue.revision > 0) this.report(queue);
        if (queue.items.length) { this.tracked.add(sessionId); this.wake(sessionId); }
        return instructionQueueProjection(queue);
    }

    wake(sessionId: string): void {
        if (this.closed || !this.tracked.has(sessionId) || this.active.has(sessionId)) return;
        void this.serialize(sessionId, () => this.dispatch(sessionId), 'dispatch').catch(() => {});
    }

    settled(sessionId: string, status: SessionStatus, instructionId?: string): void {
        if (this.closed || !this.tracked.has(sessionId)) return;
        void this.serialize(sessionId, async () => {
            await this.ports.assertWritable(sessionId);
            const queue = await this.get(sessionId), id = instructionId;
            if (id && this.active.get(sessionId) === id) this.active.delete(sessionId);
            if (id) await this.completeInstruction(queue, id, status);
            if (status !== 'completed' && queue.items.length) { queue.paused = true; queue.reason = status === 'aborted' ? 'aborted' : 'failed'; }
            if (!queue.items.length) { queue.paused = false; queue.reason = undefined; }
            if (!id && status === 'completed') return;
            await this.save(queue, 'settle', id);
        }, 'settle', instructionId).then(() => this.wake(sessionId)).catch(() => {});
    }

    dispose(): void { this.closed = true; this.tracked.clear(); }
    async whenIdle(): Promise<void> {
        while (this.tails.size || this.inspections.size) await Promise.allSettled([...this.tails.values(), ...this.inspections.values()]);
    }

    private async dispatch(sessionId: string): Promise<void> {
        const started = Date.now();
        if (this.closed || this.active.has(sessionId)) return;
        await this.ports.assertWritable(sessionId);
        let queue = await this.get(sessionId);
        this.report(queue);
        if (!queue.items.length) { this.tracked.delete(sessionId); return; }
        const item = queue.items[0];
        if (item.state === 'uncertain' && queue.reason === 'recovery') return this.reconcile(queue,item);
        if (queue.paused) return;
        if (item.state === 'dispatching') return this.reconcile(queue, item);
        if (item.state !== 'pending' || !await this.ports.ready(sessionId)) return;
        if (await this.ports.branch(sessionId) !== item.branch) {
            queue.paused = true; queue.reason = 'branch-changed';
            await this.save(queue, 'branch-check', item.id); return;
        }
        item.state = 'dispatching';
        item.invocation ??= {invocationId: ulid()};
        queue = await this.save(queue, 'claim', item.id);
        this.active.set(sessionId, item.id);
        try { await this.ports.submit(sessionId, item); }
        catch (error) { await this.reject(queue, item, error, started); }
    }

    private async completeInstruction(queue: SessionInstructionQueue, id: string, status: SessionStatus): Promise<void> {
        const item = queue.items.find(entry => entry.id === id);
        if (!item) return;
        const confirmed = status === 'completed' || ['completed', 'failed'].includes(await this.ports.recover(queue.sessionId, item));
        if (confirmed) queue.items = queue.items.filter(entry => entry.id !== id);
        else {
            item.state = 'uncertain';
            item.error = 'Execution ended without a confirmed history record; inspect the previous request before removing this instruction';
        }
    }

    private async reconcile(queue: SessionInstructionQueue, item: SessionInstruction): Promise<void> {
        const outcome = await this.ports.recover(queue.sessionId, item);
        if (outcome === 'running') return;
        if (outcome === 'uncertain') {
            if(item.state==='uncertain'&&queue.reason==='recovery')return;
            item.state = 'uncertain'; item.error = 'Interrupted dispatch has no confirmed completion; inspect history before removing this instruction';
        } else queue.items = queue.items.filter(entry => entry.id !== item.id);
        queue.paused = outcome !== 'completed' && queue.items.length > 0;
        queue.reason = queue.paused ? 'recovery' : undefined;
        await this.save(queue, 'recover', item.id);
        if (!queue.paused) this.wake(queue.sessionId);
    }

    private async reject(queue: SessionInstructionQueue, item: SessionInstruction, error: unknown, started: number): Promise<void> {
        this.active.delete(queue.sessionId);
        const current = queue.items.find(entry => entry.id === item.id)!;
        if ((error as {code?: string})?.code === 'SESSION_BUSY') {
            current.state = 'pending';
            await this.save(queue, 'defer', item.id); return;
        }
        current.state = 'failed'; current.error = error instanceof Error ? error.message : 'Instruction admission failed';
        queue.paused = true;
        await this.save(queue, 'admission', item.id);
        this.log('admission', queue.sessionId, item.id, error, Date.now() - started);
    }

    private async save(queue: StoredInstructionQueue, stage: string, operationId?: string): Promise<StoredInstructionQueue> {
        const started = Date.now();
        const saved = await this.ports.store.write(queue);
        this.report(saved);
        if (!saved.items.length) {
            try { await this.ports.unmark?.(saved.sessionId); }
            catch (error) { this.log('recovery-index', saved.sessionId, operationId ?? ulid(), error, Date.now() - started); }
        }
        this.ports.host.logger.info('Session instruction queue', { operation: 'session.instructions', stage,
            outcome: 'success', sessionId: queue.sessionId, operationId: operationId ?? ulid(), revision: saved.revision,
            count: saved.items.length, durationMs: Date.now() - started });
        return saved;
    }

    private log(stage: string, sessionId: string, operationId: string, error: unknown, durationMs: number): void {
        this.ports.host.logger.warn('Session instruction queue', { operation: 'session.instructions', stage, outcome: 'failure',
            sessionId, operationId, code: (error as { code?: string })?.code ?? 'QUEUE_EXECUTION', durationMs });
    }

    private report(queue: SessionInstructionQueue): void {
        if ((this.observed.get(queue.sessionId) ?? -1) >= queue.revision) return;
        this.observed.set(queue.sessionId, queue.revision);
        this.ports.changed(instructionQueueProjection(queue));
    }

    private serialize<T>(sessionId: string, work: () => Promise<T>, stage: string, operationId = ulid()): Promise<T> {
        const next = (this.tails.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const started = Date.now();
            try { return await work(); }
            catch (error) { this.log(stage, sessionId, operationId, error, Date.now() - started); throw error; }
        });
        this.tails.set(sessionId, next);
        void next.finally(() => {
            if (this.tails.get(sessionId) !== next) return;
            this.tails.delete(sessionId); this.ports.idle?.(sessionId);
        }).catch(() => {});
        return next;
    }
}
