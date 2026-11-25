// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {DigitalTwinService, DreamService, ProjectService} from '@nestos/app-contracts/services';
import {t} from '@nestos/common';
import {DigitalTwinService as NativeTwinService} from '@nestos/app-core';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DreamPage} from '../src/dream/page';
import {DREAM_PATH, TwinWorkbench} from '../src/digital-twin';

afterEach(() => {vi.restoreAllMocks(); document.body.replaceChildren();});
it('configures a source and retries a failed scan with the same operation identity', async () => {
    const config = {name: 'Dream', enabled: true, files: [] as Array<Record<string, unknown>>};
    let revision = 1;
    const run = vi.fn().mockRejectedValueOnce(new Error('DREAM_AUTHORIZATION_UNAVAILABLE')).mockResolvedValue(undefined);
    const service = {list: vi.fn(async () => ({items: [], scanned: 0, truncated: false})), create: vi.fn(async () => ({revision, config})),
        readConfig: vi.fn(async () => ({revision, config})), history: vi.fn(async () => ({items: [], scanned: 0})),
        openView: vi.fn(async () => ({config: {revision, config}, history: {items: [], scanned: 0},
            targets: [{name: 'Scanner', target: {kind: 'flow', id: 'flow', version: '1', digest: 'digest'}}], models: [{id: 'model', name: 'Model'}]})),
        setModelConnection: vi.fn(async () => {}), addFile: vi.fn(async (_owner: string, _dream: string, _op: string, _revision: number, selection: Record<string, unknown>) => {
            config.files.push({...selection, id: 'source', capability: 'fileRead', planId: 'plan', planRevision: '1', twinSourceId: 'twin'});
            return {sourceId: 'source', config: {revision: ++revision, config}};
        }), run} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}, {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}],
        remoteMounts: {list: (id: string) => id === 'remote' ? [{at: '/', protocol: 'cells', connectionId: 'connection'}] : []}} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body);
        const name = document.querySelector<HTMLInputElement>(`input[placeholder="${t('dream.name')}"]`)!; name.value = 'Dream';
        click(t('dream.create'));
        await vi.waitFor(() => expect(document.querySelector(`input[placeholder="${t('dream.path')}"]`)).not.toBeNull());
        expect(document.querySelector<HTMLSelectElement>(`select[aria-label="${t('dream.source')}"]`)!.value).toBe('owner');
        document.querySelector<HTMLSelectElement>(`select[aria-label="${t('dream.source')}"]`)!.value = 'remote';
        document.querySelector<HTMLInputElement>(`input[placeholder="${t('dream.path')}"]`)!.value = '/notes/test.md';
        click(t('dream.addSource'));
        await vi.waitFor(() => expect(service.addFile).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(find(t('dream.scan'))).toBeTruthy());
        click(t('dream.scan'));
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('DREAM_AUTHORIZATION_UNAVAILABLE'));
        click(t('dream.scan'));
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls[0][0].operationId).toBe(run.mock.calls[1][0].operationId);
    } finally {page.destroy();}
});
function find(label: string) {return [...document.querySelectorAll('button')].find(item => item.textContent === label);}
function click(label: string) {const node = find(label); if (!node) throw new Error(`Missing button ${label}`); node.click();}

it('explains a missing source file at the configuration form', async () => {
    const target = {kind: 'flow', id: 'flow', version: '1', digest: 'digest'};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: []}};
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}]}),
        openView: async () => ({config, history: {items: []}, targets: [{name: 'Scanner', target}], models: [{id: 'model', name: 'Model'}]}),
        setModelConnection: async () => {}, addFile: async () => {throw new Error('DREAM_SOURCE_NOT_FOUND');}} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}]} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body); click('Dream');
        await vi.waitFor(() => expect(find(t('dream.addSource'))).toBeTruthy());
        document.querySelector<HTMLInputElement>(`input[placeholder="${t('dream.path')}"]`)!.value = '/missing.md';
        click(t('dream.addSource'));
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('dream.errors.DREAM_SOURCE_NOT_FOUND')));
    } finally {page.destroy();}
});

