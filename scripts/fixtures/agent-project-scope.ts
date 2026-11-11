import '../../apps/web-app/src/styles/index.css';
import {RpcPeer, installViewProjections} from '@nestos/app-transport/application';
import {createApplicationRuntime} from '@nestos/app-core';
import {createApplicationClient, bindLocalApplicationServices, openApplicationView} from '@nestos/app-core/host';
import {MemoryBackend} from '@nestos/vfs-core';
import {initApp} from '@nestos/app-shell';
import {folderBrowserPath} from '@nestos/app-contracts';
import {WORKSPACES} from '../../apps/web-app/src/config/modules';
import {createBrowserUI} from '../../apps/web-app/src/ui';
import {createNestosFlowLibrary} from '@nestos/app-core';

const report = document.createElement('pre'); report.id = 'agent-scope-result'; report.hidden = true; document.body.append(report);
const calls: string[] = [];
let measuring = false;
const measurements: unknown[] = [];
async function rpcView(runtime: Parameters<typeof openApplicationView>[0]) {
    const view = await openApplicationView(runtime, {preload: true});
    let server: RpcPeer;
    const client = new RpcPeer('client', async call => {
        if (measuring) calls.push(call.method);
        return server.handle(call);
    }, console.error, installViewProjections);
    server = new RpcPeer('server', call => client.handle(call), console.error, undefined, async () => {
        for (const model of server.localValues<typeof view.services.agentService>('IAgentManagementService'))
            for (const agent of model.listAgents()) server.remember(model, 'getAgentResourceId', [agent.id]);
    });
    const {value, updates} = await server.bootstrap(view);
    client.applyUpdates(updates);
    return {client: client.decode(value!) as typeof view, close: async () => {client.close(); server.close(); await view.close();}};
}
async function until(check: () => boolean): Promise<void> {
    const deadline = performance.now() + 15000;
    while (!check()) {if (performance.now() > deadline) throw new Error('UI_NOT_READY'); await new Promise(resolve => setTimeout(resolve, 20));}
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function main() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', digitalTwinAutoStart: false});
    console.log('scope.fixture.runtime-ready');
    const client = createApplicationClient(bindLocalApplicationServices(runtime));
    console.log('scope.fixture.projects-create');
    const first = await runtime.projects.create('Scope Alpha'), second = await runtime.projects.create('Scope Beta');
    console.log('scope.fixture.agents-create');
    for (let index = 0; index < 10; index++) {
        const id = `scope-${index}`;
        await runtime.agentService.saveAgent({id, name: `Scope Agent ${index}`, type: 'agent', config: {}});
        await client.backend.saveAgentProjectScope(id, index < 5 ? {kind: 'all'} : {kind: 'selected', projectIds: [first.project.id]});
    }
    console.log('scope.fixture.ui-create');
    const transport = await rpcView(runtime);
    const app = await initApp({...transport.client, workspaces: WORKSPACES, defaultSlug: 'chat', startPage: false, ui: createBrowserUI(createNestosFlowLibrary())});

    const measure = async (scenario: string, action: () => void | Promise<void>, ready: () => boolean) => {
        calls.length = 0; const started = performance.now(); measuring = true; await action(); await until(ready); measuring = false;
        const elapsedMs = performance.now() - started;
        measurements.push({scenario, elapsedMs, logicalApiCalls: calls.length, methods: [...calls], httpRequests: 0});
        if (elapsedMs >= 5000 || calls.length >= 30) throw new Error(`PERFORMANCE_BUDGET_EXCEEDED:${scenario}`);
    };
    try {
        await app.navigate('chat', folderBrowserPath(first.path));
        await until(() => !!document.querySelector('[data-sidebar-view="agents"]'));
        await measure('cold-agent-list', () => document.querySelector<HTMLButtonElement>('[data-sidebar-view="agents"]')!.click(),
            () => !!document.querySelector('[data-item-id="scope-9"]'));
        const search = document.querySelector<HTMLInputElement>('.workbench-agents input[type=search], .workbench-agents input')!;
        search.value = 'Scope Agent'; search.dispatchEvent(new Event('input', {bubbles: true}));
        await until(() => document.querySelectorAll('.workbench-agents [data-item-id]').length === 10);
        await measure('project-switch', () => app.navigate('chat', folderBrowserPath(second.path)),
            () => !document.querySelector('[data-item-id="scope-9"]') && document.querySelectorAll('.workbench-agents [data-item-id]').length === 5);
        if (search.value !== 'Scope Agent') throw new Error('SEARCH_NOT_PRESERVED');
        await app.navigate('chat', folderBrowserPath(first.path));
        await until(() => !!document.querySelector('[data-item-id="scope-9"]'));
        await measure('warm-agent-draft', () => document.querySelector<HTMLElement>('[data-item-id="scope-9"]')!.click(),
            () => {const input = document.querySelector<HTMLTextAreaElement>('textarea:not([disabled])'); const box = input?.getBoundingClientRect(); return !!box && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;});
        await app.navigate('chat', '@agent/scope-9');
        await until(() => !!document.querySelector('.agent-scope-editor'));
        const tabs = document.querySelectorAll<HTMLButtonElement>('.agent-scope-editor > nav [role=tab]');
        if (tabs.length !== 2) throw new Error('SCOPE_TABS_INVALID'); tabs[1].click();
        const projectSearch = document.querySelector<HTMLInputElement>('.agent-project-settings input[type=search]')!;
        projectSearch.value = 'Scope Beta'; projectSearch.dispatchEvent(new Event('input', {bubbles: true}));
        const firstChoice = document.querySelector<HTMLInputElement>(`.agent-project-settings input[value="${first.project.id}"]`)!;
        if (getComputedStyle(firstChoice.parentElement!).display !== 'none') throw new Error('PROJECT_SEARCH_NOT_HIDDEN');
        const all = document.querySelector<HTMLInputElement>('.agent-project-settings input[value=all]')!;
        all.click(); if (!projectSearch.hidden) throw new Error('ALL_PROJECTS_NOT_COLLAPSED');
        document.querySelector<HTMLInputElement>('.agent-project-settings input[value=selected]')!.click();
        projectSearch.value = ''; projectSearch.dispatchEvent(new Event('input', {bubbles: true}));
        report.textContent = JSON.stringify({result: 'passed', configurationTabs: true, projectSearch: true, allProjectsCollapsed: true, dataset: {projects: 3, fixtureAgents: 10, totalAgents: runtime.agentService.listAgents().length, sessions: 0}, state: 'cold-list/warm-draft',
            backgroundLoad: 'no model calls; no builds or tests during measurement', counting: 'actual RpcPeer calls, including bindings; browser-host memory transport, HTTP API requests=0', measurements, searchPreserved: true});
        document.body.append(report);
    } finally {measuring = false; (globalThis as any).cleanupAgentScope = async () => {await app.destroy(); await transport.close(); await client.close(); await runtime.dispose();};}
}
void main().catch(error => {document.body.append(report); report.textContent = JSON.stringify({result: 'failed', code: error.message, measurements});});
