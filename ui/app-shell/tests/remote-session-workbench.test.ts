import { SessionWorkbench } from '../src/projects/SessionWorkbench';
import {WorkbenchSources} from '../src/projects/workbench-sources';
import { bindApplicationBackend } from '@nestos/app-core/host';
// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID, t } from '@nestos/common';
import { MemoryBackend, createFileSystemSource, FSError } from '@nestos/vfs-core';
import { createApplicationRuntime, remoteSessionPath, folderBrowserPath } from '@nestos/app-core';
import { HarnessConversation, type HarnessClient, type ProjectClient } from '@nestos/cells-driver';
import {createLLMFactory} from '../../llm-ui-adapter/src/chat';
import type {EditorOptions} from '@nestos/ui-common-adapter';
import type { VFSUIShell } from '@nestos/vfs-ui';
import { projectConversationEntryPath, projectConversationsPath } from '@nestos/app-contracts';
import type {CellsDraftPromotion, CellsDraftRecord} from '@nestos/cells-driver';

function nodeDrafts(peer: HarnessClient, workspaceId: string) {
    const blank = (): CellsDraftRecord => ({version: 1, id: randomUUID(), state: 'draft', data: ''});
    let draft = blank(), promotion: CellsDraftPromotion | undefined;
    const identities = new Map<string, string>();
    return vi.fn<NonNullable<ProjectClient['draft']>>(async (_project, input) => {
        if (input.action === 'resolve') return {conversationId: identities.get(input.sessionId!) ?? null};
        if (input.action === 'open') return {record: {...draft}, promotion};
        if (input.action === 'save') {draft = {...draft, data: input.data!}; return {record: {...draft}};}
        if (input.action === 'begin') {
            draft = {...draft, state: 'submitting', remoteTarget: input.target, submissionId: draft.id};
            return {record: {...draft}};
        }
        if (input.action === 'submit') {
            const options = {requestId: input.operationId!};
            const {session} = await peer.create(input.profileId!, workspaceId, options);
            const {turnId} = await peer.turn(input.profileId!, session.id, input.prompt!, options);
            const next = blank();
            identities.set(session.id, draft.id);
            promotion = {draftId: draft.id, nextDraftId: next.id, submissionId: draft.id, remoteTarget: draft.remoteTarget, nativeSessionId: session.id, turnId};
            draft = next;
            return {receipt: {requestId: input.operationId!, outcome: 'committed', result: {session, turnId}}};
        }
        return {promotion};
    });
}