it('saves consolidation settings and submits a ready subset', async () => {
    const target = {kind: 'flow', id: 'flow', version: '1', digest: 'digest'};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [], consolidation: {target, hotLoadTokens: 1500}}};
    const configureConsolidation = vi.fn(async () => config), commitConsolidation = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('DREAM_SELECTION_CONFLICT'), {field: 'proposal'})).mockResolvedValue({});
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}]}),
        openView: async () => ({config, history: {items: []}, targets: [{name: 'Flow', target}], models: []}),
        configureConsolidation, commitConsolidation, reviewConsolidation: async () => ({version: 'v1', page:
            {items: [{id: 'proposal', revision: 1, status: 'ready', changes: [{id: 'm', content: 'New rule'}], evidenceIds: ['ev1']}]}}),
        readProposalEvidence: async () => ({locator: '/note', granularity: 'excerpt', fingerprint: 'hash', snapshot: 'captured original'})} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}]} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    const label = (key: string) => t(key as Parameters<typeof t>[0]);
    try {
        await page.mount(document.body); click('Dream');
        await vi.waitFor(() => expect(find(label('dream.saveConsolidation'))).toBeTruthy());
        document.querySelector<HTMLInputElement>(`[aria-label="${label('dream.hotLoadBudget')}"]`)!.value = '2400';
        const joint = [...document.querySelectorAll('label')].find(item => item.textContent === label('dream.crossProject'))!;
        joint.querySelector<HTMLInputElement>('input')!.checked = true;
        click(label('dream.saveConsolidation'));
        await vi.waitFor(() => expect(configureConsolidation).toHaveBeenCalledWith('owner', 'dream', expect.any(String), 1, {target, hotLoadTokens: 2400, crossProject: true}));
        await vi.waitFor(() => expect(find(label('dream.reviewProposals'))).toBeTruthy());
        click(label('dream.reviewProposals'));
        await vi.waitFor(() => expect(document.body.textContent).toContain('New rule'));
        click(label('dream.viewEvidence'));
        await vi.waitFor(() => expect(document.body.textContent).toContain('captured original'));
        const row = find(label('dream.viewEvidence'))!.parentElement!;
        row.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = true;
        click(label('dream.commitSelected'));
        await vi.waitFor(() => expect(commitConsolidation).toHaveBeenCalledWith('owner', 'dream', expect.any(String), 'v1', [{id: 'proposal', revision: 1}]));
        await vi.waitFor(() => expect(row.getAttribute('aria-invalid')).toBe('true'));
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('New rule');
        await vi.waitFor(() => expect(find(label('dream.commitSelected'))?.disabled).toBe(false));
        click(label('dream.commitSelected'));
        await vi.waitFor(() => expect(commitConsolidation).toHaveBeenCalledTimes(2));
        expect(commitConsolidation.mock.calls[1][2]).toBe(commitConsolidation.mock.calls[0][2]);
    } finally {page.destroy();}
});

it('shows authorized downstream candidates and adopts one only after an explicit action', async () => {
    const target = {kind: 'flow', id: 'flow', version: '1', digest: 'digest'};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [], consolidation: {target}}};
    const adopt = vi.fn(async () => ({recordId: 'decision'}));
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}]}),
        openView: async () => ({config, history: {items: []}, targets: [{name: 'Flow', target}], models: []}),
        listDownstream: async () => ({items: [{commitId: 'commit', version: 'v1', requiredScopes: ['source'], referenceCommits: ['prior'],
            changes: [{id: 'memory', action: 'add', content: 'Review the deployment rule', evidenceIds: ['evidence']}] }], scanned: 1}),
        readCommittedVersion: async (_owner: string, _dream: string, commitId: string) => ({candidate: {topics: [{id: 'memory', content: `Version ${commitId}`}]}}),
        adoptionBoards: async () => [{id: 'board', title: 'Board', projectId: 'remote'}], adoptDownstreamDecision: adopt} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}, {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}]} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    const label = (key: string) => t(key as Parameters<typeof t>[0]);
    try {
        await page.mount(document.body); click('Dream');
        await vi.waitFor(() => expect(find(label('dream.downstreamCandidates'))).toBeTruthy());
        click(label('dream.downstreamCandidates'));
        await vi.waitFor(() => expect(document.body.textContent).toContain('Review the deployment rule'));
        expect(document.body.textContent).toContain('evidence'); expect(adopt).not.toHaveBeenCalled();
        click(label('dream.viewRollbackOrigin'));
        await vi.waitFor(() => expect(document.body.textContent).toContain('Version prior'));
        click(label('dream.adoptDecision'));
        await vi.waitFor(() => expect(document.querySelector('[data-dream-decision]')).toBeTruthy());
        const form = document.querySelector<HTMLElement>('[data-dream-decision]')!;
        const board = form.querySelector<HTMLSelectElement>(`[aria-label="${label('dream.board')}"]`)!;
        board.value = 'board'; board.dispatchEvent(new Event('change'));
        const project = form.querySelector<HTMLSelectElement>(`[aria-label="${label('kanban.primaryProject')}"]`)!; project.value = 'remote';
        click(label('dream.createDecisionDraft'));
        await vi.waitFor(() => expect(adopt).toHaveBeenCalledWith(expect.objectContaining({runId: 'commit', suggestionId: 'memory', boardId: 'board', targetProjectId: 'remote'})));
    } finally {page.destroy();}
});

