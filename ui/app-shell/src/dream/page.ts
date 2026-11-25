import {createModuleLogger, randomUUID, t} from '@nestos/common';
import type {DreamService, DreamAdoptionRecord, DreamAdoptionRequest, DreamConfigurationRecord, DreamProposalView, DreamRunView, ProjectService} from '@nestos/app-contracts/services';

type Project = Awaited<ReturnType<ProjectService['list']>>[number];
type Target = Awaited<ReturnType<DreamService['scannerTargets']>>[number];
const everyDay = [0, 1, 2, 3, 4, 5, 6];

const log = createModuleLogger('dream-page');

/** A Dream is opened only after the user chooses its owning project. */
export class DreamPage {
    private readonly section = document.createElement('section');
    private initialization?: Promise<void>;
    private readonly body = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly owners = document.createElement('select');
    private projects: Project[] = [];
    private owner = '';
    private dream = '';
    private config?: DreamConfigurationRecord;
    private resultSection?: HTMLElement;
    private mergeSelection?: {owner: string; dream: string; id: string; kind: string; content: string; revision: number};
    private createId = randomUUID();
    private createOperation = randomUUID();
    private readonly runOperations = new Map<string, string>();
    private readonly commandOperations = new Map<string, string>();
    private createSignature = '';
    private closed = false;
    constructor(private readonly service: DreamService, private readonly projectsPort: ProjectService,
        private readonly openSession: (id: string) => Promise<void>, private readonly openTask: (board: string, item: string) => Promise<void>,
        private readonly openDecision: (board: string, record: string) => Promise<void>) {
        this.section.className = 'twin__body';
        this.section.dataset.dreamPage = '';
        this.section.setAttribute('aria-label', t('dream.title'));
        const title = document.createElement('h2'); title.textContent = t('dream.title');
        this.status.className = 'twin__error';
        this.status.setAttribute('role', 'alert'); this.owners.setAttribute('aria-label', t('dream.owner'));
        this.owners.onchange = () => {
            this.owner = this.owners.value; this.dream = ''; this.mergeSelection = undefined;
            void this.switchOwner();
        };
        this.section.append(title, this.owners, this.status, this.body);
    }
    mount(container: HTMLElement): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.section.parentElement !== container) container.replaceChildren(this.section);
        return this.initialization ??= this.loadProjects();
    }
    private async loadProjects(): Promise<void> {
        const operationId = randomUUID(), started = performance.now();
        let stage = 'projects';
        this.status.textContent = '';
        this.owners.disabled = true;
        this.body.replaceChildren(text(t('status.loading')));
        try {
            this.projects = await this.projectsPort.list();
            if (this.closed) return;
            this.owners.replaceChildren();
            for (const project of this.projects)
                this.owners.add(option(project.project.id, project.displayName ?? project.name));
            this.owner = this.owners.value;
            stage = 'dreams';
            await this.loadList();
            log.debug('dream.open', {operationId, stage, result: 'success', durationMs: Math.round(performance.now() - started)});
        } catch (error) {
            log.warn('dream.open', {operationId, stage, result: 'failure', code: safeCode(error), durationMs: Math.round(performance.now() - started)});
            if (this.closed) return;
            this.status.textContent = errorText(error);
            this.body.replaceChildren(button(t('dream.retry'), () => this.loadProjects()));
        } finally {if (!this.closed) this.owners.disabled = false;}
    }
    destroy(): void {this.closed = true; this.section.remove();}
    private async switchOwner(): Promise<void> {
        const owner = this.owner;
        this.status.textContent = '';
        this.body.replaceChildren(text(t('status.loading')));
        try {await this.loadList();}
        catch (error) {
            if (this.closed || owner !== this.owner) return;
            this.status.textContent = errorText(error);
            this.body.replaceChildren(button(t('dream.retry'), () => this.switchOwner()));
        }
    }
    private async loadList(): Promise<void> {
        if (!this.owner) {this.body.replaceChildren(text(t('dream.noProjects'))); return;}
        const owner = this.owner, result = await this.service.list(owner);
        if (this.closed || owner !== this.owner) return;
        const name = document.createElement('input'); name.placeholder = t('dream.name');
        const create = button(t('dream.create'), async () => {
            const signature = JSON.stringify([owner, name.value]);
            if (this.createSignature && signature !== this.createSignature) {this.createId = randomUUID(); this.createOperation = randomUUID();}
            this.createSignature = signature;
            await this.service.create(owner, this.createId, this.createOperation, name.value);
            const id = this.createId; this.createId = randomUUID(); this.createOperation = randomUUID();
            if (owner === this.owner) {this.dream = id; await this.refreshAfterWrite(() => this.loadDream());}
        });
        this.body.replaceChildren(name, create);
        for (const item of result.items) this.body.append(button(item.name, async () => {this.dream = item.id; await this.loadDream();}));
        if (result.truncated) this.body.append(text(t('dream.listTruncated')));
    }
    private async loadDream(): Promise<void> {
        const owner = this.owner, dream = this.dream;
        const view = await this.service.openView(owner, dream);
        if (this.closed || owner !== this.owner || dream !== this.dream || !view) return;
        const {config, history, targets, models, scheduleStatus} = view;
        this.config = config; this.body.replaceChildren();
        this.body.append(button(t('dream.back'), () => this.loadList()), text(config.config.name));
        this.body.append(button(t(config.config.enabled ? 'dream.pause' : 'dream.resume'), async () => {
            await this.command(JSON.stringify([owner, dream, 'enabled', config.revision, !config.config.enabled]),
                id => this.service.setEnabled(owner, dream, id, config.revision, !config.config.enabled)); await this.refreshAfterWrite(() => this.loadDream());
        }));
        if (config.config.enabled && config.config.files.length) {
            this.body.append(button(t('dream.scanAll'), () => this.scanBatch(owner, dream, config)));
            this.manualScan(owner, dream, config);
        }
        for (const file of config.config.files) {
            const project = this.projects.find(item => item.project.id === file.projectId);
            const row = document.createElement('div'); row.append(text(`${project?.displayName ?? project?.name ?? t('dream.unavailableProject')}: ${file.path}`));
            row.append(button(t('dream.scan'), async () => {
                const id = this.runOperations.get(file.id) ?? randomUUID(); this.runOperations.set(file.id, id);
                await this.service.run({ownerProjectId: owner, dreamId: dream, sourceId: file.id, operationId: id});
                this.runOperations.delete(file.id); await this.refreshAfterWrite(() => this.loadDream());
            }), button(t('dream.remove'), async () => {await this.command(JSON.stringify([owner, dream, 'remove', config.revision, file.id]),
                id => this.service.removeFile(owner, dream, id, config.revision, file.id)); await this.refreshAfterWrite(() => this.loadDream());}));
            this.body.append(row);
        }
        this.changeSources(owner, dream, config);
        this.otherSources(owner, dream, config);
        this.sessionSourceForm(owner, dream, config);
        this.kanbanSourceForm(owner, dream, config);
        this.sourceForm(owner, dream, config, targets, models);
        this.scheduleForm(owner, dream, config, scheduleStatus);
        this.consolidationForm(owner, dream, config, targets);
        this.body.append(text(t('dream.history')));
        this.appendHistory(owner, dream, history);
    }
    private consolidationForm(owner: string, dream: string, config: DreamConfigurationRecord, targets: Target[]): void {
        const panel = document.createElement('details'), summary = document.createElement('summary');
        summary.textContent = t('dream.consolidation' as Parameters<typeof t>[0]); panel.append(summary);
        const flow = document.createElement('select'), focus = document.createElement('input'), budget = document.createElement('input');
        flow.setAttribute('aria-label', t('dream.consolidationFlow' as Parameters<typeof t>[0]));
        const flows = targets.filter(item => item.target.kind === 'flow');
        flows.forEach((item, index) => flow.add(option(String(index), item.name)));
        const current = flows.findIndex(item => JSON.stringify(item.target) === JSON.stringify(config.config.consolidation?.target));
        if (current >= 0) flow.value = String(current);
        focus.setAttribute('aria-label', t('dream.focus' as Parameters<typeof t>[0])); focus.value = config.config.consolidation?.focus ?? '';
        budget.type = 'number'; budget.min = '0'; budget.max = '100000'; budget.value = String(config.config.consolidation?.hotLoadTokens ?? 1500);
        budget.setAttribute('aria-label', t('dream.hotLoadBudget' as Parameters<typeof t>[0]));
        const joint = document.createElement('input'), jointLabel = document.createElement('label'); joint.type = 'checkbox';
        joint.checked = config.config.consolidation?.crossProject === true; jointLabel.append(joint, t('dream.crossProject' as Parameters<typeof t>[0]));
        panel.append(flow, focus, budget, jointLabel, button(t('dream.saveConsolidation' as Parameters<typeof t>[0]), async () => {
            const selected = flows[Number(flow.value)], hotLoadTokens = Number(budget.value);
            if (!selected || !Number.isSafeInteger(hotLoadTokens) || hotLoadTokens < 0 || hotLoadTokens > 100000) throw new Error('DREAM_CONFIG_INVALID');
            const value = {target: selected.target, ...(focus.value.trim() ? {focus: focus.value.trim()} : {}), hotLoadTokens,
                ...(joint.checked ? {crossProject: true} : config.config.consolidation?.crossProject !== undefined ? {crossProject: false} : {})};
            await this.command(JSON.stringify([owner, dream, 'consolidation', config.revision, value]),
                id => this.service.configureConsolidation(owner, dream, id, config.revision, value));
            await this.refreshAfterWrite(() => this.loadDream());
        }));
        if (config.config.consolidation) this.proposalReview(panel, owner, dream);
        if (config.config.consolidation) this.downstreamReview(panel, owner, dream);
        this.body.append(panel);
    }
    private downstreamReview(panel: HTMLElement, owner: string, dream: string): void {
        const results = document.createElement('div');
        const show = async (kind: 'daily' | 'kanban', after?: string) => {
            const page = await this.service.listDownstream(owner, dream, kind, after);
            results.replaceChildren();
            for (const item of page.items) {
                const group = document.createElement('div');
                if (item.committedAt !== undefined) group.append(text(new Date(item.committedAt).toLocaleDateString()));
                group.append(button(t('dream.viewVersion' as Parameters<typeof t>[0]), () => this.showCommittedVersion(group, owner, dream, item.commitId)));
                for (const reference of item.referenceCommits ?? []) group.append(button(t('dream.viewRollbackOrigin' as Parameters<typeof t>[0]),
                    () => this.showCommittedVersion(group, owner, dream, reference)));
                for (const change of item.changes) {
                    const row = document.createElement('div'), content = change.content ?? t('dream.proposalRetire' as Parameters<typeof t>[0]);
                    row.append(text(t(`dream.downstream.${change.action}` as Parameters<typeof t>[0])), text(content), text(change.evidenceIds.join(' · ')));
                    if (change.kind !== undefined || change.priority !== undefined || change.title !== undefined) {
                        const kind = change.kind === 'topic' ? t('dream.hotloadTopic' as Parameters<typeof t>[0]) : t('dream.hotloadConstraint' as Parameters<typeof t>[0]);
                        row.append(text(`${kind} · ${t('dream.hotloadPriority' as Parameters<typeof t>[0])}: ${change.priority ?? 0}${change.title ? ` · ${change.title}` : ''}`));
                    }
                    for (const ref of change.evidenceRefs ?? []) row.append(button(t('dream.viewEvidence' as Parameters<typeof t>[0]),
                        () => this.showCapturedEvidence(row, owner, dream, ref.proposalId, ref.evidenceId)));
                    const finding: DreamRunView['findings'][number] = {id: change.id, sourceId: item.requiredScopes[0], kind: 'suggestion',
                        content, revision: 1, state: 'active', origin: 'source'};
                    if (kind === 'kanban') row.append(button(t('dream.adoptDecision'), () => this.decisionForm(row, {operationId: item.commitId, sources: [], findings: []}, finding, true)));
                    group.append(row);
                }
                results.append(group);
            }
            if (page.nextCursor) results.append(button(t('dream.moreProposals' as Parameters<typeof t>[0]), () => show(kind, page.nextCursor)));
        };
        panel.append(button(t('dream.downstreamDaily' as Parameters<typeof t>[0]), () => show('daily')),
            button(t('dream.downstreamCandidates' as Parameters<typeof t>[0]), () => show('kanban')), results);
    }
    private async showCommittedVersion(row: HTMLElement, owner: string, dream: string, commitId: string): Promise<void> {
        const version = await this.service.readCommittedVersion(owner, dream, commitId);
        if (!version) throw new Error('DREAM_COMMIT_MISSING');
        const details = document.createElement('pre');
        details.textContent = version.candidate.topics.map(topic => {
            const kind = topic.kind === 'topic' ? t('dream.hotloadTopic' as Parameters<typeof t>[0]) : t('dream.hotloadConstraint' as Parameters<typeof t>[0]);
            const updated = topic.updatedAt === undefined ? '' : ` · ${new Date(topic.updatedAt).toLocaleString()}`;
            return `${kind} · ${t('dream.hotloadPriority' as Parameters<typeof t>[0])}: ${topic.priority ?? 0}${updated}\n${topic.title ? `${topic.title}\n` : ''}${topic.content}`;
        }).join('\n\n'); row.append(details);
    }
    private async showCapturedEvidence(row: HTMLElement, owner: string, dream: string, proposalId: string, evidenceId: string): Promise<void> {
        const evidence = await this.service.readProposalEvidence(owner, dream, proposalId, evidenceId);
        const details = document.createElement('pre');
        details.textContent = `${evidence.locator}\n${evidence.granularity} · ${evidence.fingerprint}\n${evidence.snapshot}`; row.append(details);
    }
    private proposalReview(panel: HTMLElement, owner: string, dream: string): void {
        const scope = document.createElement('select'), results = document.createElement('div');
        scope.setAttribute('aria-label', t('dream.source'));
        for (const project of this.projects) scope.add(option(project.project.id, project.displayName ?? project.name));
        scope.value = owner;
        const show = async (after?: string) => {
            const {page, version, topics} = await this.service.reviewConsolidation(owner, dream, scope.value, after);
            results.replaceChildren();
            const choices: Array<{id: string; revision: number; box: HTMLInputElement; row: HTMLElement}> = [];
            for (const proposal of page.items) {
                const row = document.createElement('div'), box = document.createElement('input'); box.type = 'checkbox';
                box.disabled = proposal.status !== 'ready'; choices.push({id: proposal.id, revision: proposal.revision, box, row});
                row.append(box, text(proposal.changes.map(change => change.content ?? t('dream.proposalRetire' as Parameters<typeof t>[0])).join(' · ')));
                for (const change of proposal.changes) if (change.content !== null && (change.kind !== undefined || change.priority !== undefined || change.title !== undefined)) {
                    const label = change.kind === 'topic' ? t('dream.hotloadTopic' as Parameters<typeof t>[0]) : t('dream.hotloadConstraint' as Parameters<typeof t>[0]);
                    row.append(text(`${label} · ${t('dream.hotloadPriority' as Parameters<typeof t>[0])}: ${change.priority ?? 0}${change.title ? ` · ${change.title}` : ''}`));
                }
                for (const evidenceId of proposal.evidenceIds ?? []) row.append(button(t('dream.viewEvidence' as Parameters<typeof t>[0]),
                    () => this.showCapturedEvidence(row, owner, dream, proposal.id, evidenceId)));
                if (proposal.status === 'ready') row.append(button(t('dream.editHotload' as Parameters<typeof t>[0]),
                    () => this.editHotload(row, owner, dream, proposal, topics ?? [])));
                if (proposal.status === 'conflict') {
                    row.append(text(t('dream.proposalConflict' as Parameters<typeof t>[0])));
                    const edits = proposal.changes.map(change => {
                        if (change.content === null) return null;
                        const input = document.createElement('textarea'); input.value = change.content;
                        input.setAttribute('aria-label', t('dream.proposalRewrite' as Parameters<typeof t>[0])); row.append(input); return input;
                    });
                    if (edits.some(Boolean)) row.append(button(t('dream.proposalRewrite' as Parameters<typeof t>[0]), async () => {
                        const changes = proposal.changes.map((change, index) => ({...change, content: edits[index]?.value ?? null}));
                        await this.command(JSON.stringify([owner, dream, 'rewrite', proposal.id, proposal.revision, changes]),
                            id => this.service.resolveConsolidation(owner, dream, id, proposal.id, proposal.revision, {action: 'rewrite', changes}));
                        await this.refreshAfterWrite(() => this.loadDream());
                    }));
                    for (const evidenceId of proposal.evidenceIds) row.append(button(`${t('dream.proposalChoose' as Parameters<typeof t>[0])}: ${evidenceId}`, async () => {
                        await this.command(JSON.stringify([owner, dream, 'resolve', proposal.id, proposal.revision, evidenceId]),
                            id => this.service.resolveConsolidation(owner, dream, id, proposal.id, proposal.revision, {action: 'choose', evidenceId}));
                        await this.refreshAfterWrite(() => this.loadDream());
                    }));
                    row.append(button(t('dream.proposalReject' as Parameters<typeof t>[0]), async () => {
                        await this.command(JSON.stringify([owner, dream, 'reject', proposal.id, proposal.revision]),
                            id => this.service.resolveConsolidation(owner, dream, id, proposal.id, proposal.revision, {action: 'reject'}));
                        await this.refreshAfterWrite(() => this.loadDream());
                    }));
                }
                results.append(row);
            }
            results.append(button(t('dream.commitSelected' as Parameters<typeof t>[0]), async () => {
                const selected = choices.filter(choice => choice.box.checked).map(({id, revision}) => ({id, revision}));
                try {await this.command(JSON.stringify([owner, dream, 'commit', version, selected]),
                    id => this.service.commitConsolidation(owner, dream, id, version, selected));}
                catch (error) {
                    const field = (error as {field?: unknown})?.field;
                    const failed = choices.find(choice => choice.id === field);
                    if (failed) {failed.row.setAttribute('aria-invalid', 'true'); this.status.textContent = `${errorText(error)}: ${failed.row.textContent ?? ''}`; return;}
                    throw error;
                }
                await this.refreshAfterWrite(() => this.loadDream());
            }));
            if (page.nextCursor) results.append(button(t('dream.moreProposals' as Parameters<typeof t>[0]), () => show(page.nextCursor)));
        };
        panel.append(scope, button(t('dream.reviewProposals' as Parameters<typeof t>[0]), () => show()), results);
    }
    private editHotload(row: HTMLElement, owner: string, dream: string, proposal: DreamProposalView,
        topics: Array<{id: string; kind?: 'constraint' | 'topic'; priority?: number; title?: string}>): void {
        if (row.querySelector('[data-dream-hotload]')) return;
        const form = document.createElement('div'); form.dataset.dreamHotload = '';
        const fields = proposal.changes.map(change => {
            if (change.content === null) return null;
            const kind = document.createElement('select'), priority = document.createElement('input'), title = document.createElement('input');
            const previous = topics.find(item => item.id === change.id);
            kind.setAttribute('aria-label', t('dream.hotloadKind' as Parameters<typeof t>[0]));
            kind.add(option('constraint', t('dream.hotloadConstraint' as Parameters<typeof t>[0])));
            kind.add(option('topic', t('dream.hotloadTopic' as Parameters<typeof t>[0])));
            kind.value = change.kind ?? previous?.kind ?? 'constraint';
            if (proposal.constraint && change.id === proposal.targetId) {kind.value = 'constraint'; kind.disabled = true;}
            priority.type = 'number'; priority.min = '-1000'; priority.max = '1000'; priority.value = String(change.priority ?? previous?.priority ?? 0);
            priority.setAttribute('aria-label', t('dream.hotloadPriority' as Parameters<typeof t>[0]));
            title.value = change.title === null ? '' : change.title ?? previous?.title ?? ''; title.maxLength = 500; title.setAttribute('aria-label', t('dream.hotloadTitle' as Parameters<typeof t>[0]));
            form.append(text(change.id), kind, priority, title); return {kind, priority, title};
        });
        form.append(button(t('dream.saveHotload' as Parameters<typeof t>[0]), async () => {
            const changes = proposal.changes.map((change, index) => {
                const field = fields[index]; if (!field) return change;
                const priority = Number(field.priority.value);
                if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1000) throw new Error('DREAM_PROPOSAL_INVALID');
                const title = field.title.value.trim();
                return {...change, kind: field.kind.value as 'constraint' | 'topic', priority, title: title || null};
            });
            await this.command(JSON.stringify([owner, dream, 'hotload', proposal.id, proposal.revision, changes]),
                id => this.service.resolveConsolidation(owner, dream, id, proposal.id, proposal.revision, {action: 'rewrite', changes}));
            await this.refreshAfterWrite(() => this.loadDream());
        })); row.append(form);
    }
    private async scanBatch(owner: string, dream: string, config: DreamConfigurationRecord, sourceIds?: string[]): Promise<void> {
        const key = JSON.stringify([owner, dream, 'batch', config.revision, sourceIds]), operationId = this.commandOperations.get(key) ?? randomUUID();
        this.commandOperations.set(key, operationId);
        const result = sourceIds === undefined ? await this.service.runAll(owner, dream, operationId, config.revision)
            : await this.service.runAll(owner, dream, operationId, config.revision, sourceIds);
        const failed = result.results.filter(item => item.status === 'failed');
        if (!failed.length) this.commandOperations.delete(key);
        if (owner !== this.owner || dream !== this.dream) return;
        await this.refreshAfterWrite(() => this.loadDream());
        if (failed.length && owner === this.owner && dream === this.dream) this.status.textContent = `${t('dream.partialFailure')} ${failed.map(item =>
            `${this.sourceLabel(config, item.sourceId)}: ${errorText(new Error(item.code ?? 'DREAM_SCAN_FAILED'))}`).join('；')}`;
    }
    private manualScan(owner: string, dream: string, record: DreamConfigurationRecord): void {
        const {files, changes, sessions} = record.config;
        const scope = document.createElement('details'), summary = document.createElement('summary');
        scope.className = 'twin__panel';
        summary.textContent = t('dream.manualScan'); scope.append(summary);
        const project = document.createElement('select'), kind = document.createElement('select');
        project.setAttribute('aria-label', t('dream.source')); kind.setAttribute('aria-label', t('dream.scanKind'));
        project.add(option('', t('dream.scanAllProjects'))); kind.add(option('', t('dream.scanAllKinds')));
        const sources = [...files.map(source => ({...source, kind: 'files'})),
            ...(changes ?? []).map(source => ({...source, kind: source.commits ? 'commits' : 'files'})),
            ...(sessions ?? []).map(source => ({...source, kind: 'sessions'}))];
        for (const item of this.projects.filter(item => sources.some(source => source.projectId === item.project.id)))
            project.add(option(item.project.id, item.displayName ?? item.name));
        for (const value of ['files', 'sessions', 'commits'] as const) kind.add(option(value, t(`dream.scanKind.${value}`)));
        const choices = sources.map(source => {
            const label = document.createElement('label'), checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            label.append(checkbox, this.sourceLabel(record, source.id)); return {source, label, checkbox};
        });
        const filter = () => {for (const {source, label} of choices)
            label.hidden = !!project.value && project.value !== source.projectId || !!kind.value && kind.value !== source.kind;};
        project.onchange = filter; kind.onchange = filter;
        const run = button(t('dream.scanSelected'), async () => {
            const selected = choices.filter(item => !item.label.hidden && item.checkbox.checked).map(item => item.source.id);
            if (!selected.length) throw new Error('DREAM_BATCH_SELECTION_INVALID');
            await this.scanBatch(owner, dream, record, selected);
        });
        const controls = document.createElement('div'); controls.className = 'twin__form';
        controls.append(project, kind, ...choices.map(item => item.label), run);
        scope.append(controls); this.body.append(scope);
    }
    private scheduleForm(owner: string, dream: string, config: DreamConfigurationRecord,
        status: NonNullable<Awaited<ReturnType<DreamService['openView']>>>['scheduleStatus']): void {
        const section = document.createElement('section'), existing = config.config.schedule;
        section.append(text(t('dream.schedule')));
        if (status) section.append(text(`${t(`dream.scheduleState.${status.state}`)}${status.nextAt ? ` · ${t('dream.nextTime')}: ${scheduleTime(status.nextAt, existing?.timeZone)}` : ''}${status.code ? ` (${status.code})` : ''}`));
        if (status?.last) section.append(text(`${t('dream.lastRound')}: ${scheduleTime(status.last.scheduledAt, existing?.timeZone)} · ${t(`dream.round.${status.last.status}`)}${status.last.code ? ` (${status.last.code})` : ''}`));
        for (const failure of status?.last?.failures ?? []) {
            section.append(text(`${this.sourceLabel(config, failure.sourceId)}: ${failure.code}`));
        }
        const cadence = document.createElement('select'), zone = document.createElement('input'), interval = document.createElement('input'), time = document.createElement('input');
        cadence.setAttribute('aria-label', t('dream.cadence'));
        cadence.add(option('daily', t('dream.daily'))); cadence.add(option('calendar', t('dream.weekly'))); cadence.add(option('interval', t('dream.interval')));
        const remote = this.projects.find(item => item.project.id === owner)?.project.source?.kind === 'remote';
        cadence.value = existing?.cadence.kind === 'calendar' && existing.cadence.weekdays.length === everyDay.length
            ? 'daily' : existing?.cadence.kind ?? (remote ? 'daily' : 'interval');
        zone.setAttribute('aria-label', t('dream.timeZone')); zone.placeholder = t('dream.timeZone');
        zone.value = existing?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
        interval.type = 'number'; interval.min = '1'; interval.setAttribute('aria-label', t('dream.intervalMinutes'));
        interval.value = String(existing?.cadence.kind === 'interval' ? existing.cadence.milliseconds / 60000 : 60);
        time.type = 'time'; time.setAttribute('aria-label', t('dream.timeOfDay'));
        time.value = existing?.cadence.kind === 'calendar' ? `${String(existing.cadence.hour).padStart(2, '0')}:${String(existing.cadence.minute).padStart(2, '0')}` : remote ? '18:00' : '09:00';
        section.append(cadence, zone, interval, time);
        const weekdays = Array.from({length: 7}, (_, day) => {
            const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox';
            box.checked = existing?.cadence.kind === 'calendar' ? existing.cadence.weekdays.includes(day) : true;
            label.append(box, t(`dream.weekday.${day}` as Parameters<typeof t>[0])); section.append(label); return box;
        });
        const updateCadence = () => {interval.hidden = cadence.value !== 'interval'; time.hidden = !interval.hidden;
            for (const box of weekdays) if (box.parentElement) box.parentElement.hidden = cadence.value !== 'calendar';};
        cadence.onchange = updateCadence; updateCadence();
        let draft: {signature: string; value: NonNullable<DreamConfigurationRecord['config']['schedule']>} | undefined;
        const save = button(t('dream.saveSchedule'), async () => {
            const [hour, minute] = time.value.split(':').map(Number);
            const days = cadence.value === 'daily' ? everyDay : weekdays.flatMap((box, index) => box.checked ? [index] : []);
            const minutes = Number(interval.value), signature = JSON.stringify([cadence.value, zone.value, minutes, hour, minute, days]);
            if (!draft || draft.signature !== signature) draft = {signature, value: {state: 'active', timeZone: zone.value, trigger: 'fixed', maxConcurrency: 1,
                firstAt: cadence.value === 'interval' ? Date.now() + minutes * 60000 : 0,
                cadence: cadence.value === 'interval' ? {kind: 'interval', milliseconds: minutes * 60000} : {kind: 'calendar', hour, minute, weekdays: days}}};
            await this.saveSchedule(owner, dream, config.revision, draft.value); await this.refreshAfterWrite(() => this.loadDream());
        });
        section.append(save);
        if (existing) {
            section.append(button(t(existing.state === 'active' ? 'dream.pauseSchedule' : 'dream.resumeSchedule'), async () => {
                await this.saveSchedule(owner, dream, config.revision, {...existing, state: existing.state === 'active' ? 'paused' : 'active'});
                await this.refreshAfterWrite(() => this.loadDream());
            }), button(t('dream.removeSchedule'), async () => {
                await this.saveSchedule(owner, dream, config.revision, null); await this.refreshAfterWrite(() => this.loadDream());
            }));
        }
        this.body.append(section);
    }
    private async saveSchedule(owner: string, dream: string, revision: number, schedule: DreamConfigurationRecord['config']['schedule'] | null): Promise<void> {
        const key = JSON.stringify([owner, dream, 'schedule', revision, schedule]), operationId = this.commandOperations.get(key) ?? randomUUID();
        this.commandOperations.set(key, operationId);
        const result = await this.service.configureSchedule(owner, dream, operationId, revision, schedule ?? null);
        this.commandOperations.delete(key);
        if (result.activation === 'pending') this.status.textContent = `${t('dream.schedulePending')} (${result.code ?? 'DREAM_SCHEDULE_RECONCILE_FAILED'})`;
    }
    private appendHistory(owner: string, dream: string, history: Awaited<ReturnType<DreamService['history']>>): void {
        for (const item of history.items) {
            const row = document.createElement('div');
            row.append(button(`${new Date(item.startedAt).toLocaleString()} · ${t(`dream.state.${item.state}`)}${item.code ? ` (${item.code})` : ''}`,
                async () => {const run = await this.service.readRun(owner, dream, item.operationId);
                    if (owner === this.owner && dream === this.dream) this.showRun(run, item.operationId);}));
            if (item.state !== 'settled' && item.sourceId && this.hasSource(item.sourceId))
                row.append(button(t('dream.retry'), async () => {await this.service.run({ownerProjectId: owner, dreamId: dream,
                    sourceId: item.sourceId!, operationId: item.operationId}); await this.refreshAfterWrite(() => this.loadDream());}));
            this.body.append(row);
        }
        if (history.nextCursor) {
            const more = button(t('dream.moreHistory'), async () => {
                const next = await this.service.history(owner, dream, history.nextCursor); more.remove(); this.appendHistory(owner, dream, next);
            }); this.body.append(more);
        }
    }
    private hasSource(id: string): boolean {
        const config = this.config?.config;
        return !!config && [config.files, config.adoptions ?? [], config.decisions ?? [], config.tasks ?? [], config.sessions ?? [], config.changes ?? []]
            .some(sources => sources.some(source => source.id === id));
    }
    private sourceLabel(record: DreamConfigurationRecord, id: string): string {
        const config = record.config, file = config.files.find(source => source.id === id);
        const change = config.changes?.find(source => source.id === id), session = config.sessions?.find(source => source.id === id);
        const task = config.tasks?.find(source => source.id === id), decision = config.decisions?.find(source => source.id === id);
        const source = file ?? change ?? session ?? task ?? decision;
        const project = this.projects.find(item => item.project.id === source?.projectId);
        const name = project?.displayName ?? project?.name ?? t('dream.unavailableProject');
        if (file) return `${name}: ${file.path}`;
        if (change) return `${name}: ${change.directory}${change.commits ? ' · ' + t('dream.scanKind.commits') : ''}`;
        if (session) return `${name}: ${t('dream.sourceSession')}`;
        if (task) return `${name}: ${t('dream.sourceTask')}`;
        if (decision) return `${name}: ${t('dream.sourceDecision')}`;
        return config.adoptions?.some(item => item.id === id) ? t('dream.sourceAdoption') : t('dream.unavailableProject');
    }
    private otherSources(owner: string, dream: string, record: DreamConfigurationRecord): void {
        const config = record.config;
        for (const source of [...config.sessions ?? [], ...config.tasks ?? [], ...config.decisions ?? [], ...config.adoptions ?? []]) {
            const row = document.createElement('div'); row.append(text(this.sourceLabel(record, source.id)));
            row.append(button(t('dream.scan'), async () => {
                const id = this.runOperations.get(source.id) ?? randomUUID(); this.runOperations.set(source.id, id);
                await this.service.run({ownerProjectId: owner, dreamId: dream, sourceId: source.id, operationId: id});
                this.runOperations.delete(source.id); await this.refreshAfterWrite(() => this.loadDream());
            }), button(t('dream.remove'), async () => {
                await this.command(JSON.stringify([owner, dream, 'remove-source', record.revision, source.id]), async id => {
                    if (config.sessions?.some(item => item.id === source.id))
                        await this.service.configureSessionSources(owner, dream, id, record.revision, config.sessions.filter(item => item.id !== source.id));
                    else if (config.tasks?.some(item => item.id === source.id))
                        await this.service.configureTaskSources(owner, dream, id, record.revision, config.tasks.filter(item => item.id !== source.id));
                    else if (config.decisions?.some(item => item.id === source.id))
                        await this.service.configureDecisionSources(owner, dream, id, record.revision, config.decisions.filter(item => item.id !== source.id));
                    else if (config.adoptions?.some(item => item.id === source.id))
                        await this.service.configureAdoptionSources(owner, dream, id, record.revision, config.adoptions.filter(item => item.id !== source.id));
                });
                await this.refreshAfterWrite(() => this.loadDream());
            }));
            this.body.append(row);
        }
    }
    private changeSources(owner: string, dream: string, config: DreamConfigurationRecord): void {
        const changes = config.config.changes ?? [];
        for (const source of changes) {
            const project = this.projects.find(item => item.project.id === source.projectId), row = document.createElement('div');
            row.append(text(`${project?.displayName ?? project?.name ?? t('dream.unavailableProject')}: ${source.directory}${source.commits ? ' · ' + t('dream.scanKind.commits') : ''}`));
            row.append(button(t('dream.scan'), async () => {
                const id = this.runOperations.get(source.id) ?? randomUUID(); this.runOperations.set(source.id, id);
                await this.service.run({ownerProjectId: owner, dreamId: dream, sourceId: source.id, operationId: id});
                this.runOperations.delete(source.id); await this.refreshAfterWrite(() => this.loadDream());
            }), button(t('dream.remove'), async () => {
                const next = changes.filter(item => item.id !== source.id);
                await this.command(JSON.stringify([owner, dream, 'changes', config.revision, next]),
                    id => this.service.configureChangeSources(owner, dream, id, config.revision, next));
                await this.refreshAfterWrite(() => this.loadDream());
            }));
            this.body.append(row);
        }
        if (!config.config.files.length) return;
        const project = document.createElement('select'), scanner = document.createElement('select');
        const directory = document.createElement('input'), exclude = document.createElement('input'), limit = document.createElement('input');
        const kind = document.createElement('select'), extensions = document.createElement('input');
        kind.setAttribute('aria-label', t('dream.scanKind'));
        kind.add(option('files', t('dream.scanKind.files')));
        const gitOption = option('commits', t('dream.scanKind.commits')); kind.add(gitOption);
        extensions.placeholder = t('dream.changeExtensions'); extensions.setAttribute('aria-label', t('dream.changeExtensions'));
        kind.onchange = () => {extensions.hidden = kind.value === 'commits';};
        project.setAttribute('aria-label', t('dream.source')); scanner.setAttribute('aria-label', t('dream.changeScanner'));
        directory.setAttribute('aria-label', t('dream.changeDirectory')); directory.placeholder = t('dream.changeDirectory');
        exclude.setAttribute('aria-label', t('dream.changeExclude')); exclude.placeholder = t('dream.changeExclude');
        limit.type = 'number'; limit.min = '1'; limit.max = '128'; limit.value = '64'; limit.setAttribute('aria-label', t('dream.changeLimit'));
        this.sourceProjects(project, owner);
        const updateKinds = () => {
            gitOption.disabled = !this.connection(project.value) || this.connection(project.value) === 'dream-local';
            if (gitOption.disabled && kind.value === 'commits') kind.value = 'files';
            extensions.hidden = kind.value === 'commits';
        };
        project.onchange = updateKinds; updateKinds();
        for (const file of config.config.files) {
            const item = this.projects.find(value => value.project.id === file.projectId);
            scanner.add(option(file.id, `${item?.displayName ?? item?.name ?? t('dream.unavailableProject')}: ${file.path}`));
        }
        const sourceId = randomUUID();
        const add = button(t('dream.addChangeSource'), async () => {
            const connectionId = this.connection(project.value);
            if (!connectionId || !scanner.value) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const git = kind.value === 'commits';
            if (git && connectionId === 'dream-local') throw new Error('DREAM_GIT_UNAVAILABLE');
            const suffixes = extensions.value.split(',').map(item => item.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
            const next = [...changes, {id: sourceId, projectId: project.value, connectionId, directory: directory.value,
                exclude: exclude.value.split(',').map(item => item.trim()).filter(Boolean), maxEntries: Number(limit.value), scannerSourceId: scanner.value,
                ...(git ? {commits: true as const} : suffixes.length ? {extensions: suffixes} : {})}];
            await this.command(JSON.stringify([owner, dream, 'changes', config.revision, next]),
                id => this.service.configureChangeSources(owner, dream, id, config.revision, next));
            await this.refreshAfterWrite(() => this.loadDream());
        });
        add.disabled = !project.options.length || !scanner.options.length;
        this.body.append(project, kind, directory, exclude, extensions, limit, scanner, add);
    }
    private sessionSourceForm(owner: string, dream: string, config: DreamConfigurationRecord): void {
        if (!config.config.files.length) return;
        const project = document.createElement('select'), session = document.createElement('select'), scanner = document.createElement('select'), profile = document.createElement('select');
        const rounds = document.createElement('input'); rounds.type = 'number'; rounds.min = '1'; rounds.max = '20'; rounds.value = '10';
        project.setAttribute('aria-label', t('dream.sessionProject')); session.setAttribute('aria-label', t('dream.sourceSession'));
        profile.setAttribute('aria-label', t('dream.sessionProfile'));
        scanner.setAttribute('aria-label', t('dream.sessionScanner')); rounds.setAttribute('aria-label', t('dream.sessionRounds'));
        this.sourceProjects(project, owner);
        for (const file of config.config.files) {
            const item = this.projects.find(value => value.project.id === file.projectId);
            scanner.add(option(file.id, `${item?.displayName ?? item?.name ?? t('dream.unavailableProject')}: ${file.path}`));
        }
        let loadedProject = '', loadedProfiles = '', cursor: string | undefined;
        const profiles = button(t('dream.loadSessionProfiles'), async () => {
            const selected = project.value, connection = this.connection(selected);
            if (!connection || connection === 'dream-local') throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const values = await this.service.remoteSessionProfiles(owner, selected, connection);
            if (selected !== project.value || !profile.isConnected) return;
            profile.replaceChildren(); for (const value of values) profile.add(option(value.id, value.name)); loadedProfiles = selected;
        });
        const more = button(t('dream.loadSessions'), async () => {
            const selected = project.value, connection = this.connection(selected), scope = JSON.stringify([selected, connection, profile.value]);
            if (!connection || (connection !== 'dream-local' && (loadedProfiles !== selected || !profile.value))) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const next = connection === 'dream-local' ? await this.service.memorySessions(selected, scope === loadedProject ? cursor : undefined)
                : await this.service.remoteSessionCandidates(owner, selected, connection, profile.value, scope === loadedProject ? cursor : undefined);
            if (scope !== JSON.stringify([project.value, this.connection(project.value), profile.value]) || !project.isConnected) return;
            if (scope !== loadedProject) session.replaceChildren();
            loadedProject = scope; cursor = next.nextCursor;
            for (const item of next.items) session.add(option(item.id, item.title));
            more.hidden = !cursor; add.disabled = !session.options.length;
        });
        const clear = () => {loadedProject = ''; cursor = undefined; session.replaceChildren(); more.hidden = false; add.disabled = true;};
        const showProfile = () => {profiles.hidden = profile.hidden = this.connection(project.value) === 'dream-local';};
        project.onchange = () => {loadedProfiles = ''; profile.replaceChildren(); clear(); showProfile();}; profile.onchange = clear;
        const sourceId = randomUUID(), add = button(t('dream.addSessionSource'), async () => {
            const connectionId = this.connection(project.value), scope = JSON.stringify([project.value, connectionId, profile.value]);
            if (!session.value || scope !== loadedProject || !connectionId) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const next = [...config.config.sessions ?? [], {id: sourceId, projectId: project.value, connectionId,
                sessionId: session.value, ...(connectionId !== 'dream-local' ? {profileId: profile.value} : {}), maxRounds: Number(rounds.value), scannerSourceId: scanner.value}];
            await this.command(JSON.stringify([owner, dream, 'sessions', config.revision, next]),
                id => this.service.configureSessionSources(owner, dream, id, config.revision, next));
            await this.refreshAfterWrite(() => this.loadDream());
        });
        more.disabled = !project.options.length; add.disabled = true; showProfile();
        this.body.append(project, profiles, profile, more, session, rounds, scanner, add);
    }
    private kanbanSourceForm(owner: string, dream: string, record: DreamConfigurationRecord): void {
        const config = record.config; if (!config.files.length) return;
        const project = document.createElement('select'), board = document.createElement('select'), kind = document.createElement('select');
        const item = document.createElement('select'), scanner = document.createElement('select');
        project.setAttribute('aria-label', t('dream.kanbanProject')); board.setAttribute('aria-label', t('dream.kanbanBoard'));
        kind.setAttribute('aria-label', t('dream.kanbanKind')); item.setAttribute('aria-label', t('dream.kanbanItem'));
        scanner.setAttribute('aria-label', t('dream.kanbanScanner'));
        kind.add(option('task', t('dream.sourceTask'))); kind.add(option('decision', t('dream.sourceDecision')));
        this.sourceProjects(project, owner);
        for (const file of config.files) {const value = this.projects.find(project => project.project.id === file.projectId);
            scanner.add(option(file.id, `${value?.displayName ?? value?.name ?? t('dream.unavailableProject')}: ${file.path}`));}
        const loadBoards = button(t('dream.loadBoards'), async () => {
            const values = await this.service.adoptionBoards(owner); if (!board.isConnected) return;
            board.replaceChildren(); for (const value of values) board.add(option(value.id, value.title)); clear();
        });
        let loaded = '', cursor: string | undefined;
        const clear = () => {loaded = ''; cursor = undefined; item.replaceChildren(); more.hidden = false; add.disabled = true;};
        project.onchange = clear; board.onchange = clear; kind.onchange = clear;
        const more = button(t('dream.loadKanbanSources'), async () => {
            const connection = this.connection(project.value), scope = JSON.stringify([project.value, connection, board.value, kind.value]);
            if (!connection || !board.value) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const page = await this.service.kanbanSourceCandidates(owner, project.value, connection, board.value,
                kind.value as 'task' | 'decision', loaded === scope ? cursor : undefined);
            if (!item.isConnected || scope !== JSON.stringify([project.value, this.connection(project.value), board.value, kind.value])) return;
            if (loaded !== scope) item.replaceChildren(); loaded = scope; cursor = page.nextCursor;
            for (const value of page.items) item.add(option(value.id, value.title)); more.hidden = !cursor; add.disabled = !item.options.length;
        });
        const sourceId = randomUUID(), add = button(t('dream.addKanbanSource'), async () => {
            const connectionId = this.connection(project.value), scope = JSON.stringify([project.value, connectionId, board.value, kind.value]);
            if (!connectionId || !item.value || scope !== loaded) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const base = {id: sourceId, projectId: project.value, connectionId, boardId: board.value, scannerSourceId: scanner.value};
            if (kind.value === 'task') {
                const next = [...config.tasks ?? [], {...base, itemId: item.value}];
                await this.command(JSON.stringify([owner, dream, 'tasks', record.revision, next]), id => this.service.configureTaskSources(owner, dream, id, record.revision, next));
            } else {
                const next = [...config.decisions ?? [], {...base, recordId: item.value}];
                await this.command(JSON.stringify([owner, dream, 'decisions', record.revision, next]), id => this.service.configureDecisionSources(owner, dream, id, record.revision, next));
            }
            await this.refreshAfterWrite(() => this.loadDream());
        });
        add.disabled = true; loadBoards.disabled = !project.options.length; this.body.append(project, loadBoards, board, kind, more, item, scanner, add);
    }
    private sourceForm(owner: string, dream: string, config: DreamConfigurationRecord, targets: Target[], models: Array<{id: string; name: string}>) {
        const source = document.createElement('select'), model = document.createElement('select'), target = document.createElement('select');
        const path = document.createElement('input'); path.placeholder = t('dream.path');
        source.setAttribute('aria-label', t('dream.source')); model.setAttribute('aria-label', t('dream.model')); target.setAttribute('aria-label', t('dream.scanner'));
        this.sourceProjects(source, owner);
        for (const item of models) model.add(option(item.id, item.name));
        targets.forEach((item, index) => target.add(option(String(index), item.name)));
        const add = button(t('dream.addSource'), async () => {
            const connection = this.connection(source.value), selected = targets[Number(target.value)];
            if (!connection || !selected || !model.value) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
            const selection = {projectId: source.value, connectionId: connection, path: path.value, executor: {target: selected.target}, maxOutputTokens: 1024, runTokenLimit: 10000};
            await this.service.setModelConnection(owner, dream, model.value);
            await this.command(JSON.stringify([owner, dream, 'add', config.revision, selection, model.value]),
                operation => this.service.addFile(owner, dream, operation, config.revision, selection)); await this.refreshAfterWrite(() => this.loadDream());
        });
        this.body.append(source, path, model, target, add);
        if (!source.options.length) this.body.append(text(t('dream.noSource')));
        if (!model.options.length) this.body.append(text(t('dream.noModel')));
        if (!target.options.length) this.body.append(text(t('dream.noScanner')));
        add.disabled = !source.options.length || !model.options.length || !target.options.length;
    }
    private sourceProjects(select: HTMLSelectElement, owner: string): void {
        for (const project of this.projects) if (this.connection(project.project.id))
            select.add(option(project.project.id, project.displayName ?? project.name));
        if ([...select.options].some(item => item.value === owner)) select.value = owner;
    }
    private connection(projectId: string): string | undefined {
        const mounts = this.projectsPort.remoteMounts?.list(projectId) ?? [];
        const remote = mounts.find(item => item.at === '/' && (!item.protocol || item.protocol === 'cells'))?.connectionId;
        if (remote) return remote;
        const project = this.projects.find(item => item.project.id === projectId);
        return project && project.project.source?.kind !== 'remote' && !mounts.length ? 'dream-local' : undefined;
    }
    private async command(key: string, action: (operationId: string) => Promise<unknown>): Promise<void> {
        const id = this.commandOperations.get(key) ?? randomUUID(); this.commandOperations.set(key, id);
        await action(id); this.commandOperations.delete(key);
    }
    private showRun(run: DreamRunView | null, operationId: string): void {
        this.resultSection?.remove();
        const section = document.createElement('section');
        this.resultSection = section;
        if (!run) section.append(text(t('dream.pending')));
        else {
            for (const source of run.sources) if (source.status !== 'available') {
                section.append(text(`${this.config ? this.sourceLabel(this.config, source.sourceId) : t('dream.unavailableProject')}: ${source.code}`));
            }
            for (const finding of run.findings) {
                const row = document.createElement('div'); row.append(text(finding.content));
                row.append(text(`${t(finding.kind === 'fact' ? 'dream.fact' : finding.kind === 'inference' ? 'dream.inference' : 'dream.suggestion')} · ${t(`dream.memory.${finding.state}`)} · ${t(finding.origin === 'source' ? 'dream.sourceOrigin' : 'dream.correctionOrigin')}`));
                if (this.config) row.append(text(this.sourceLabel(this.config, finding.sourceId)));
                if (finding.quote) row.append(text(finding.quote));
                if (finding.kind !== 'suggestion' && finding.state === 'active') {
                    const chosen = this.mergeSelection;
                    row.append(button(t('dream.selectMerge'), () => {
                        this.mergeSelection = {owner: this.owner, dream: this.dream, id: finding.id, kind: finding.kind, content: finding.content, revision: finding.revision};
                        this.status.textContent = `${t('dream.mergeChosen')}: ${finding.content}`;
                        this.showRun(run, operationId);
                    }));
                    if (chosen?.owner === this.owner && chosen.dream === this.dream && chosen.id !== finding.id && chosen.kind === finding.kind)
                        row.append(button(t('dream.mergeSelected'), async () => {
                            const owner = this.owner, dream = this.dream, ids: [string, string] = [chosen.id, finding.id];
                            const revisions: [number, number] = [chosen.revision, finding.revision];
                            await this.command(JSON.stringify([owner, dream, 'merge', ids, revisions]), id => this.service.mergeFindings(owner, dream, ids, revisions, id));
                            this.mergeSelection = undefined;
                            await this.refreshAfterWrite(async () => {const updated = await this.service.readRun(owner, dream, operationId); if (owner === this.owner && dream === this.dream) this.showRun(updated, operationId);});
                        }));
                }
                if (finding.kind === 'suggestion' && finding.state === 'active') {
                    row.append(button(t('dream.adoptDecision'), () => this.decisionForm(row, run, finding)));
                    if (this.config?.config.files.some(source => source.id === finding.sourceId))
                        row.append(button(t('dream.adopt'), () => this.adoptionForm(row, operationId, finding)));
                    row.append(button(t('dream.adoptionHistory'), () => this.showAdoptions(row, operationId, finding.id)));
                }
                if (finding.revision > 0) row.append(button(t('dream.changes'), async () => {
                    const history = await this.service.findingHistory(this.owner, this.dream, finding.id, finding.revision);
                    if (history && row.isConnected) row.append(text(`${history.previous.content} → ${history.result.content}`));
                }));
                if (finding.kind !== 'suggestion' && finding.state !== 'disabled') {
                    const content = document.createElement('input'); content.value = finding.content; content.setAttribute('aria-label', t('dream.correction'));
                    const kind = document.createElement('select'); kind.setAttribute('aria-label', t('dream.kind'));
                    kind.add(option('fact', t('dream.fact'))); kind.add(option('inference', t('dream.inference'))); kind.value = finding.kind;
                    row.append(content, kind, button(t('dream.saveCorrection'), async () => {
                        await this.review(operationId, finding, {action: 'correct', content: content.value, kind: kind.value as 'fact' | 'inference'});
                    }), button(t(finding.state === 'disputed' ? 'dream.resolveDispute' : 'dream.dispute'), async () => {
                        await this.review(operationId, finding, {action: finding.state === 'disputed' ? 'restore' : 'dispute'});
                    }),
                    button(t('dream.disable'), async () => {await this.review(operationId, finding, {action: 'disable'});}));
                }
                if (finding.kind !== 'suggestion' && finding.state === 'disabled')
                    row.append(button(t('dream.restoreMemory'), async () => {await this.review(operationId, finding, {action: 'restore'});}));
                section.append(row);
            }
            if (run.findings.some(finding => finding.kind !== 'suggestion' && finding.state === 'active'))
                section.append(button(t('dream.useInSession'), async () => this.memoryForm(section, run)));
            if (run.execution) section.append(button(t('dream.openSession'), () => this.openSession(run.execution!.sessionId)));
        }
        this.body.append(section);
    }
    private async showAdoptions(row: HTMLElement, runId: string, suggestionId: string): Promise<void> {
        const owner = this.owner, dream = this.dream, records = await this.service.suggestionAdoptions(owner, dream, runId, suggestionId);
        if (!row.isConnected || owner !== this.owner || dream !== this.dream) return;
        const list = document.createElement('section');
        if (!records.length) list.append(text(t('dream.noAdoptions')));
        for (const record of records) {
            const item = document.createElement('div');
            if (record.kind === 'decision') {
                this.showDecisionAdoption(item, record); list.append(item); continue;
            }
            const {request} = record;
            item.append(text(request.title), text(request.responsibility), text(request.acceptance));
            if (record.state === 'prepared') item.append(button(t('dream.reconcileAdoption'), async () => {
                const receipt = await this.service.adoptSuggestion(request); item.append(text(t('dream.taskCreated')),
                    button(t('dream.openTask'), () => this.openTask(request.boardId, receipt.itemId)));
            }));
            else item.append(button(t('dream.checkTask'), () => this.showAdoptionStatus(item, request)));
            list.append(item);
        }
        row.append(list);
    }
    private showDecisionAdoption(container: HTMLElement, record: Extract<DreamAdoptionRecord, {kind: 'decision'}>): void {
        const {request, recordId} = record;
        container.replaceChildren(text(request.title));
        if (record.state === 'committed' && recordId)
            container.append(button(t('dream.openDecision'), () => this.openDecision(request.boardId, recordId)));
        else container.append(button(t('dream.reconcileAdoption'), async () => {
            const receipt = await this.service.adoptDecision(request);
            this.showDecisionAdoption(container, {...record, state: 'committed', recordId: receipt.recordId});
        }));
    }
    private async showAdoptionStatus(container: HTMLElement, request: DreamAdoptionRequest): Promise<void> {
        const result = await this.service.adoptionStatus(request);
        if (!container.isConnected) return;
        if (result.state === 'pending') {container.append(text(t('dream.adoptionPending'))); return;}
        const phaseKey = `kanban.taskPhase.${result.phase ?? 'unknown'}` as Parameters<typeof t>[0];
        const completion = result.completion === 'accepted' ? t('dream.accepted') : result.completion === 'waived' ? t('kanban.completionOutcome.waived')
            : result.completion === 'mixed' ? t('kanban.completionOutcome.mixed')
            : result.phase === 'completed' ? t('dream.resultUnverified') : t(phaseKey);
        container.append(text(completion), button(t('dream.openTask'), () => this.openTask(request.boardId, result.itemId)));
        const config = this.config;
        if (config && result.completion === 'accepted' && result.execution?.outputs.length
            && !config.config.adoptions?.some(source => source.boardId === request.boardId && source.itemId === result.itemId)) {
            const owner = this.owner, dream = this.dream, source = {id: randomUUID(), boardId: request.boardId, itemId: result.itemId};
            container.append(button(t('dream.addAdoptionSource'), async () => {
                const next = [...config.config.adoptions ?? [], source];
                await this.command(JSON.stringify([owner, dream, 'adoptions', config.revision, next]),
                    id => this.service.configureAdoptionSources(owner, dream, id, config.revision, next));
                await this.refreshAfterWrite(() => this.loadDream());
            }));
        }
    }
    private async memoryForm(parent: HTMLElement, run: DreamRunView): Promise<void> {
        const owner = this.owner, dream = this.dream, page = await this.service.memorySessions(owner);
        if (!parent.isConnected || owner !== this.owner || dream !== this.dream) return;
        const form = document.createElement('div'), sessions = document.createElement('select'), bindingInfo = document.createElement('p');
        sessions.setAttribute('aria-label', t('dream.session'));
        for (const item of page.items) sessions.add(option(item.id, item.title));
        const selectable = run.sources.flatMap(item => item.status === 'available' ? [item.evidence.sourceId] : []);
        const choices = selectable.flatMap(sourceId => {
            if (!this.config || !this.hasSource(sourceId)) return [];
            const label = document.createElement('label'), box = document.createElement('input');
            box.type = 'checkbox'; box.checked = true; label.append(box, this.sourceLabel(this.config, sourceId));
            form.append(label); return [{sourceId, box}];
        });
        if (!choices.length) {parent.append(text(t('dream.memorySourceUnavailable'))); return;}
        let expected: number | null = null, bindingReady = false;
        const appendLabel = document.createElement('label'), append = document.createElement('input'); append.type = 'checkbox';
        appendLabel.append(append, t('dream.appendMemory')); appendLabel.hidden = true;
        append.onchange = () => {bindingInfo.textContent = append.checked ? t('dream.appendMemoryHint') : t('dream.replaceMemory');};
        const remove = button(t('dream.unbindMemory'), async () => {
            if (!bindingReady || !sessions.value || expected === null) throw new Error('DREAM_SESSION_INVALID');
            const signature = JSON.stringify([owner, 'unbind-memory', sessions.value, expected]), id = this.commandOperations.get(signature) ?? randomUUID();
            this.commandOperations.set(signature, id);
            const result = await this.service.unbindSessionMemory(owner, sessions.value, id, expected); this.commandOperations.delete(signature);
            expected = result.revision; bindingInfo.textContent = t('dream.memoryUnbound'); remove.hidden = true;
        });
        remove.disabled = true;
        const loadBinding = async () => {
            bindingReady = false; if (!sessions.value) return;
            const session = sessions.value, value = await this.service.sessionMemoryBinding(owner, session, dream);
            if (sessions.value !== session || !form.isConnected) return;
            expected = value?.revision ?? null; bindingReady = true;
            bindingInfo.textContent = value && !value.disabled ? t('dream.replaceMemory') : '';
            remove.hidden = !value || value.disabled; remove.disabled = !value || value.disabled;
            appendLabel.hidden = !value?.sameDream; append.checked = !!value?.sameDream;
            if (value?.sameDream) bindingInfo.textContent = t('dream.appendMemoryHint');
        };
        sessions.onchange = () => {void this.perform(loadBinding);};
        const submit = button(t('dream.bindMemory'), async () => {
            if (!bindingReady || !sessions.value) throw new Error('DREAM_SESSION_INVALID');
            const sourceIds = choices.filter(item => item.box.checked).map(item => item.sourceId), session = sessions.value;
            const useAppend = !appendLabel.hidden && append.checked;
            const signature = JSON.stringify([owner, dream, 'bind-memory', session, run.operationId, sourceIds, expected, useAppend]);
            await this.command(signature, id => this.service.bindSessionMemory(owner, dream, session, run.operationId, sourceIds, id, expected, useAppend));
            form.replaceChildren(text(t('dream.memoryBound')), text(t('dream.memoryPolicyHint')),
                button(t('dream.openSession'), () => this.openSession(session)));
        });
        form.prepend(sessions, bindingInfo, appendLabel); form.append(text(t('dream.memoryPolicyHint')), submit, remove); parent.append(form);
        if (!page.items.length) form.append(text(t('dream.noSessions'))); else await loadBinding();
        let cursor = page.nextCursor;
        if (cursor) {
            const more = button(t('dream.moreSessions'), async () => {
                if (!cursor) return;
                const next = await this.service.memorySessions(owner, cursor); for (const item of next.items) sessions.add(option(item.id, item.title));
                cursor = next.nextCursor; if (!cursor) more.remove();
            }); form.append(more);
        }
    }
    private async decisionForm(row: HTMLElement, run: DreamRunView, finding: DreamRunView['findings'][number], downstream = false): Promise<void> {
        const owner = this.owner, dream = this.dream, boards = await this.service.adoptionBoards(owner);
        if (!row.isConnected || owner !== this.owner || dream !== this.dream || row.querySelector('[data-dream-decision]')) return;
        const form = document.createElement('div'), board = document.createElement('select'), project = document.createElement('select');
        form.dataset.dreamDecision = '';
        board.setAttribute('aria-label', t('dream.board')); project.setAttribute('aria-label', t('kanban.primaryProject'));
        board.add(option('', t('dream.selectBoard')));
        for (const item of boards) board.add(option(item.id, item.title));
        const title = document.createElement('input');
        title.value = finding.content; title.setAttribute('aria-label', t('dream.decisionTitle'));
        const source = run.sources.find(item => item.status === 'available' && item.evidence.sourceId === finding.sourceId);
        const submit = button(t('dream.createDecisionDraft'), async () => {
            if (!board.value || !project.value) throw new Error('DREAM_TARGET_SCOPE_CHANGED');
            const input = {ownerProjectId: owner, dreamId: dream, runId: run.operationId, suggestionId: finding.id,
                boardId: board.value, targetProjectId: project.value, title: title.value};
            await this.command(JSON.stringify([downstream ? 'adopt-downstream-decision' : 'adopt-decision', input]), async operationId => {
                const {recordId} = downstream ? await this.service.adoptDownstreamDecision({...input, operationId})
                    : await this.service.adoptDecision({...input, operationId});
                form.replaceChildren(text(t('dream.decisionDraftCreated')), button(t('dream.openDecision'), () => this.openDecision(input.boardId, recordId)));
            });
        });
        const refreshProjects = () => this.decisionProjects(project,
            boards.find(item => item.id === board.value)?.projectId, source?.status === 'available' ? source.evidence.projectId : undefined);
        board.onchange = refreshProjects; refreshProjects();
        form.append(board, project, title, submit);
        if (!boards.length) {submit.disabled = true; form.append(text(t('dream.noBoards')));}
        if (!this.projects.some(item => item.project.source?.kind === 'remote')) {submit.disabled = true; form.append(text(t('dream.noDecisionProjects')));}
        row.append(form);
    }
    private decisionProjects(select: HTMLSelectElement, scope?: string, source?: string): void {
        const previous = select.value;
        select.replaceChildren(option('', t('dream.selectDecisionProject')));
        for (const item of this.projects.filter(item => item.project.source?.kind === 'remote' && (!scope || item.project.id === scope)))
            select.add(option(item.project.id, item.displayName ?? item.name));
        select.value = [scope, previous, source].find(id => [...select.options].some(item => id && item.value === id)) ?? '';
    }
    private async adoptionForm(row: HTMLElement, runId: string, finding: DreamRunView['findings'][number]): Promise<void> {
        const owner = this.owner, dream = this.dream, boards = await this.service.adoptionBoards(owner);
        if (!row.isConnected || owner !== this.owner || dream !== this.dream) return;
        const form = document.createElement('div'), board = document.createElement('select'), target = document.createElement('select');
        board.setAttribute('aria-label', t('dream.board')); target.setAttribute('aria-label', t('dream.parent'));
        for (const item of boards) board.add(option(item.id, item.title));
        const title = document.createElement('input'), responsibility = document.createElement('textarea'), acceptance = document.createElement('textarea');
        title.value = finding.content; title.setAttribute('aria-label', t('dream.taskTitle'));
        responsibility.setAttribute('aria-label', t('dream.responsibility')); acceptance.setAttribute('aria-label', t('dream.acceptance'));
        responsibility.placeholder = t('dream.responsibility'); acceptance.placeholder = t('dream.acceptance');
        const submit = button(t('dream.createTask'), async () => {
            if (!board.value || !target.value) throw new Error('DREAM_TARGET_SCOPE_CHANGED');
            const [parentItemId, targetProjectId] = JSON.parse(target.value) as [string, string];
            const input = {ownerProjectId: owner, dreamId: dream, runId, suggestionId: finding.id, boardId: board.value,
                targetProjectId, parentItemId, title: title.value, responsibility: responsibility.value, acceptance: acceptance.value};
            await this.command(JSON.stringify([owner, dream, 'adopt', input]), async operationId => {
                const {itemId} = await this.service.adoptSuggestion({...input, operationId});
                form.replaceChildren(text(t('dream.taskCreated')), button(t('dream.openTask'), () => this.openTask(input.boardId, itemId)));
            });
        });
        form.append(board, target, title, responsibility, acceptance, submit); row.append(form);
        if (!boards.length) form.append(text(t('dream.noBoards')));
        else await this.loadTaskTargets(owner, form, board, target);
    }
    private async loadTaskTargets(owner: string, form: HTMLElement, board: HTMLSelectElement, target: HTMLSelectElement): Promise<void> {
        let moreButton: HTMLButtonElement | undefined;
        const noParents = text(t('dream.noParents')); noParents.hidden = true;
        target.after(noParents);
        const addTargets = async (cursor?: string) => {
            const selectedBoard = board.value, page = await this.service.adoptionTargets(owner, selectedBoard, cursor);
            if (!target.isConnected || selectedBoard !== board.value) return;
            for (const item of page.items) {
                const project = this.projects.find(candidate => candidate.project.id === item.projectId);
                if (project) target.add(option(JSON.stringify([item.itemId, item.projectId]), `${item.title} · ${project.displayName ?? project.name}`));
            }
            if (page.nextCursor) {
                const more = button(t('dream.moreTargets'), async () => {await addTargets(page.nextCursor); more.remove();});
                moreButton = more; form.append(more);
            } else noParents.hidden = !!target.options.length;
        };
        board.onchange = () => {
            target.replaceChildren(); noParents.hidden = true;
            moreButton?.remove(); moreButton = undefined; void this.perform(() => addTargets());
        };
        await addTargets();
    }
    private async review(operationId: string, finding: DreamRunView['findings'][number], change: import('@nestos/app-contracts/services').DreamReview): Promise<void> {
        const owner = this.owner, dream = this.dream;
        await this.command(JSON.stringify([owner, dream, 'review', finding.id, finding.revision, change]),
            id => this.service.reviewFinding(owner, dream, finding.id, id, finding.revision, change));
        await this.refreshAfterWrite(async () => {
            const run = await this.service.readRun(owner, dream, operationId);
            if (owner === this.owner && dream === this.dream) this.showRun(run, operationId);
        });
    }
    private async refreshAfterWrite(refresh: () => Promise<void>): Promise<void> {
        try {await refresh();} catch (error) {if (!this.closed) this.status.textContent = `${t('dream.savedRefreshFailed')} (${safeCode(error)})`;}
    }
    private async perform(operation: () => Promise<void>): Promise<void> {
        try {this.status.textContent = ''; await operation();}
        catch (error) {
            if (!this.closed) this.status.textContent = errorText(error);
        }
    }
}
function option(value: string, label: string): HTMLOptionElement {const node = document.createElement('option'); node.value = value; node.textContent = label; return node;}
function text(value: string): HTMLElement {const node = document.createElement('p'); node.textContent = value; return node;}
function button(label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
    node.onclick = () => {node.disabled = true; const status = node.closest('[data-dream-page]')?.querySelector('[role="alert"]');
        if (status) status.textContent = '';
        void Promise.resolve().then(action).catch(error => {
        if (status) status.textContent = errorText(error);
    }).finally(() => {node.disabled = false;});}; return node;
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown} | null)?.code, message = error instanceof Error ? error.message : '';
    return typeof code === 'string' && /^(DREAM|TWIN)_[A-Z_]+$/.test(code) ? code
        : /^(DREAM|TWIN)_[A-Z_]+$/.test(message) ? message : 'DREAM_OPERATION_FAILED';
}
function errorText(error: unknown): string {
    const code = safeCode(error), key = `dream.errors.${code}` as Parameters<typeof t>[0], message = t(key);
    return `${message === key ? t('dream.failed') : message} (${code})`;
}
function scheduleTime(value: number, zone?: string): string {
    try {return new Intl.DateTimeFormat(undefined, {timeZone: zone, dateStyle: 'medium', timeStyle: 'short'}).format(value);}
    catch {return new Date(value).toLocaleString();}
}
