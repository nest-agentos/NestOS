import {expect, it, vi} from 'vitest';
import {RpcPeer} from '@nestos/app-transport/application';
import {SnapshotCache} from '@nestos/app-transport/http';
import {bootstrapCatalogs, bootstrapView, type BootstrapClient} from '../../node-host/src/http/view-bootstrap';

it('returns the native view before reading global catalogs and hydrates the existing capability once', async () => {
    const server = new RpcPeer('server', async () => ({})), peer = new RpcPeer('client', call => server.handle(call));
    const listAgents = vi.fn(() => [{id: 'workspace-agent'}]);
    const agentService = {listAgents, getAgents: vi.fn(), saveAgent: vi.fn()};
    const opened = {conversationWorkbench: {native: {resourceId: '/folder:x1/@harness/codex/thread'}},
        cursor: 3, observation: {observeView: async () => () => {}}};
    const openView = vi.fn(async () => opened);
    const client = {peer: server, view: {root: {services: {agentService}, backend: {openView}}}} as unknown as BootstrapClient;
    try {
        const reply = await bootstrapView(client, {initialView: {resourceId: '/folder:x1/@harness/codex/thread', documents: [], workbench: {}},
            deferCatalogs: true}, new SnapshotCache()) as Awaited<ReturnType<typeof server.bootstrap>>;
        expect(listAgents).not.toHaveBeenCalled();
        peer.applyUpdates(reply.updates);
        const root = peer.decode(reply.value!);
        expect(root.deferredCatalogs).toBe(true);
        expect(root.initialView.conversationWorkbench.native.resourceId).toContain('thread');
        expect(() => root.services.agentService.listAgents()).toThrow(expect.objectContaining({code: 'VIEW_CATALOG_PENDING'}));
        const [first, second] = await Promise.all([bootstrapCatalogs(client), bootstrapCatalogs(client)]);
        expect(first).toBe(second);
        peer.applyUpdates(first.updates);
        expect(root.services.agentService.listAgents()).toEqual([{id: 'workspace-agent'}]);
        expect(listAgents).toHaveBeenCalledOnce();
        expect(openView).toHaveBeenCalledOnce();
    } finally {await peer.close(); await server.close();}
});