it('lets the reviewer set kind, priority and title while preserving inherited metadata', async () => {
    const target = {kind: 'flow', id: 'flow', version: '1', digest: 'digest'};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [], consolidation: {target}}};
    const resolveConsolidation = vi.fn(async () => ({}));
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}]}),
        openView: async () => ({config, history: {items: []}, targets: [{name: 'Flow', target}], models: []}),
        reviewConsolidation: async () => ({version: 'v1', topics: [{id: 'm', kind: 'topic', priority: 8, title: 'Old'}],
            page: {items: [{id: 'proposal', targetId: 'm', revision: 1, status: 'ready', changes: [{id: 'm', content: 'Rule'}], evidenceIds: []}]}}),
        resolveConsolidation} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}]} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    const label = (key: string) => t(key as Parameters<typeof t>[0]);
    try {
        await page.mount(document.body); click('Dream');
        await vi.waitFor(() => expect(find(label('dream.reviewProposals'))).toBeTruthy()); click(label('dream.reviewProposals'));
        await vi.waitFor(() => expect(find(label('dream.editHotload'))).toBeTruthy()); click(label('dream.editHotload'));
        await vi.waitFor(() => expect(document.querySelector('[data-dream-hotload]')).toBeTruthy());
        const form = document.querySelector<HTMLElement>('[data-dream-hotload]')!;
        const kind = form.querySelector<HTMLSelectElement>(`[aria-label="${label('dream.hotloadKind')}"]`)!;
        const priority = form.querySelector<HTMLInputElement>(`[aria-label="${label('dream.hotloadPriority')}"]`)!;
        const title = form.querySelector<HTMLInputElement>(`[aria-label="${label('dream.hotloadTitle')}"]`)!;
        expect([kind.value, priority.value, title.value]).toEqual(['topic', '8', 'Old']);
        kind.value = 'constraint'; priority.value = '12'; title.value = '';
        click(label('dream.saveHotload'));
        await vi.waitFor(() => expect(resolveConsolidation).toHaveBeenCalledWith('owner', 'dream', expect.any(String), 'proposal', 1,
            {action: 'rewrite', changes: [{id: 'm', content: 'Rule', kind: 'constraint', priority: 12, title: null}]}));
    } finally {page.destroy();}
});

it('manually scans selected directories across projects and applies the source type filter', async () => {
    const changes = [
        {id: 'local-docs', projectId: 'owner', directory: '/docs'},
        {id: 'remote-code', projectId: 'remote', directory: '/src'},
        {id: 'remote-commits', projectId: 'remote', directory: '/src', commits: true},
    ];
    const config = {revision: 3, config: {name: 'Work', enabled: true,
        files: [{id: 'scanner', projectId: 'owner', path: '/scanner.md'}], changes}};
    const runAll = vi.fn(async () => ({results: []}));
    const service = {list: async () => ({items: [{id: 'work', name: 'Work'}]}), runAll,
        openView: async () => ({config, history: {items: []}, targets: [], models: [], scheduleStatus: null})} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Local'},
        {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}]} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body); click('Work');
        await vi.waitFor(() => expect(find(t('dream.scanSelected'))).toBeTruthy());
        const section = find(t('dream.scanSelected'))!.closest('details')!;
        const kind = section.querySelectorAll('select')[1]; kind.value = 'files'; kind.dispatchEvent(new Event('change'));
        const labels = [...section.querySelectorAll('label')];
        expect(labels.find(label => label.textContent?.includes(t('dream.scanKind.commits')))?.hidden).toBe(true);
        for (const label of labels.filter(label => label.textContent === 'Local: /docs' || label.textContent === 'Remote: /src'))
            label.querySelector('input')!.checked = true;
        click(t('dream.scanSelected'));
        await vi.waitFor(() => expect(runAll).toHaveBeenCalledWith('owner', 'work', expect.any(String), 3, ['local-docs', 'remote-code']));
    } finally {page.destroy();}
});

