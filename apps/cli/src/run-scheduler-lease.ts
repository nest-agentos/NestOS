import { leaseSkewConfig } from './lease-config';
// The local scheduler lock serializes commands on one host. The persisted scheduler
// lease and deletion tombstone serialize deletion against participating hosts' takeover.
// Inspection opens storage without acquiring a Session lease or starting workers.

import { SeqFileKernelStore } from '@itookit/durable-kernel';
import { markSchedulerRunDeleted, parseSchedulerLeaseRecord, schedulerOwnerKey, type SchedulerLeaseRecord } from '@itookit/llm-flow';
import { CliStorageResolver, cliStorage, openProfileInspectionFs } from './runtime';

export interface RunSchedulerLeaseRef {
    /** CLI data root (`--state-dir` or profile root), mounted at VFS `/`. */
    vfsRoot: string;
    sessionId: string;
    rootTaskId: string;
}

/** Read persisted scheduling ownership without starting a Session. */
export async function readRunSchedulerLease(ref: RunSchedulerLeaseRef): Promise<SchedulerLeaseRecord | undefined> {
    const { fs, dispose } = await openProfileInspectionFs(ref.vfsRoot);
    try {
        const resolver = new CliStorageResolver(fs);
        const binding = await resolver.resolve(cliStorage(ref.sessionId));
        const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference));
        const entry = await store.getShared(binding, schedulerOwnerKey(ref.rootTaskId));
        const record = parseSchedulerLeaseRecord(entry?.value);
        if (entry && (!record || (entry.value as { version?: unknown } | null)?.version !== 1
            || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0)) {
            throw new Error(`Run ${ref.rootTaskId} has an invalid scheduler lease; deletion refused`);
        }
        return record;
    } finally {
        await dispose();
    }
}

/** Read-only preflight; deletion must use markRunDeleted for atomic exclusion. */
export async function assertRunNotScheduled(ref: RunSchedulerLeaseRef, now = Date.now()): Promise<void> {
    const skewMs = leaseSkewConfig(process.env).schedulerSkewMs ?? 0;
    const record = await readRunSchedulerLease(ref);
    if (!record || record.expiresAt === 0 || record.expiresAt + skewMs <= now) return;
    throw new Error(`Run ${ref.rootTaskId} is scheduled by ${record.ownerId} until`
        + ` ${new Date(record.expiresAt).toISOString()}; stop that host or wait for the lease to expire`);
}

/** Persist exclusion before removing the CLI directory; retain it if physical deletion fails. */
export async function markRunDeleted(ref: RunSchedulerLeaseRef): Promise<void> {
    const skewMs = leaseSkewConfig(process.env).schedulerSkewMs ?? 0;
    const { fs, dispose } = await openProfileInspectionFs(ref.vfsRoot);
    try {
        const resolver = new CliStorageResolver(fs);
        const binding = await resolver.resolve(cliStorage(ref.sessionId));
        const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference));
        await markSchedulerRunDeleted({
            getShared: key => store.getShared(binding, key),
            setShared: (key, value, options) => store.setShared(binding, key, value, options),
        }, ref.rootTaskId, { skewMs });
    } finally { await dispose(); }
}
