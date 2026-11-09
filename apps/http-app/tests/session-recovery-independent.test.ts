import {afterAll, beforeAll, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCertificates, createHttpServer, loadCertificates} from '@nestos/node-host/http';
import type {AuditEvent} from '@nestos/node-host/logging';
import type {ApplicationRuntime} from '@nestos/app-core';
import type {NativeSessionRecoveryPort} from '@nestos/app-contracts/services';
import {createSessionRecoveryClient} from '@nestos/app-transport/http';
import {RPC_VERSION} from '@nestos/app-transport/rpc';
import {FSError} from '@nestos/vfs-core';
import {sessionRecoveryCommand} from '../../cli/src/application-recovery';
import {RuntimeApi} from '../../node-host/src/http/runtime-api';
import {authenticatedFetch, listen, close} from './tls-fixture';
let directory: string, origin: string, auth: Awaited<ReturnType<typeof authenticatedFetch>>, server: ReturnType<typeof createHttpServer>, api: RuntimeApi;
const target = {projectId: 'p', profileId: 'codex', sessionId: 'native'};
const state = {sessionId: 'native', canSend: false, canInterrupt: false, canRespond: false, active: false, pending: false, disconnected: false, gap: false, observation: {execution: 'unknown' as const, rawStatus: null, nativeError: false, owned: false, observedAt: 1, source: 'inspect' as const, connection: 'online' as const, stale: false, receiptUnknown: false, canInterrupt: false, canRespond: false}};
const service: NativeSessionRecoveryPort = {inspect: vi.fn(async () => state), recover: vi.fn(async request => ({operationId: request.operationId, outcome: 'recovered' as const, duplicate: false, state}))};
const createView = vi.fn(async () => {throw new Error('Business recovery must not open a view');});
const events: AuditEvent[] = [];
beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'session-recovery-api-')); const certs = path.join(directory, 'certs');
    await createCertificates(certs, ['127.0.0.1']); auth = await authenticatedFetch(certs);
    const audit = {write: (event: AuditEvent) => {events.push(event);}, close: async () => {}};
    api = new RuntimeApi(Promise.resolve({sessionRecovery: service, createView} as unknown as ApplicationRuntime), audit, false);
    server = createHttpServer({application: api, certificates: await loadCertificates(certs), staticDir: directory, audit});
    origin = `https://127.0.0.1:${await listen(server)}`;
}, 20000);
afterAll(async () => {auth?.close(); await api?.close(); if (server) await close(server); await rm(directory, {recursive: true, force: true});});
it('recovers a session over authenticated HTTP after the browser view is missing, without bootstrap or SSE', async () => {
    const expired = await auth.fetcher(origin + `/api/application/events?clientId=missing&after=0&version=${RPC_VERSION}&resume=1`);
    expect(expired.status).toBe(400); expect(expired.headers.get('X-NestOS-View-Expired')).toBe('1'); await expired.body?.cancel();
    const client = createSessionRecoveryClient(auth.fetcher, origin + '/api/sessions/recovery');
    expect(await client.inspect(target)).toMatchObject({sessionId: 'native'});
    expect(await client.recover({...target, operationId: 'recovery', instructionId: 'old', expectedRevision: 7})).toMatchObject({outcome: 'recovered'});
    expect(createView).not.toHaveBeenCalled();
    expect(events.filter(event => event.event === 'application.complete')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({event: 'session.recovery', operationId: 'recovery', result: 'success'}));
});
it('rejects view and user selectors in the business request and enforces browser origin checks', async () => {
    const before = vi.mocked(service.recover).mock.calls.length;
    for (const extra of [{clientId: 'missing'}, {userId: 'other'}]) {
        const response = await auth.fetcher(origin + '/api/sessions/recovery', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: 1, action: 'recover', request: {...target, operationId: 'invalid', instructionId: 'old', expectedRevision: 7, ...extra}})});
        expect(response.status).toBe(400); expect(response.headers.get('X-NestOS-View-Expired')).toBeNull();
    }
    const response = await auth.fetcher(origin + '/api/sessions/recovery', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://evil.invalid'}, body: '{}'});
    expect(response.status).toBe(403); expect(service.recover).toHaveBeenCalledTimes(before);
});
it('preserves business rejection codes without reporting a view failure or replaying the command', async () => {
    vi.mocked(service.recover).mockRejectedValueOnce(Object.assign(new FSError('EBUSY', 'Native execution is still running'), {remoteCode: 'HARNESS_RECOVERY_NOT_DETACHED'}));
    const client = createSessionRecoveryClient(auth.fetcher, origin + '/api/sessions/recovery');
    await expect(client.recover({...target, operationId: 'blocked', instructionId: 'old', expectedRevision: 7})).rejects.toMatchObject({code: 'EBUSY', remoteCode: 'HARNESS_RECOVERY_NOT_DETACHED', outcome: 'not-committed'});
    expect(createView).not.toHaveBeenCalled();
});

it('lets the CLI inspect and recover directly without creating an application view', async () => {
    const options = {connect: origin, clientCert: path.join(directory, 'certs/client.crt'), clientKey: path.join(directory, 'certs/client.key'), caCert: path.join(directory, 'certs/ca.crt')};
    expect(await sessionRecoveryCommand(['recovery', 'p', 'codex', 'native'], options)).toMatchObject({sessionId: 'native'});
    expect(await sessionRecoveryCommand(['recover', 'p', 'codex', 'native', 'old', '7', 'cli-recovery'], options)).toMatchObject({operationId: 'cli-recovery', outcome: 'recovered'});
    expect(createView).not.toHaveBeenCalled();
});