it('opens Dream directly, retries its list and skips ordinary Twin reads', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('DREAM_AUTHORIZATION_UNAVAILABLE'))
        .mockResolvedValue({items: [{id: 'dream', name: 'Project Dream'}]});
    const projects = {list: vi.fn(async () => [{project: {id: 'owner'}, name: 'Owner'}])} as unknown as ProjectService;
    const service = {onChange: vi.fn(), readView: vi.fn()} as unknown as DigitalTwinService;
    const sidebar = document.createElement('aside'), editor = document.createElement('main');
    document.body.append(sidebar, editor);
    const selected = vi.fn(), workbench = new TwinWorkbench({sidebar, editor, selected, service, connections: async () => [],
        dream: {service: {list} as unknown as DreamService, projects, openTask: vi.fn(), openSession: vi.fn(), openDecision: vi.fn()}});
    try {
        await workbench.start(DREAM_PATH);
        expect(sidebar.querySelector('[data-item-id="/dream"]')?.textContent).toContain(t('dream.title'));
        expect(workbench.getActiveResourceId()).toBe(DREAM_PATH);
        expect(selected).toHaveBeenCalledWith(DREAM_PATH);
        expect(editor.querySelector('[role=alert]')?.textContent).toContain('DREAM_AUTHORIZATION_UNAVAILABLE');
        click(t('dream.retry'));
        await vi.waitFor(() => expect(find('Project Dream')).toBeTruthy());
        expect(service.onChange).not.toHaveBeenCalled();
        expect(service.readView).not.toHaveBeenCalled();
    } finally {await workbench.destroy();}
});

it('configures, scans and removes a selected directory change source', async () => {
    const file = {id: 'scanner', projectId: 'owner', path: '/scan.md'};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [file], changes: [] as Array<Record<string, unknown>>}};
    const save = vi.fn(async (_owner: string, _dream: string, _op: string, _revision: number, changes: Array<Record<string, unknown>>) => {
        config.config.changes = changes; config.revision++; return config;
    });
    const run = vi.fn(async () => {});
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [], scanned: 0}, scheduleStatus: null}),
        configureChangeSources: save, run} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}], remoteMounts: {list: () => []}} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body); click('Dream'); await vi.waitFor(() => expect(find(t('dream.addChangeSource'))).toBeTruthy());
        document.querySelector<HTMLInputElement>(`[aria-label="${t('dream.changeDirectory')}"]`)!.value = '/docs';
        document.querySelector<HTMLInputElement>(`[aria-label="${t('dream.changeExclude')}"]`)!.value = '/docs/private';
        click(t('dream.addChangeSource')); await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        expect(save.mock.calls[0][4][0]).toMatchObject({projectId: 'owner', directory: '/docs', exclude: ['/docs/private'], scannerSourceId: 'scanner'});
        await vi.waitFor(() => expect(document.body.textContent).toContain('Owner: /docs'));
        const row = [...document.querySelectorAll('div')].find(element => element.firstChild?.textContent === 'Owner: /docs')!;
        [...row.querySelectorAll('button')].find(button => button.textContent === t('dream.scan'))!.click();
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce()); expect(run.mock.calls[0][0].sourceId).toBe(config.config.changes[0].id);
        [...row.querySelectorAll('button')].find(button => button.textContent === t('dream.remove'))!.click();
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2)); expect(save.mock.calls[1][4]).toEqual([]);
    } finally {page.destroy();}
});

it('offers the original retry identity for a configured Session source', async () => {
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [], sessions: [{id: 'remote-source'}]}};
    const run = vi.fn(async () => {}), remove = vi.fn(async () => config);
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [{operationId: 'original', sourceId: 'remote-source',
            startedAt: 1000, state: 'failed', code: 'DREAM_SOURCE_READ_FAILED'}], scanned: 1}}), run, configureSessionSources: remove} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}], remoteMounts: {list: () => []}} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body); click('Dream'); await vi.waitFor(() => expect(find(t('dream.retry'))).toBeTruthy());
        click(t('dream.retry')); await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ownerProjectId: 'owner', dreamId: 'dream', sourceId: 'remote-source', operationId: 'original'}));
        await vi.waitFor(() => expect(find(t('dream.remove'))).toBeTruthy()); click(t('dream.remove'));
        await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce()); expect(remove.mock.calls[0][4]).toEqual([]);
    } finally {page.destroy();}
});

