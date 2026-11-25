// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {DreamService, ProjectService} from '@nestos/app-contracts/services';
import {t} from '@nestos/common';
import {DreamDialog} from '../src/dream/dialog';

afterEach(() => {vi.restoreAllMocks(); document.body.replaceChildren();});
it('configures a source and retries a failed scan with the same operation identity', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false;};
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
    const dialog = new DreamDialog(service, projects, vi.fn(), vi.fn());
    try {
        await dialog.open();
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
    } finally {dialog.destroy();}
});
function find(label: string) {return [...document.querySelectorAll('button')].find(item => item.textContent === label);}
function click(label: string) {const node = find(label); if (!node) throw new Error(`Missing button ${label}`); node.click();}

it('configures, scans and removes a selected directory change source', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
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
    const dialog = new DreamDialog(service, projects, vi.fn(), vi.fn());
    try {
        await dialog.open(); click('Dream'); await vi.waitFor(() => expect(find(t('dream.addChangeSource'))).toBeTruthy());
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
    } finally {dialog.destroy();}
});

it('offers the original retry identity for a configured Session source', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [], sessions: [{id: 'remote-source'}]}};
    const run = vi.fn(async () => {}), remove = vi.fn(async () => config);
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [{operationId: 'original', sourceId: 'remote-source',
            startedAt: 1000, state: 'failed', code: 'DREAM_SOURCE_READ_FAILED'}], scanned: 1}}), run, configureSessionSources: remove} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}], remoteMounts: {list: () => []}} as unknown as ProjectService;
    const dialog = new DreamDialog(service, projects, vi.fn(), vi.fn());
    try {
        await dialog.open(); click('Dream'); await vi.waitFor(() => expect(find(t('dream.retry'))).toBeTruthy());
        click(t('dream.retry')); await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ownerProjectId: 'owner', dreamId: 'dream', sourceId: 'remote-source', operationId: 'original'}));
        await vi.waitFor(() => expect(find(t('dream.remove'))).toBeTruthy()); click(t('dream.remove'));
        await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce()); expect(remove.mock.calls[0][4]).toEqual([]);
    } finally {dialog.destroy();}
});

it('selects a local Session by title and configures its bounded window', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
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
    const dialog = new DreamDialog(service, projects, vi.fn(), vi.fn());
    try {
        await dialog.open(); click('Dream'); await vi.waitFor(() => expect(find(t('dream.loadSessions'))).toBeTruthy());
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
    } finally {dialog.destroy();}
});

it.each(['task', 'decision'] as const)('selects a project-bound Kanban %s by title', async kind => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
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
    const dialog = new DreamDialog(service, projects, vi.fn(), vi.fn());
    try {
        await dialog.open(); click('Dream'); await vi.waitFor(() => expect(find(t('dream.loadBoards'))).toBeTruthy());
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
    } finally {dialog.destroy();}
});

it('selects an authorized remote Session by profile and title', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [{id: 'scanner', projectId: 'owner', path: '/scan.md'}]}};
    const configure = vi.fn(async () => config);
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, targets: [], models: [], history: {items: [], scanned: 0}, scheduleStatus: null}),
        remoteSessionProfiles: async () => [{id: 'profile', name: 'Codex'}],
        remoteSessionCandidates: async () => ({items: [{id: 'remote-session', title: 'Research'}], returned: 1}), configureSessionSources: configure} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}, {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}],
        remoteMounts: {list: (id: string) => id === 'remote' ? [{at: '/', connectionId: 'connection'}] : []}} as unknown as ProjectService;
    const dialog = new DreamDialog(service, projects, vi.fn(), vi.fn());
    try {
        await dialog.open(); click('Dream'); await vi.waitFor(() => expect(find(t('dream.loadSessionProfiles'))).toBeTruthy());
        const project = document.querySelector<HTMLSelectElement>(`[aria-label="${t('dream.sessionProject')}"]`)!;
        project.value = 'remote'; project.dispatchEvent(new Event('change'));
        click(t('dream.loadSessionProfiles')); await vi.waitFor(() => expect(document.body.textContent).toContain('Codex'));
        click(t('dream.loadSessions')); await vi.waitFor(() => expect(document.body.textContent).toContain('Research'));
        click(t('dream.addSessionSource')); await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
        expect(configure.mock.calls[0][4][0]).toMatchObject({projectId: 'remote', connectionId: 'connection', profileId: 'profile', sessionId: 'remote-session'});
    } finally {dialog.destroy();}
});

