import {randomUUID} from '@nestos/common/startup';
import type {HostedApplicationClient, NativeSessionRecoveryPort, ProjectConversationPort, ProjectConversationSnapshot} from '@nestos/app-contracts/services';
import {FSError} from '@nestos/vfs-core';
/** Bind session commands to the authenticated business API while keeping view observations borrowed. */
export function withSessionRecovery(client: HostedApplicationClient, recovery: NativeSessionRecoveryPort, requests = new Map<string, string>()): HostedApplicationClient {
    const remote = client.services.projects.remoteMounts; if (!remote) return client;
    const independent = new Proxy(remote, {get(target, key, receiver) {
        if (key === 'projectConversation') return async (...args: Parameters<typeof remote.projectConversation>) =>
            bindRecovery(await target.projectConversation(...args), args[0], args[1], recovery, requests);
        return boundProperty(target, key, receiver);
    }});
    const projects = new Proxy(client.services.projects, {get: (target, key, receiver) => key === 'remoteMounts' ? independent : boundProperty(target, key, receiver)});
    const services = new Proxy(client.services, {get: (target, key, receiver) => key === 'projects' ? projects : boundProperty(target, key, receiver)});
    return new Proxy(client, {get: (target, key, receiver) => key === 'services' ? services : boundProperty(target, key, receiver)});
}
export function bindRecovery(source: ProjectConversationPort, projectId: string, profileId: string, recovery: NativeSessionRecoveryPort, pending = new Map<string, string>()): ProjectConversationPort {
    let cached: ProjectConversationSnapshot | undefined;
    const remember = (next: ProjectConversationSnapshot) => {
        cached = cached?.instructionQueue && next.instructionQueue && next.instructionQueue.revision < cached.instructionQueue.revision
            ? cached : next;
        return cached;
    };
    const snapshot = () => {try {return remember(source.snapshot());} catch {if (cached) return cached; throw new FSError('EIO', 'Session display is unavailable');}};
    return new Proxy(source, {get(target, key, receiver) {
        if (key === 'snapshot') return snapshot;
        if (key === 'read') return async () => remember(await target.read());
        if (key === 'editInstructionQueue') return async (edit: Parameters<NonNullable<ProjectConversationPort['editInstructionQueue']>>[0]) => {
            if (edit.action !== 'recover') return remember(await target.editInstructionQueue!(edit));
            const before = cached ?? snapshot(), sessionId = before.sessionId;
            if (!sessionId) throw new FSError('EINVAL', 'Recovery requires an existing session');
            const fingerprint = JSON.stringify([projectId, profileId, sessionId, edit.id, edit.expectedRevision]), operationId = pending.get(fingerprint) ?? randomUUID();
            if (!pending.has(fingerprint) && pending.size >= 128) throw new FSError('EBUSY', 'Resolve pending session recovery requests first');
            pending.set(fingerprint, operationId);
            try {const result = await recovery.recover({projectId, profileId, sessionId, operationId, instructionId: edit.id, expectedRevision: edit.expectedRevision});
                pending.delete(fingerprint); return remember({...before, ...result.state});}
            catch (error) {if ((error as {outcome?: string})?.outcome === 'not-committed') pending.delete(fingerprint); throw error;}
        };
        return boundProperty(target, key, receiver);
    }});
}

function boundProperty(target: object, key: PropertyKey, receiver: unknown): unknown {
    const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? value.bind(target) : value;
}