it('selects a local Session by title and configures its bounded window', async () => {
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [{id: 'scanner', projectId: 'owner', path: '/scan.md'}], sessions: [] as Array<Record<string, unknown>>}};
    const configure = vi.fn(async (_owner: string, _dream: string, _op: string, _rev: number, sessions: Array<Record<string, unknown>>) => {
        config.config.sessions = sessions; config.revision++; return config;
    });
    const run = vi.fn().mockRejectedValueOnce(new Error('DREAM_AUTHORIZATION_UNAVAILABLE')).mockResolvedValue(undefined);
    const memorySessions = vi.fn(async () => ({items: [{id: 'chosen', title: 'Research'}], scanned: 1}));
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [], scanned: 0}, scheduleStatus: null}),
        memorySessions, configureSessionSources: configure, run} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}], remoteMounts: {list: () => []}} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body); click('Dream'); await vi.waitFor(() => expect(find(t('dream.loadSessions'))).toBeTruthy());
        click(t('dream.loadSessions')); await vi.waitFor(() => expect(document.body.textContent).toContain('Research'));
        click(t('dream.addSessionSource')); await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
        expect(configure.mock.calls[0][4][0]).toMatchObject({projectId: 'owner', connectionId: 'dream-local', sessionId: 'chosen', maxRounds: 10, scannerSourceId: 'scanner'});
        const label = `Owner: ${t('dream.sourceSession')}`;
        await vi.waitFor(() => expect([...document.querySelectorAll('div')].some(row => row.firstChild?.textContent === label)).toBe(true));
        const row = () => [...document.querySelectorAll('div')].find(element => element.firstChild?.textContent === label)!;
        row().querySelector<HTMLButtonElement>('button')!.click();
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('DREAM_AUTHORIZATION_UNAVAILABLE'));
        row().querySelector<HTMLButtonElement>('button')!.click(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls[0][0].operationId).toBe(run.mock.calls[1][0].operationId);
        await vi.waitFor(() => expect(row().querySelectorAll('button')).toHaveLength(2)); row().querySelectorAll('button')[1].click();
        await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2)); expect(configure.mock.calls[1][4]).toEqual([]);
    } finally {page.destroy();}
});

it.each(['task', 'decision'] as const)('selects a project-bound Kanban %s by title', async kind => {
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [{id: 'scanner', projectId: 'owner', path: '/scan.md'}],
        tasks: [] as Array<Record<string, unknown>>, decisions: [] as Array<Record<string, unknown>>}};
    const configure = vi.fn(async (_owner: string, _dream: string, _op: string, _rev: number, values: Array<Record<string, unknown>>) => {
        config.config[kind === 'task' ? 'tasks' : 'decisions'] = values; config.revision++; return config;
    });
    const run = vi.fn().mockRejectedValueOnce(new Error('DREAM_AUTHORIZATION_UNAVAILABLE')).mockResolvedValue(undefined);
    const candidates = vi.fn(async () => ({items: [{id: 'chosen', title: 'Selected item'}], returned: 1}));
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [], scanned: 0}, scheduleStatus: null}),
        adoptionBoards: async () => [{id: 'board', title: 'Board'}], kanbanSourceCandidates: candidates,
        configureTaskSources: configure, configureDecisionSources: configure, run} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}], remoteMounts: {list: () => []}} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body); click('Dream'); await vi.waitFor(() => expect(find(t('dream.loadBoards'))).toBeTruthy());
        click(t('dream.loadBoards')); await vi.waitFor(() => expect(document.body.textContent).toContain('Board'));
        const select = document.querySelector<HTMLSelectElement>(`[aria-label="${t('dream.kanbanKind')}"]`)!;
        select.value = kind; select.dispatchEvent(new Event('change'));
        click(t('dream.loadKanbanSources')); await vi.waitFor(() => expect(document.body.textContent).toContain('Selected item'));
        click(t('dream.addKanbanSource')); await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
        expect(configure.mock.calls[0][4][0]).toMatchObject({projectId: 'owner', boardId: 'board', scannerSourceId: 'scanner',
            ...(kind === 'task' ? {itemId: 'chosen'} : {recordId: 'chosen'})});
        const label = `Owner: ${t(kind === 'task' ? 'dream.sourceTask' : 'dream.sourceDecision')}`;
        await vi.waitFor(() => expect([...document.querySelectorAll('div')].some(row => row.firstChild?.textContent === label)).toBe(true));
        const getRow = () => [...document.querySelectorAll('div')].find(row => row.firstChild?.textContent === label)!;
        getRow().querySelector<HTMLButtonElement>('button')!.click();
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('DREAM_AUTHORIZATION_UNAVAILABLE'));
        getRow().querySelector<HTMLButtonElement>('button')!.click(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls[0][0].operationId).toBe(run.mock.calls[1][0].operationId);
        await vi.waitFor(() => expect(getRow().querySelectorAll('button')).toHaveLength(2));
        getRow().querySelectorAll('button')[1].click(); await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
        expect(configure.mock.calls[1][4]).toEqual([]);
    } finally {page.destroy();}
});

