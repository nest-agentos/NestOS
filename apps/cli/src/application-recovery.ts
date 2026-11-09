import {FSError} from '@nestos/vfs-core';
import {createSessionRecoveryClient} from '@nestos/app-transport/http';
import {openNodeHttpClient} from '@nestos/node-host/client';
import type {NativeSessionRecoveryPort} from '@nestos/app-contracts/services';
import type {CommandOptions} from './commands';
import {openLocalApplication} from './application-host';
/** Recovery is an authenticated business command; no application view is opened. */
export async function sessionRecoveryCommand(args: string[], options: CommandOptions): Promise<unknown> {
    if (!options.connect) {
        const host = await openLocalApplication(options);
        try {return await executeRecovery(host.runtime.sessionRecovery, args);} finally {await host.close();}
    }
    const endpoint = new URL(options.connect);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new FSError('EINVAL', 'Recovery requires an HTTPS endpoint without embedded credentials');
    const transport = await openNodeHttpClient(options);
    try {
        const response = await transport.fetcher(new URL('/api/identity', endpoint));
        if (!response.ok) throw new FSError('EACCES', 'Cannot authenticate recovery user');
        const identity = await response.json() as {userId?: unknown};
        if (typeof identity.userId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(identity.userId)) throw new FSError('EACCES', 'Invalid recovery user');
        const fetcher: typeof fetch = (url, init) => transport.fetcher(url, {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), 'X-NestOS-User': identity.userId as string}});
        return await executeRecovery(createSessionRecoveryClient(fetcher, new URL('/api/sessions/recovery', endpoint).href), args);
    } finally {transport.close();}
}
async function executeRecovery(service: NativeSessionRecoveryPort, args: string[]): Promise<unknown> {
    const [action, projectId, profileId, sessionId, instructionId, revision, operationId] = args;
    const target = {projectId: projectId!, profileId: profileId!, sessionId: sessionId!};
    if (action === 'recovery' && args.length === 4) return service.inspect(target);
    if (action !== 'recover' || args.length !== 7 || !/^(0|[1-9][0-9]*)$/.test(revision ?? ''))
        throw new FSError('EINVAL', 'conversation recover requires project profile session instruction revision operation-id; use recovery to inspect first');
    return service.recover({...target, instructionId: instructionId!, expectedRevision: Number(revision), operationId: operationId!});
}
