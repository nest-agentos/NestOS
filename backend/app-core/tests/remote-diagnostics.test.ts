import { afterEach, expect, it, vi } from 'vitest';
import { getLogger, LogLevel } from '@nestos/common';
import { MemoryBackend } from '@nestos/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';
import { reportRemoteFailure } from '../src/projects/remote-diagnostics';
import { RemoteMountStore } from '../src/projects/remote-mount-store';

const provider = () => ({setCredential: vi.fn(), dispose: vi.fn(), open: vi.fn()});
afterEach(() => {getLogger().clear(); getLogger().removeModuleLevel('cells'); vi.restoreAllMocks();});

it('records the missing binding and its project without remapping it to another Cells node', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'});
    const root = await runtime.vfs.openFileSystem('/'), store = new RemoteMountStore(root), source = provider();
    await store.load();
    await store.save({version: 1, revision: 1, connections:[{id:'office',name:'Office',endpoint:'https://office.test',credentialRef:'private-reference'}], projects: {notes: [{mountId: 'grant', at: '/', root: '/', alias: 'docs',
        access: 'ro', connectionId: 'old-office', endpoint: 'https://office.test', credentialRef: 'private-reference'}]}});
    const remote = new ProjectRemoteMountService(root, source, async () => {}, async () => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        await remote.init();
        const diagnostic=remote.connectionDiagnostic('office');expect(diagnostic.reason).toBe('ready');
        diagnostic.configured[0].name='Changed';expect(remote.connectionDiagnostic('office').connectionName).toBe('Office');
        await expect(remote.resolveConnection('old-office')).rejects.toMatchObject({code: 'ENOENT', projectIds: ['notes'],
            diagnostic: {connectionId: 'old-office', reason: 'cells-not-found', configured: [{id: 'office', name: 'Office', reason:'ready'}]}});
        expect(source.open).not.toHaveBeenCalled();
        const logs = getLogger().query({modules: ['cells']}); expect(logs).toHaveLength(2);
        expect(logs.some(log => (log.data as {projectId?:string}).projectId === 'notes')).toBe(true);
        expect(JSON.stringify(logs)).not.toMatch(/private-|https:/);
        expect(consoleError).toHaveBeenCalledTimes(2);
        expect(consoleError.mock.calls[0][0]).toMatch(/^\d{4}-\d\d-\d\dT.* \[itookit\/cells\]/);
    } finally {await remote.dispose(); await runtime.dispose();}
});

it('does not log provider response bodies, URLs, headers or session content', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportRemoteFailure(new Error('private-response-body https://host/?api_key=private-key'),
        {stage: 'session-list', projectId: 'notes', profileId: 'codex'});
    expect(JSON.stringify(getLogger().query({modules: ['cells']}))).not.toContain('private-');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private-');
});

it('preserves HTTP and network cause codes without their sensitive messages', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const network = Object.assign(new Error('private-api-key'), {code: 'ECONNREFUSED'});
    const sdk = Object.assign(new Error('private-response-body', {cause: network}), {code: 'CELLS_HTTP_FAILURE'});
    reportRemoteFailure(sdk, {stage: 'cells-connection-recovery', connectionId: 'office'});
    const log = getLogger().query({modules: ['cells']})[0];
    expect(log.data).toMatchObject({source: 'itookit', code: 'CELLS_HTTP_FAILURE', causeCodes: ['ECONNREFUSED']});
    expect(JSON.stringify(log)).not.toContain('private-');
});

it('honors the module SILENT setting in both the log viewer and console', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getLogger().setLevel('cells', LogLevel.SILENT);
    reportRemoteFailure(new Error('Offline'), {stage: 'session-list', projectId: 'notes'});
    expect(getLogger().query({modules: ['cells']})).toEqual([]); expect(consoleError).not.toHaveBeenCalled();
});