it('selects an authorized remote Session by profile and title', async () => {
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [{id: 'scanner', projectId: 'owner', path: '/scan.md'}]}};
    const configure = vi.fn(async () => config);
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [], scanned: 0}, scheduleStatus: null}),
        remoteSessionProfiles: async () => [{id: 'profile', name: 'Codex'}],
        remoteSessionCandidates: async () => ({items: [{id: 'remote-session', title: 'Research'}], returned: 1}), configureSessionSources: configure} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}, {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}],
        remoteMounts: {list: (id: string) => id === 'remote' ? [{at: '/', connectionId: 'connection'}] : []}} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body); click('Dream'); await vi.waitFor(() => expect(find(t('dream.loadSessionProfiles'))).toBeTruthy());
        const project = document.querySelector<HTMLSelectElement>(`[aria-label="${t('dream.sessionProject')}"]`)!;
        project.value = 'remote'; project.dispatchEvent(new Event('change'));
        click(t('dream.loadSessionProfiles')); await vi.waitFor(() => expect(document.body.textContent).toContain('Codex'));
        click(t('dream.loadSessions')); await vi.waitFor(() => expect(document.body.textContent).toContain('Research'));
        click(t('dream.addSessionSource')); await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
        expect(configure.mock.calls[0][4][0]).toMatchObject({projectId: 'remote', connectionId: 'connection', profileId: 'profile', sessionId: 'remote-session'});
    } finally {page.destroy();}
});