it('shows authorized memory evidence as text and retries a recorded attempt using its original identity', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false;};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: [{id: 'source', projectId: 'remote', path: '/notes/a.md'}], adoptions: [] as Array<Record<string, unknown>>}};
    const finding = {id: 'finding', sourceId: 'source', kind: 'fact', content: '<script>private</script>', quote: 'evidence',
        revision: 1, state: 'active', origin: 'user-correction'};
    const suggestion = {...finding, id: 'suggestion', kind: 'suggestion', content: 'Review types', revision: 0};
    const duplicate = {...finding, id: 'duplicate', content: 'Duplicate', revision: 0};
    const run = vi.fn(async () => {}), readRun = vi.fn(async () => ({operationId: 'original',
        sources: [{status: 'available', evidence: {sourceId: 'source'}}], findings: [finding, duplicate, suggestion]}));
    const adoptSuggestion = vi.fn(async () => ({itemId: 'created'})), openTask = vi.fn(async () => {});
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
        adoptionTargets: async () => ({items: [{itemId: 'parent', title: 'Parent', projectId: 'remote'}], scanned: 1}), adoptSuggestion,
        suggestionAdoptions: async () => [{state: 'committed', itemId: 'created', request: {ownerProjectId: 'owner', dreamId: 'dream', runId: 'original',
            suggestionId: 'suggestion', operationId: 'prior', boardId: 'board', targetProjectId: 'remote', parentItemId: 'parent', title: 'Review', responsibility: 'Review', acceptance: 'Checked'}}],
        adoptionStatus, configureAdoptionSources,
        memorySessions: async () => ({items: [{id: 'session', title: 'Session'}], scanned: 1}), sessionMemoryBinding: async () => null, bindSessionMemory} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}, {project: {id: 'remote', source: {kind: 'remote'}}, name: 'Remote'}],
        remoteMounts: {list: () => []}} as unknown as ProjectService;
    const dialog = new DreamDialog(service, projects, vi.fn(), openTask);
    try {
        await dialog.open(); click('Dream');
        await vi.waitFor(() => expect(find(t('dream.retry'))).toBeTruthy());
        const history = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('DREAM_EXECUTION_FAILED'))!;
        history.click();
        await vi.waitFor(() => expect(document.body.textContent).toContain('<script>private</script>'));
        expect(document.querySelector('script')).toBeNull(); expect(document.body.textContent).toContain('evidence');
        click(t('dream.selectMerge')); await vi.waitFor(() => expect(find(t('dream.mergeSelected'))).toBeTruthy());
        click(t('dream.mergeSelected'));
        await vi.waitFor(() => expect(mergeFindings).toHaveBeenCalledOnce());
        expect(mergeFindings.mock.calls[0].slice(0, 4)).toEqual(['owner', 'dream', ['finding', 'duplicate'], [1, 0]]);
        await vi.waitFor(() => expect(find(t('dream.useInSession'))).toBeTruthy());
        click(t('dream.useInSession')); await vi.waitFor(() => expect(find(t('dream.bindMemory'))).toBeTruthy());
        click(t('dream.bindMemory')); await vi.waitFor(() => expect(bindSessionMemory).toHaveBeenCalledOnce());
        expect(bindSessionMemory.mock.calls[0].slice(0, 5)).toEqual(['owner', 'dream', 'session', 'original', ['source']]);
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
    } finally {dialog.destroy();}
});

it('keeps the schedule and operation identity when saving needs a retry', async () => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    const config = {revision: 1, config: {name: 'Dream', enabled: true, files: []}};
    const configureSchedule = vi.fn().mockRejectedValueOnce(new Error('DREAM_SCHEDULE_RECONCILE_FAILED'))
        .mockResolvedValue({config, activation: 'ready'});
    const service = {list: async () => ({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false}),
        openView: async () => ({config, history: {items: [], scanned: 0}, targets: [], models: [], scheduleStatus: null}), configureSchedule} as unknown as DreamService;
    const projects = {list: async () => [{project: {id: 'owner'}, name: 'Owner'}], remoteMounts: {list: () => []}} as unknown as ProjectService;
    const dialog = new DreamDialog(service, projects, vi.fn(), vi.fn());
    try {
        await dialog.open(); click('Dream'); await vi.waitFor(() => expect(find(t('dream.saveSchedule'))).toBeTruthy());
        click(t('dream.saveSchedule')); await vi.waitFor(() => expect(configureSchedule).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('DREAM_SCHEDULE_RECONCILE_FAILED'));
        click(t('dream.saveSchedule')); await vi.waitFor(() => expect(configureSchedule).toHaveBeenCalledTimes(2));
        expect(configureSchedule.mock.calls[0][2]).toBe(configureSchedule.mock.calls[1][2]);
        expect(configureSchedule.mock.calls[0][4]).toEqual(configureSchedule.mock.calls[1][4]);
    } finally {dialog.destroy();}
});
