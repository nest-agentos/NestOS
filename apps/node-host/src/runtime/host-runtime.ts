import path from 'node:path';
import type {IFsOps} from '@nestos/vfsdriver-local';
import {resolveHostPaths} from './paths';
import { openLocalFSBackend } from '@nestos/vfsdriver-local';
import { NodeSqliteSidecarDb } from '../storage/sqlite-sidecar';
import { AuditLog } from '../logging/audit-log';
import { PrivateAuthStore } from '../authorization/private-store';
import { ChatGPTAuthorization } from '../authorization/chatgpt-authorization';
import { acquireHostLock } from '../storage/host-lock';

import {traceHostCleanup, namedCleanup, type Cleanup} from './host-cleanup';
export {namedCleanup} from './host-cleanup';
export type HostCleanup = Cleanup[];
export async function closeHostResources(callbacks: HostCleanup): Promise<void> {
    const errors: unknown[] = [];
    for (const [index, close] of callbacks.splice(0).reverse().entries()) {
        try { await traceHostCleanup(close.cleanupStage ?? `resource-${index + 1}`, close); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Node host cleanup failed');
}
export async function openHostRuntime(options: { root: string; sidecar: string; authDir: string; auditFile: string; createFs?: () => IFsOps }) {
    options = {...options, ...await resolveHostPaths(options)};
    const cleanup: HostCleanup = [];
    try {
        cleanup.push(namedCleanup('storage.root-lock.release', await acquireHostLock(path.join(options.root, '_meta'))));
        cleanup.push(namedCleanup('storage.auth-lock.release', await acquireHostLock(options.authDir)));
        const store = new PrivateAuthStore(options.authDir); await store.initialize();
        const backend = await openLocalFSBackend({ rootDir: options.root, sidecarDir: options.sidecar,
            durability: 'full', createFs: options.createFs, createDb: file => NodeSqliteSidecarDb.open(file) });
        cleanup.push(namedCleanup('storage.backend.close', () => backend.close()));
        const audit = new AuditLog(options.auditFile); await audit.initialize(); cleanup.push(namedCleanup('audit.close', () => audit.close()));
        const authorization = new ChatGPTAuthorization(store, undefined, audit); cleanup.push(namedCleanup('authorization.close', () => authorization.close()));
        return { root: options.root, backend, audit, authorization, close: () => closeHostResources(cleanup) };
    } catch (error) {
        try { await closeHostResources(cleanup); } catch { /* Preserve the startup error. */ }
        throw error;
    }
}