it('opens Dream from the Twin sidebar, adopts a suggestion and opens the created task', async () => {
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [{id: 'source', projectId: 'remote', path: '/notes/a.md'}], adoptions: [] as Array<Record<string, unknown>>}};
    const finding = {id: 'finding', sourceId: 'source', kind: 'fact', content: '<script>private</script>', quote: 'evidence',
        revision: 1, state: 'active', origin: 'user-correction'};
    const suggestion = {...finding, id: 'suggestion', kind: 'suggestion', content: 'Review types', revision: 0};
    const sessionSuggestion = {...suggestion, id: 'session-suggestion', sourceId: 'session-source', content: 'Review conversation'};
    const duplicate = {...finding, id: 'duplicate', content: 'Duplicate', revision: 0};
    const run = vi.fn(async () => {}), readRun = vi.fn(async () => ({operationId: 'original',
        sources: [{status: 'available', evidence: {sourceId: 'source', projectId: 'remote'}}], findings: [finding, duplicate, suggestion, sessionSuggestion]}));
    const adoptSuggestion = vi.fn(async () => ({itemId: 'created'})), openTask = vi.fn(async () => {});
    const adoptDecision = vi.fn().mockRejectedValueOnce(new Error('DREAM_ADOPTION_RECEIPT_UNAVAILABLE')).mockResolvedValue({recordId: 'draft'});
    const openDecision = vi.fn(async () => {});
    const mergeFindings = vi.fn(async (..._args: unknown[]) => ({mergeId: 'merge'}));
    const bindSessionMemory = vi.fn(async (..._args: unknown[]) => ({revision: 1}));
    const configureAdoptionSources = vi.fn(async (_owner: string, _dream: string, _op: string, _revision: number, sources: Array<Record<string, unknown>>) => {
        config.config.adoptions = sources; config.revision++; return config;
    });
    const adoptionStatus = vi.fn().mockResolvedValueOnce({state: 'committed', itemId: 'created', phase: 'completed'})
        .mockResolvedValue({state: 'committed', itemId: 'created', phase: 'completed', completion: 'accepted', execution: {dispatchId: 'd', sessionId: 's', outputs: [{name: 'result', ref: 'artifact', sha256: 'a'.repeat(64), bytes: 1}]}});
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [{operationId: 'original', sourceId: 'source',
            startedAt: 1000, state: 'failed', code: 'DREAM_EXECUTION_FAILED'}], scanned: 1}}), run, readRun, mergeFindings,
        adoptionBoards: async () => [{id: 'board', title: 'Board'}],
        adoptionTargets: async () => ({items: [{itemId: 'parent', title: 'Parent', projectId: 'remote'}], scanned: 1}), adoptSuggestion, adoptDecision,
        suggestionAdoptions: async () => [{state: 'committed', itemId: 'created', request: {ownerProjectId: 'owner', dreamId: 'dream', runId: 'original',
            suggestionId: 'suggestion', operationId: 'prior', boardId: 'board', targetProjectId: 'remote', parentItemId: 'parent', title: 'Review', responsibility: 'Review', acceptance: 'Checked'}}],
        adoptionStatus, configureAdoptionSources,
        memorySessions: async () => ({items: [{id: 'session', title: 'Session'}], scanned: 1}), sessionMemoryBinding: async () => null, bindSessionMemory} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}, {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}],
        remoteMounts: {list: () => []}} as unknown as ProjectService;
    const sidebar = document.createElement('aside'), editor = document.createElement('main');
    document.body.append(sidebar, editor);
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const twin = new NativeTwinService({fs: await manager.openFileSystem('/'),
        reader: {sessions: async () => [], read: vi.fn()}, extractor: {run: vi.fn(), cleanup: vi.fn(), cancel: vi.fn()}, deleteSession: vi.fn()});
    const page = new TwinWorkbench({sidebar, editor, service: twin, connections: async () => [], selected: vi.fn(),
        dream: {service, projects, openSession: vi.fn(), openTask, openDecision}});
    try {
        await page.start('/overview');
        sidebar.querySelector<HTMLElement>('[data-item-id="/dream"]')!.click();
        await vi.waitFor(() => expect(editor.querySelector('[data-dream-page]')).not.toBeNull());
        await vi.waitFor(() => expect(find('Dream')).toBeTruthy());
        click('Dream');
        await vi.waitFor(() => expect(find(t('dream.retry'))).toBeTruthy());
        const history = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('DREAM_EXECUTION_FAILED'))!;
        history.click();
        await vi.waitFor(() => expect(document.body.textContent).toContain('<script>private</script>'));
        expect(document.querySelector('script')).toBeNull(); expect(document.body.textContent).toContain('evidence');
        expect([...editor.querySelectorAll('button')].filter(button => button.textContent === t('dream.adoptDecision'))).toHaveLength(2);
        expect([...editor.querySelectorAll('button')].filter(button => button.textContent === t('dream.adopt'))).toHaveLength(1);
        click(t('dream.selectMerge')); await vi.waitFor(() => expect(find(t('dream.mergeSelected'))).toBeTruthy());
        click(t('dream.mergeSelected'));
        await vi.waitFor(() => expect(mergeFindings).toHaveBeenCalledOnce());
        expect(mergeFindings.mock.calls[0].slice(0, 4)).toEqual(['owner', 'dream', ['finding', 'duplicate'], [1, 0]]);
        await vi.waitFor(() => expect(find(t('dream.useInSession'))).toBeTruthy());
        click(t('dream.useInSession')); await vi.waitFor(() => expect(find(t('dream.bindMemory'))).toBeTruthy());
        click(t('dream.bindMemory')); await vi.waitFor(() => expect(bindSessionMemory).toHaveBeenCalledOnce());
        expect(bindSessionMemory.mock.calls[0].slice(0, 5)).toEqual(['owner', 'dream', 'session', 'original', ['source']]);
        click(t('dream.adoptDecision')); await vi.waitFor(() => expect(find(t('dream.createDecisionDraft'))).toBeTruthy());
        document.querySelector<HTMLSelectElement>('[data-dream-decision] select')!.value = 'board';
        click(t('dream.createDecisionDraft'));
        await vi.waitFor(() => expect(editor.querySelector('[role="alert"]')?.textContent).toContain('DREAM_ADOPTION_RECEIPT_UNAVAILABLE'));
        click(t('dream.createDecisionDraft'));
        await vi.waitFor(() => expect(find(t('dream.openDecision'))).toBeTruthy());
        expect(adoptDecision.mock.calls[0]).toEqual(adoptDecision.mock.calls[1]);
        expect(adoptDecision.mock.calls[0][0]).toMatchObject({boardId: 'board', targetProjectId: 'remote', title: 'Review types'});
        expect(adoptSuggestion).not.toHaveBeenCalled();
        click(t('dream.openDecision')); await vi.waitFor(() => expect(openDecision).toHaveBeenCalledWith('board', 'draft'));
        click(t('dream.adoptionHistory')); await vi.waitFor(() => expect(find(t('dream.checkTask'))).toBeTruthy());
        click(t('dream.checkTask')); await vi.waitFor(() => expect(document.body.textContent).toContain(t('dream.resultUnverified')));
        click(t('dream.adopt')); await vi.waitFor(() => expect(find(t('dream.createTask'))).toBeTruthy());
        document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('dream.responsibility')}"]`)!.value = 'Review';
        document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('dream.acceptance')}"]`)!.value = 'Checked';
        click(t('dream.createTask')); await vi.waitFor(() => expect(adoptSuggestion).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(find(t('dream.openTask'))).toBeTruthy()); click(t('dream.openTask'));
        await vi.waitFor(() => expect(openTask).toHaveBeenCalledWith('board', 'created'));
        click(t('dream.checkTask')); await vi.waitFor(() => expect(find(t('dream.addAdoptionSource'))).toBeTruthy());
        click(t('dream.addAdoptionSource')); await vi.waitFor(() => expect(configureAdoptionSources).toHaveBeenCalledOnce());
        const label = t('dream.sourceAdoption');
        await vi.waitFor(() => expect([...document.querySelectorAll('div')].some(row => row.firstChild?.textContent === label)).toBe(true));
        const row = () => [...document.querySelectorAll('div')].find(element => element.firstChild?.textContent === label)!;
        run.mockRejectedValueOnce(new Error('DREAM_AUTHORIZATION_UNAVAILABLE'));
        row().querySelector<HTMLButtonElement>('button')!.click();
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('DREAM_AUTHORIZATION_UNAVAILABLE'));
        row().querySelector<HTMLButtonElement>('button')!.click(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls[0][0].operationId).toBe(run.mock.calls[1][0].operationId);
        await vi.waitFor(() => expect(row().querySelectorAll('button')).toHaveLength(2)); row().querySelectorAll('button')[1].click();
        await vi.waitFor(() => expect(configureAdoptionSources).toHaveBeenCalledTimes(2)); expect(configureAdoptionSources.mock.calls[1][4]).toEqual([]);
        click(t('dream.retry')); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
        expect(run).toHaveBeenCalledWith({ownerProjectId: 'owner', dreamId: 'dream', sourceId: 'source', operationId: 'original'});
    } finally {await page.destroy(); await twin.dispose(); await manager.dispose();}
});

