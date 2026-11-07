import {randomUUID} from '@nestos/common';
import type {AssistantEvent, LocalApplicationServices} from '@nestos/app-contracts/services';
import {sessionEvent} from './overview';
type Services = Pick<LocalApplicationServices, 'kernel' | 'sessionRepository'>;
type Summary = Awaited<ReturnType<NonNullable<Services['sessionRepository']['listSummaries']>>>[number];
const projections = new WeakMap<object, {kernel: object; projection: SessionProjection}>();

/** Runtime-owned derived state: subscribe before seeding, update only identities signalled by the authorities. */
class SessionProjection {
    private readonly events = new Map<string, AssistantEvent>();
    private readonly summaries = new Map<string, Summary>();
    private pending = Promise.resolve();
    private closed = false;
    private metadataDirty = false;
    private releases: Array<() => void> = [];
    constructor(private readonly services: Services) {}
    async start(): Promise<void> {
        const {kernel, sessionRepository: repository} = this.services;
        let seed!: () => void;
        this.pending = new Promise<void>(resolve => {seed = resolve;});
        this.releases.push(kernel.kernel.onChanged(event => {
            if (!this.closed && event.reason !== 'content') this.enqueue(() => this.update(event.sessionId));
        }), repository.subscribe?.(change => {
            if (this.closed || change?.kind === 'ui-state') return;
            if (change?.sessionId) this.enqueue(() => this.metadata(change.sessionId)); else this.metadataDirty = true;
        }) ?? (() => {}));
        try {await this.seed();} finally {seed();}
        await this.pending;
    }
    async read(): Promise<AssistantEvent[]> {
        await this.pending;
        if (this.metadataDirty) {this.metadataDirty = false; this.enqueue(() => this.metadata()); await this.pending;}
        for (const work of this.failed) {await work(); this.failed.delete(work);}
        const rows = [...this.events.values()].sort((a, b) => a.priority - b.priority || b.at - a.at);
        return rows.filter(row => row.requiresAction).concat(rows.filter(row => !row.requiresAction).slice(0, 100));
    }
    async dispose(): Promise<void> {this.closed = true; this.releases.splice(0).reverse().forEach(stop => stop()); await this.pending;}
    private async seed(): Promise<void> {
        const repository = this.services.sessionRepository;
        const rows = await (repository.listSummaries?.() ?? repository.list());
        for (const row of rows) this.summaries.set(row.id, row);
        for (let offset = 0; offset < rows.length; offset += 8) await Promise.all(rows.slice(offset, offset + 8).map(row => this.update(row.id)));
    }
    private enqueue(work: () => Promise<void>): void {
        const operationId = randomUUID(), started = Date.now();
        this.pending = this.pending.then(work).catch(error => {
            console.warn('[AssistantOverview]', {operation: 'assistant.sessions.project', operationId, stage: 'update', result: 'failure', code: projectionCode(error), durationMs: Date.now() - started});
            // A failed projection cannot be published as a current success.
            this.failed.add(work);
        });
    }
    private readonly failed = new Set<() => Promise<void>>();
    private async metadata(id?: string): Promise<void> {
        const repository = this.services.sessionRepository;
        if (!id) {this.summaries.clear(); this.events.clear(); await this.seed(); return;}
        try {this.summaries.set(id, await repository.getManifest(id));}
        catch (error) {if (missing(error)) {this.summaries.delete(id); this.events.delete(id); return;} throw error;}
        await this.update(id);
    }
    private async update(id: string): Promise<void> {
        const summary = this.summaries.get(id);
        if (!summary) return;
        try {
            const activity = await this.services.kernel.kernel.sessionActivity!(id);
            const event = sessionEvent(id, summary.title, summary.updatedAt, activity);
            if (event) this.events.set(id, event); else this.events.delete(id);
        } catch (error) {if (missing(error)) this.events.delete(id); else throw error;}
    }
}
function missing(error: unknown): boolean {return ['ENOENT', 'SESSION_NOT_FOUND'].includes(String((error as {code?: string})?.code));}
export async function startAssistantSessions(services: Services): Promise<() => Promise<void>> {
    const projection = new SessionProjection(services), operationId = randomUUID(), started = Date.now();
    await projection.start().catch(async error => {
        await projection.dispose();
        console.warn('[AssistantOverview]', {operation: 'assistant.sessions.seed', operationId, stage: 'initialize', result: 'failure', code: projectionCode(error), durationMs: Date.now() - started});
        throw error;
    });
    console.info('[AssistantOverview]', {operation: 'assistant.sessions.seed', operationId, stage: 'initialize', result: 'success', durationMs: Date.now() - started});
    projections.set(services.sessionRepository, {kernel: services.kernel.kernel, projection});
    return async () => {projections.delete(services.sessionRepository); await projection.dispose();};
}
export async function projectedSessionEvents(services: Services): Promise<AssistantEvent[] | undefined> {
    const entry = projections.get(services.sessionRepository);
    if (!entry || entry.kernel !== services.kernel.kernel) return;
    return entry.projection.read();
}

function projectionCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'ASSISTANT_SESSION_PROJECTION_FAILED';
}