const dialogMethods = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches:false,addEventListener() {},removeEventListener() {}}));
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    Object.defineProperties(Range.prototype,{getClientRects:{configurable:true,value:()=>[]},getBoundingClientRect:{configurable:true,value:()=>new DOMRect()}});
    for (const method of ['showModal', 'close']) {
        dialogMethods.set(method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method));
        Object.defineProperty(HTMLDialogElement.prototype, method, {configurable: true, value: vi.fn()});
    }
});
afterEach(() => {
    vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (Range.prototype as any).getClientRects; delete (Range.prototype as any).getBoundingClientRect;
    for (const [method, descriptor] of dialogMethods) {
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
});

it.each([
    ['opens a cold native conversation once with no local chat configuration', true],
    ['browses mounted native history pages, opens their conversations and routes a project draft remotely', false],
] as const)('%s', async (_name, coldOpen) => {
    const files = new MemoryBackend(); await files.mkdir('/project');
    const fileSource = await createFileSystemSource({backend: files, viewId: 'server-files', access: 'rw'});
    const record = {id:'server-project',name:'Notes',alias:'docs',path:'project',access:'rw' as const,revision:1,mounts:[]};
    const profile = {id:'codex',kind:'codex',projectRuntime:true,workspaces:[{id:record.id}],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true,fork:true,archive:true}};
    const native = {id:'native',title:'Native session',cwd:'/projects/server-project',status:'idle',createdAt:1791458500000,updatedAt:1791458565000,resumable:true,owned:true};
    const sessionList=[{...native,id:'earlier-native',title:'A much older session',updatedAt:1791458500000}, native];
    const peer: HarnessClient = {subscribe:vi.fn(() => () => {}),profiles:vi.fn(async () => ({epoch:'e',profiles:[profile]})),list:vi.fn(async (_profile, query) => query?.cursor
        ? {sessions:[{...native,id:'older',title:'Older native session'}],nextCursor:null}
        : {sessions:[...sessionList],nextCursor:'older/before+='}),read:vi.fn(async () => ({session:{...native},turns:[{items:[{id:'a',type:'agentMessage',text:'Remote native history'}]}]})),
        fork:vi.fn(async (_profile,id,name) => {const session={...native,id:'branched-native',title:name ?? 'Alternative',parentSessionId:id};sessionList.push(session);return {session};}),create:vi.fn(async () => {const session={...native,id:'new-native'};sessionList.push(session);return {session};}),resume:vi.fn(async () => ({session:{...native}})),turn:vi.fn(async () => ({turnId:'t'})),eventSnapshot:vi.fn(async () => ({epoch:'ev',cursor:0,gap:false,events:[],requests:[]})),respond:vi.fn(),interrupt:vi.fn(),operation:vi.fn(),close:vi.fn(async () => {})};
    vi.mocked(peer.read).mockImplementation(async (_profile,id) => ({session:{...native,id},turns:[{items:[{id:'a',type:'agentMessage',text:'Remote native history'}]}]}));
    const state = new Map<string, string>();
    const clientState: NonNullable<ProjectClient['clientState']> = async (_project, input) => {
        const value = state.get(input.key) ?? null;
        if (input.action === 'read') return {value};
        if (value !== input.expected) return {applied: false};
        if (input.value == null) state.delete(input.key); else state.set(input.key, input.value);
        return {applied: true};
    };
    const queueSession: NonNullable<ProjectClient['queueSession']> = async (_project, input) => {
        expect(input.action).toBe('read');
        return {owner: 'cells', revision: 0, paused: false, items: [], receipts: []};
    };
    const draft = nodeDrafts(peer, record.id);
    const client = {register:async () => record,read:async () => record,roots:async () => ({roots: [{alias: 'docs', access: 'rw'}]}),harness:() => peer,clientState,queueSession,draft,close:async () => {}} as unknown as ProjectClient;
    const runtime = await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web',remoteSourceProvider:{setCredential() {},resolveCredential:()=>'secret',dispose:async () => {},projects:() => client,
        conversation:(...args) => new HarnessConversation(...args),discover:async connection => ({version:1,fileProtocol:'fs-agent-http-v1',httpEndpoint:connection.endpoint.replace(/\/mcp$/,''),serverId:'node',harness:true,projects:true,projectProtocol:'fs-agent-project-v1'}),
        open:async () => ({fs: fileSource.fs, dispose: async () => {}})}});
    const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,init) => {
        if (init?.method !== 'POST') return new Response(null,{status:405});
        const message = JSON.parse(String(init.body));
        const result = message.method === 'server/discover' ? {supportedVersions:['2026-07-28'],capabilities:{tools:{}},
            _meta:{'itookit/cells':{version:1,fileProtocol:'fs-agent-http-v1',httpEndpoint:'https://files.test',serverId:'node',harness:true,projects:true,projectProtocol:'fs-agent-project-v1'}}} : {tools:[]};
        return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{resultType:'complete',ttlMs:0,cacheScope:'private',...result}}),{headers:{'content-type':'application/json'}});
    });
    const sidebar=document.createElement('div'),main=document.createElement('div');document.body.append(sidebar,main);
    const factory = vi.fn(createLLMFactory(runtime.agentService, {sessionRepository: runtime.sessionRepository,
        sessionManager: runtime.sessionManager, commandBus: runtime.commandBus}));
    const backend = bindApplicationBackend(runtime);
    const workbench=new SessionWorkbench({ backend, sidebar,container:main,repository:runtime.sessionRepository,files:runtime.sessionFiles,projects:runtime.projects,kernel:runtime.kernel.kernel,factory,onSelect() {},hostContext:undefined,fileFactory:factory});
    try {
        const remote=runtime.projects.remoteMounts!,connection=await remote.saveConnection({name:'Server',endpoint:'https://files.test',username:'u'},'secret');
        const project=await runtime.projects.createRemote('Notes',null,connection,'/docs/project','rw');
        if (coldOpen) {
            const resourceId = remoteSessionPath(project.path, 'codex', 'native');
            const opening = await backend.openWorkbench!({resourceId, documents: []});
            const sources = new WorkbenchSources(opening), prepareLocalChat = vi.spyOn(opening, 'prepareChat');
            const coldEditor = document.createElement('div'), coldSidebar = document.createElement('div');
            document.body.append(coldEditor, coldSidebar);
            const cold = new SessionWorkbench({backend, sidebar: coldSidebar, container: coldEditor,
                repository: runtime.sessionRepository, files: runtime.sessionFiles, projects: runtime.projects, kernel: runtime.kernel.kernel,
                createFactory: () => factory, onSelect() {}, initialResource: resourceId, deferNavigation: true, opening, sources});
            const nativeReads = vi.mocked(peer.read).mock.calls.length;
            try {
                await cold.start();
                await cold.openResource(resourceId);
                expect(coldEditor.textContent).toContain('Remote native history');
                expect(prepareLocalChat).not.toHaveBeenCalled();
                expect(peer.read).toHaveBeenCalledTimes(nativeReads);
                const panel = coldEditor.querySelector('.workbench-tabs__panel:not([hidden])')!;
                const input = panel.querySelector('.llm-chat__input');
                expect(input).not.toBeNull();
                await cold.setNavigationVisible(true);
                await cold.openResource(remoteSessionPath(project.path, 'codex', 'earlier-native'), {newTab: true});
                const navigation = vi.spyOn(runtime.projects, 'navigation'), open = vi.spyOn(opening, 'openConversation');
                const tab = coldEditor.querySelector<HTMLButtonElement>(`[data-tab-id="${resourceId}"] .workbench-tabs__label`)!;
                expect(tab.title).toContain('Native session');
                tab.click();
                await vi.waitFor(() => expect(cold.getActiveResourceId()).toBe(resourceId));
                expect(coldEditor.querySelector('.workbench-tabs__panel:not([hidden])')).toBe(panel);
                expect(panel.querySelector('.llm-chat__input')).toBe(input);
                expect(open).not.toHaveBeenCalled();
                expect(navigation).not.toHaveBeenCalled();
                const filesPath = folderBrowserPath(project.path) + '/@files';
                await cold.openResource(filesPath, {newTab: true, directory: true});
                const offline = vi.spyOn(remote, 'projectOffline').mockReturnValue(true);
                try {
                    await (cold as unknown as {applyRemoteAvailability(path: string): Promise<void>}).applyRemoteAvailability(filesPath);
                    expect(coldEditor.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')?.inert).toBe(true);
                    expect(coldEditor.inert).not.toBe(true);
                    coldEditor.querySelector<HTMLButtonElement>(`[data-tab-id="${resourceId}"] .workbench-tabs__label`)!.click();
                    await vi.waitFor(() => expect(cold.getActiveResourceId()).toBe(resourceId));
                    expect(coldEditor.querySelector('.workbench-tabs__panel:not([hidden])')).toBe(panel);
                } finally {offline.mockRestore();}
                let finish!: () => void;
                const pending = new Promise<void>(resolve => {finish = resolve;}), closeLate = vi.fn(async () => {});
                open.mockImplementationOnce(async () => {
                    await pending;
                    return {...opening.native!, conversation: {...opening.native!.conversation, close: closeLate}};
                });
                const loading = cold.openResource(remoteSessionPath(project.path, 'codex', 'pending-native'), {newTab: true});
                try {
                    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
                    await cold.openResource(resourceId);
                    expect(coldEditor.querySelector('.workbench-tabs__panel:not([hidden])')).toBe(panel);
                } finally {finish(); await loading;}
                await vi.waitFor(() => expect(closeLate).toHaveBeenCalledOnce());
            } finally {
                sources.close(); await cold.destroy(); await opening.dispose(); coldEditor.remove(); coldSidebar.remove();
            }
            return;
        }
        const preview = (resource: string) => projectConversationEntryPath(projectConversationsPath(project.path, {recent: true}), resource);
        await workbench.start();
        const selector = sidebar.querySelector<HTMLSelectElement>(`select[aria-label="${t('project.workspace')}"]`)!;
        const initialScope = selector.value;
        const localPath = folderBrowserPath((await runtime.projects.current())!.path), remotePath = folderBrowserPath(project.path);
        await workbench.openResource(localPath);
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        selector.value = remotePath; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(remotePath));
        await vi.waitFor(() => expect(selector.value).toBe(remotePath));
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${preview(remoteSessionPath(project.path, 'codex', 'native'))}"]`)).not.toBeNull());
        expect(sidebar.querySelector(`[data-item-id="${remoteSessionPath(project.path, 'codex')}"]`)).toBeNull();
        expect(sidebar.querySelector(`[data-item-id="${remoteSessionPath(project.path)}"]`)).toBeNull();
        expect(main.querySelector('.workbench-tabs__panel:not([hidden])')!.textContent).toContain('Native session');
        expect(main.querySelector(`.workbench-tabs__panel:not([hidden]) [data-resource-id="${remoteSessionPath(project.path)}"]`)).toBeNull();
        selector.value = '/'; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('/'));
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${remotePath}"]`)).not.toBeNull());
        const remoteProjectRow = sidebar.querySelector<HTMLElement>(`[data-item-id="${remotePath}"] .vfs-directory-item__header`)!;
        expect(remoteProjectRow).not.toBeNull(); remoteProjectRow.click();
        expect(workbench.getActiveResourceId()).toBe('/');
        remoteProjectRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(remotePath));
        await vi.waitFor(() => expect(selector.value).toBe(remotePath));
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        expect([...main.querySelectorAll<HTMLButtonElement>('.workbench-tabs__panel:not([hidden]) button')]
            .some(button => button.getAttribute('aria-label') === t('project.createSession'))).toBe(true);
        selector.value = initialScope; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(initialScope));
        const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
        const browser = (workbench as unknown as {browser: {readDirectory(path: string, options?: {refresh?: boolean}): Promise<unknown>}}).browser;
        const readDirectory = browser.readDirectory.bind(browser), failure = new FSError('EIO', 'Remote directory unavailable');
        const listFailure = vi.spyOn(browser, 'readDirectory').mockImplementation(async (path, options) => {
            if (path === remotePath) throw failure;
            return readDirectory(path, options);
        });
        try {
            await expect(workbench.openResource(remotePath, {reload: true})).rejects.toBe(failure);
            expect(workbench.getActiveResourceId()).toBe(remotePath);
            expect(selector.value).toBe(remotePath);
            expect(main.querySelector('.workbench-tabs__panel:not([hidden])')!.textContent).toContain('Remote directory unavailable');
            await vi.waitFor(() => expect(diagnostic.mock.calls.some(([message, details]) => String(message).includes('[itookit/cells]')
                && details?.stage === 'project-open' && details?.projectId === project.project.id && details?.code === 'EIO')).toBe(true));
        } finally {listFailure.mockRestore(); diagnostic.mockRestore();}
        await workbench.openResource(remotePath);
        expect(workbench.getActiveResourceId()).toBe(remotePath);
        await workbench.openResource(initialScope);
        const activePanel = () => main.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')!;
        const profilePath = remoteSessionPath(project.path,'codex'), morePath = profilePath + '/@page:older%2Fbefore%2B%3D';
        await workbench.openResource(profilePath, {preserveProject: true});
        expect(main.textContent).toContain('Native session');
        const create = () => activePanel().querySelector<HTMLButtonElement>('[data-directory-action="enabled"]');
        expect(create()?.title).toBe(t('project.createSession'));
        expect(create()?.getAttribute('aria-label')).toBe(t('project.createSession'));
        const openDraft = vi.spyOn(backend, 'openProjectDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
        create()!.click();
        await vi.waitFor(() => expect(main.querySelector('[data-draft-connection-error]')?.textContent).toContain(t('project.draftLoading.connection')));
        main.querySelector<HTMLButtonElement>('[data-draft-connection-error] button')!.click();
        await vi.waitFor(() => expect(workbench.getActiveResourceId(), main.textContent ?? '').toBe('draft:' + project.project.id));
        expect(openDraft).toHaveBeenCalledTimes(2);
        expect(activePanel().querySelector('[data-selector-id=executorId]')?.textContent).toContain('codex');
        expect(activePanel().querySelector('[data-execution-target]')).toBeNull();
        expect(peer.create).not.toHaveBeenCalled(); expect(peer.turn).not.toHaveBeenCalled();
        await workbench.openResource(profilePath, {preserveProject: true});
        const sidebarCreate = sidebar.querySelector<HTMLButtonElement>('.workbench-project-navigation__create')!;
        expect(sidebarCreate.hidden).toBe(true);
        await workbench.openResource(folderBrowserPath(project.path));
        await workbench.openResource(profilePath, {preserveProject: true});
        await vi.waitFor(() => expect(sidebarCreate.hidden).toBe(false));
        expect(sidebarCreate.title).toBe(t('project.createSession')); sidebarCreate.click();
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('draft:' + project.project.id));
        expect(peer.create).not.toHaveBeenCalled(); expect(peer.turn).not.toHaveBeenCalled();
        await workbench.openResource(profilePath + '/@archived', {preserveProject: true});
        expect(create()).not.toBeNull(); await vi.waitFor(() => expect(sidebarCreate.hidden).toBe(false));
        await workbench.openResource(initialScope);
        await workbench.openResource(profilePath, {preserveProject: true});
        const list = activePanel().querySelector('.workbench-directory__table')!;
        expect(list.querySelector('[data-column="modified"]')?.getAttribute('aria-sort')).toBe('descending');
        const paths = [...list.querySelectorAll<HTMLTableRowElement>('[data-resource-id]')].map(row => row.dataset.resourceId);
        expect(paths[0]).toBe(profilePath + '/@new');
        expect(paths.indexOf(remoteSessionPath(project.path,'codex','native'))).toBeLessThan(paths.indexOf(remoteSessionPath(project.path,'codex','earlier-native')));
        const nativeRow = list.querySelector<HTMLTableRowElement>(`[data-resource-id="${remoteSessionPath(project.path,'codex','native')}"]`)!;
        expect(nativeRow.cells[2].textContent).not.toContain('1970'); expect(nativeRow.cells[2].textContent).not.toBe('—');
        expect(nativeRow.querySelector('button')!.title).toContain(t('workbench.created'));
        expect(nativeRow.querySelector('button')!.title).toContain(t('workbench.modified'));
        for (const id of ['native', 'earlier-native']) {
            const checkbox = list.querySelector<HTMLInputElement>(`[data-selection-id="${remoteSessionPath(project.path, 'codex', id)}"]`)!;
            checkbox.click();
        }
        const bulkDelete = activePanel().querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')!;
        expect(bulkDelete.hidden).toBe(false); bulkDelete.click();
        await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain(t('harness.deleteToArchivePrompt', {count: '2'})));
        document.querySelector<HTMLButtonElement>('dialog button[type=button]')!.click();
        await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
        const bulkUI = (workbench as unknown as {sidebarUI: VFSUIShell}).sidebarUI;
        const nativeIds = ['native', 'earlier-native'].map(id => preview(remoteSessionPath(project.path, 'codex', id)));
        const deleting = bulkUI.runBulkAction('delete', nativeIds);
        await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain(t('harness.deleteToArchivePrompt', {count: '2'})));
        document.querySelector<HTMLButtonElement>('dialog button[type=button]')!.click(); await deleting;
        bulkUI.setSelection([]);
        sessionList.push({...native, id: 'refreshed-native', title: 'Fresh native session'});
        await workbench.refresh();
        expect(activePanel().textContent).toContain('Fresh native session');
        sessionList.pop();
        await workbench.openResource(morePath, {preserveProject: true});
        expect(main.textContent).toContain('Older native session');
        expect(peer.list).toHaveBeenCalledWith('codex',{cursor:'older/before+='},expect.anything());
        await workbench.openResource(morePath + '/older');
        expect(selector.value).toBe(initialScope);
        expect(main.textContent).toContain('Remote native history');
        expect(peer.read).toHaveBeenCalledWith('codex','older',expect.anything());
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        selector.value = '/'; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('/'));
        const ui = (workbench as unknown as {sidebarUI: VFSUIShell}).sidebarUI;
        await ui.expandPath(profilePath);
        const nativePath = remoteSessionPath(project.path,'codex','native');
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${preview(nativePath)}"] .vfs-node-item__title`)?.textContent).toBe('Native session'));
        const nativeItem = sidebar.querySelector(`[data-item-id="${preview(nativePath)}"]`)!;
        expect(nativeItem.textContent).toContain(t('workbench.modified')); expect(nativeItem.textContent).toContain(t('workbench.created'));
        expect(nativeItem.textContent).not.toContain('1970');
        const visible = [...sidebar.querySelectorAll<HTMLElement>('[data-item-type="file"][data-item-id]')].map(item => item.dataset.itemId);
        expect(visible.indexOf(preview(nativePath))).toBeLessThan(visible.indexOf(preview(remoteSessionPath(project.path,'codex','earlier-native'))));
        await workbench.openResource(remoteSessionPath(project.path,'codex','native'));
        expect(main.textContent).toContain('Remote native history');expect(main.textContent).toContain('Server');
        expect(main.querySelector('[data-conversation-source="codex"]')?.textContent).toContain('Codex');
        expect(selector.value).toBe('/');
        expect(factory.mock.calls.at(-1)![1].conversation).toBeDefined();expect(peer.resume).not.toHaveBeenCalled();
        const collapsed = sidebar.classList.contains('is-collapsed');
        const toggle = activePanel().querySelector<HTMLButtonElement>('.ui-content-titlebar > .ui-nav-button')!;
        expect(toggle.hidden).toBe(false); toggle.click();
        await vi.waitFor(() => expect(sidebar.classList.contains('is-collapsed')).toBe(!collapsed));
        toggle.click(); await vi.waitFor(() => expect(sidebar.classList.contains('is-collapsed')).toBe(collapsed));
        activePanel().querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!.click();
        await vi.waitFor(() => expect(activePanel().querySelector('.remote-conversation__branch-create')).not.toBeNull());
        const branchName=activePanel().querySelector<HTMLInputElement>('.remote-conversation__branches input')!;branchName.value='Alternative';
        const forkButton=[...activePanel().querySelectorAll('button')].find(button=>button.textContent===t('harness.createBranch'))!;
        expect(forkButton.disabled).toBe(false);forkButton.click();
        await vi.waitFor(()=>expect(workbench.getActiveResourceId()).toBe(remoteSessionPath(project.path,'codex','branched-native')));
        expect(peer.fork).toHaveBeenCalledWith('codex','native','Alternative',expect.anything());
        expect(selector.value).toBe('/');
        expect(main.textContent).toContain('Remote native history');
        activePanel().querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!.click();
        await vi.waitFor(()=>expect(activePanel().querySelectorAll('.llm-branch-dropdown__item')).toHaveLength(2));
        expect(activePanel().querySelector('.llm-branch-dropdown__item.is-current')?.getAttribute('data-branch-name')).toBe('branched-native');
        activePanel().querySelector<HTMLElement>('[data-branch-name="native"]')!.click();
        await vi.waitFor(()=>expect(workbench.getActiveResourceId()).toBe(remoteSessionPath(project.path,'codex','native')));
        expect(selector.value).toBe('/');
        const folder=await runtime.projects.sessionFolder(project);
        const controls=(workbench as unknown as {remoteAgentControls(folder:string):import('@nestos/llm-ui-adapter/contracts').RemoteAgentControls}).remoteAgentControls(folder);
        const remoteId=(await controls.list())[0].id;expect(remoteId).toContain('remote:');
        const before=(await runtime.sessionRepository.list()).length;
        await workbench.startSessionDraft(remotePath, undefined, remoteId);
        const shell = workbench as any, draftTab = shell.tabs.current, draftEditor = shell.editor;
        const mount = draftTab.panel.querySelector('.session-editor-mount'), textarea = mount.querySelector('.llm-chat__input');
        const history = mount.querySelector('.llm-chat__history'), uuid = mount.dataset.conversationId;
        const composer = await runtime.projects.drafts.open(project.project.id, folder);
        expect(uuid).toBe(composer.id);
        let accept!: () => void;
        const delayed = new Promise<void>(resolve => {accept = resolve;});
        vi.mocked(peer.turn).mockImplementationOnce(async () => {await delayed; return {turnId: 't'};});
        let open!: () => void;
        const opening = new Promise<void>(resolve => {open = resolve;}), projectConversation = remote.projectConversation.bind(remote);
        const handoff = vi.spyOn(remote, 'projectConversation').mockImplementationOnce(async (...args) => {
            await opening; return projectConversation(...args);
        });
        const refreshDraft = vi.spyOn(draftEditor.config.sessionDraft, 'refresh');
        textarea.value = 'remote task'; textarea.dispatchEvent(new Event('input', {bubbles: true}));
        const send = mount.querySelector<HTMLButtonElement>('.llm-chat__composer button[type=submit]')!;
        await vi.waitFor(() => expect(send.disabled).toBe(false)); send.click();
        try {
            await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
            expect(mount.querySelector('.llm-draft-submitting')?.textContent).toBe(t('project.draftLoading.submission'));
            await draftEditor.commands.refreshDraft();
            expect(refreshDraft).not.toHaveBeenCalled();
            expect(send.disabled).toBe(true);
            open();
            await vi.waitFor(() => expect(peer.turn).toHaveBeenCalledOnce());
            expect(mount.querySelector('.llm-draft-submitting')).toBeNull();
            expect(workbench.getActiveResourceId()).toBe('draft:' + project.project.id);
            textarea.value = 'Next remote message'; textarea.dispatchEvent(new Event('input', {bubbles: true}));
            textarea.focus(); textarea.setSelectionRange(4, 4);
        } finally {open(); accept();}
        const promoted = remoteSessionPath(project.path, 'codex', 'new-native');
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(promoted));
        expect(shell.tabs.current).toBe(draftTab); expect(shell.editor).toBe(draftEditor);
        expect(mount.querySelector('.llm-chat__input')).toBe(textarea); expect(mount.querySelector('.llm-chat__history')).toBe(history);
        expect(textarea.value).toBe('Next remote message'); expect(textarea.selectionStart).toBe(4);
        expect(document.activeElement).toBe(textarea); expect(draftTab.conversationId).toBe(uuid);
        expect(mount.querySelector('.llm-draft-scope')).toBeNull();
        expect(peer.create).toHaveBeenCalledOnce(); expect(peer.turn).toHaveBeenCalledWith('codex','new-native','remote task',expect.anything());
        expect((await runtime.sessionRepository.list()).length).toBe(before);
        expect((await runtime.projects.drafts.open(project.project.id, folder)).id).not.toBe(uuid);
        await workbench.openResource(initialScope); await shell.tabs.close(promoted, false);
        await workbench.openResource(promoted);
        expect(shell.tabs.current.conversationId).toBe(uuid);
        expect(activePanel().querySelector<HTMLElement>('.session-editor-mount')!.dataset.conversationId).toBe(uuid);
        expect(activePanel().querySelector<HTMLTextAreaElement>('.llm-chat__input')!.value).toBe('Next remote message');
        vi.mocked(peer.create).mockImplementationOnce(async () => {const session={...native,id:'second-native'};sessionList.push(session);return {session};});
        await controls.send(remoteId,'another task');expect(peer.create).toHaveBeenCalledTimes(2);
        expect(peer.turn).toHaveBeenLastCalledWith('codex','second-native','another task',expect.anything());
        const menu = async () => {
            await workbench.openResource('/'); await ui.showItemMenu(new MouseEvent('contextmenu'), remotePath);
            const host = document.querySelector<HTMLElement>('.vfs-context-menu')!;
            expect(host.querySelector('[data-action="delete"]')).toBeNull(); expect(host.querySelector('[data-action="moveTo"]')).toBeNull();
            expect(host.querySelector('[data-action="copyTo"]')).toBeNull(); expect(host.querySelector('[data-action="unmount-project"]')?.getAttribute('aria-label')).toBe(t('remote.unmountProject'));
            return host;
        };
        const remountAs = async (access: 'ro' | 'rw') => {
            (await menu()).querySelector<HTMLButtonElement>('[data-action="remount-project"]')!.click();
            await vi.waitFor(() => expect(document.querySelector('dialog select')).not.toBeNull());
            document.querySelector<HTMLSelectElement>('dialog select')!.value = access;
            document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
            await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
            expect(remote.list(project.project.id)[0].access).toBe(access); expect(workbench.getActiveResourceId()).toBe('/');
        };
        await remountAs('ro'); await workbench.openResource(profilePath, {reload: true});
        expect(activePanel().querySelector<HTMLButtonElement>('[data-action="create-session"]')!.disabled).toBe(true);
        expect(activePanel().querySelector(`[data-resource-id="${profilePath}/@new"]`)).toBeNull();
        await vi.waitFor(() => expect(sidebarCreate.disabled).toBe(true));
        await workbench.openResource(nativePath);
        const readOnlyInput = activePanel().querySelector<HTMLTextAreaElement>('.llm-chat__input')!;
        readOnlyInput.value = 'Unsent permission probe'; readOnlyInput.dispatchEvent(new Event('input', {bubbles: true}));
        expect(activePanel().querySelector<HTMLButtonElement>('.llm-chat__composer button[type=submit]')!.disabled).toBe(true);
        await remountAs('rw'); await workbench.openResource(nativePath);
        const writableInput = activePanel().querySelector<HTMLTextAreaElement>('.llm-chat__input')!;
        writableInput.value = 'Unsent permission probe'; writableInput.dispatchEvent(new Event('input', {bubbles: true}));
        await vi.waitFor(() => expect(activePanel().querySelector<HTMLButtonElement>('.llm-chat__composer button[type=submit]')!.disabled).toBe(false));
        (await menu()).querySelector<HTMLButtonElement>('[data-action="unmount-project"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain('远端目录'));
        document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
        await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
        expect(remote.list(project.project.id)).toEqual([]); await expect(runtime.projects.get(project.project.id)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await fileSource.fs.driver.exists('/project')).toBe(true); expect(peer.turn).toHaveBeenCalledTimes(2);
    } finally {await workbench.destroy();await runtime.dispose();await fileSource.dispose();fetch.mockRestore();sidebar.remove();main.remove();}
});
