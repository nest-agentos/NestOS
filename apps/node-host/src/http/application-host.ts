import { createNodeRuntime } from '../runtime/application';
import type { IStorageBackend } from '@nestos/vfs-core';
import {RuntimeApi} from './runtime-api';
import type { AuditPort } from '../logging/audit-log';
import type { ProviderAuthorizationHost } from '@nestos/kernel-adapters/llm/core';

/** Storage and execution belong to the daemon; browser views borrow capabilities. */
export async function createApplicationApi(backend: IStorageBackend, root?: string, audit?: AuditPort, providerAuthorization?: ProviderAuthorizationHost): Promise<RuntimeApi> {
    const runtime = await createNodeRuntime(backend, root, {startupMode: 'server', ownerKind: 'httpd', providerAuthorization}, undefined, true, audit);
    return new RuntimeApi(Promise.resolve(runtime), audit);
}