it('selects a remote Dream owner, defaults to daily scanning and keeps the schedule identity on retry', async () => {
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: []}};
    const configureSchedule = vi.fn().mockRejectedValueOnce(new Error('DREAM_SCHEDULE_RECONCILE_FAILED'))
        .mockResolvedValue({config, activation: 'ready'});
    const list = vi.fn(async () => ({items: [{id: 'dream', name: 'Daily work'}], scanned: 1, truncated: false}));
    const service = {list, openView: async () => ({config, history: {items: [], scanned: 0}, targets: [], models: [], scheduleStatus: null}),
        configureSchedule} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}, {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}],
        remoteMounts: {list: (id: string) => id === 'remote' ? [{at: '/', protocol: 'cells', connectionId: 'connection'}] : []}} as unknown as ProjectService;
    const page = new DreamPage(service, projects, vi.fn(), vi.fn(), vi.fn());
    try {
        await page.mount(document.body);
        const owner = document.querySelector<HTMLSelectElement>(`select[aria-label="${t('dream.owner')}"]`)!;
        owner.value = 'remote'; owner.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(list).toHaveBeenCalledWith('remote'));
        await vi.waitFor(() => expect(find('Daily work')).toBeTruthy()); click('Daily work');
        await vi.waitFor(() => expect(find(t('dream.saveSchedule'))).toBeTruthy());
        expect(document.querySelector<HTMLSelectElement>(`select[aria-label="${t('dream.source')}"]`)?.value).toBe('remote');
        expect(document.querySelector<HTMLSelectElement>(`select[aria-label="${t('dream.cadence')}"]`)?.value).toBe('daily');
        click(t('dream.saveSchedule')); await vi.waitFor(() => expect(configureSchedule).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('DREAM_SCHEDULE_RECONCILE_FAILED'));
        click(t('dream.saveSchedule')); await vi.waitFor(() => expect(configureSchedule).toHaveBeenCalledTimes(2));
        expect(configureSchedule.mock.calls[0][2]).toBe(configureSchedule.mock.calls[1][2]);
        expect(configureSchedule.mock.calls[0][4]).toEqual(configureSchedule.mock.calls[1][4]);
        expect(configureSchedule.mock.calls[0][0]).toBe('remote');
        expect(configureSchedule.mock.calls[0][4]).toMatchObject({cadence: {kind: 'calendar', hour: 18, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6]}});
    } finally {page.destroy();}
});
