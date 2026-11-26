import type {ConversationUIState, ISessionRepository, SessionUIStateRevision} from '@nestos/llm-session/contracts';
export type ConditionalUIRepository = Pick<ISessionRepository, 'getManifest' | 'compareAndSetUIState'>;
export interface UIStateChange<T> {value: T; patch?: Partial<ConversationUIState>}
type Prepare<T> = (state: ConversationUIState | undefined, authoritative: boolean) => UIStateChange<T>;
interface WriteOptions {
    unavailable(): Error; conflict(): Error;
    report(stage: string, attempt: number, error?: unknown): void;
}
interface KnownState {snapshot?: SessionUIStateRevision}

/** One editor binding serializes its state changes and reuses committed revisions. */
export class SessionUIStateWriter {
    private readonly known: KnownState = {};
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly repository: ConditionalUIRepository, private readonly sessionId: string) {}
    seed(snapshot: {revision?: number; uiState?: ConversationUIState}): void {
        if (validRevision(snapshot.revision)) this.known.snapshot = {revision: snapshot.revision, uiState: structuredClone(snapshot.uiState)};
    }
    write<T>(prepare: Prepare<T>, options: WriteOptions): Promise<T> {
        const pending = this.tail.catch(() => {}).then(() => writeUIStateConditionally(this.repository, this.sessionId, prepare, options, this.known));
        this.tail = pending;
        return pending;
    }
}

/** Retry only rejected version conditions; unknown writes require a read-only proof of the proposal. */
export async function writeUIStateConditionally<T>(repository: ConditionalUIRepository, sessionId: string,
    prepare: Prepare<T>, options: WriteOptions, known?: KnownState): Promise<T> {
    let stage = 'read', attempt = 0;
    const report = (error?: unknown) => {try {options.report(stage, attempt, error);} catch { /* Diagnostics cannot alter storage facts. */ }};
    try {
        if (!repository.compareAndSetUIState) throw options.unavailable();
        for (; attempt < 8; attempt++) {
            const cached = known?.snapshot;
            if (known) known.snapshot = undefined;
            stage = 'read'; const snapshot = cached ?? await repository.getManifest(sessionId), revision = snapshot.revision;
            if (!validRevision(revision)) throw options.unavailable();
            stage = 'prepare';
            const change = prepareProposal(prepare, snapshot.uiState, !!cached);
            if (!change || cached && !change.patch) continue;
            if (!change.patch) {
                if (known) known.snapshot = {revision, uiState: snapshot.uiState};
                stage = 'confirmed'; report(); return change.value;
            }
            stage = cached ? 'cached-conditional-write' : 'conditional-write';
            try {
                const committed = known ? await repository.compareAndSetUIState(sessionId, revision, change.patch, true)
                    : await repository.compareAndSetUIState(sessionId, revision, change.patch);
                if (known && committed && validRevision(committed.revision)) known.snapshot = committed;
            }
            catch (error) {
                if ((error as {code?: unknown})?.code === 'SESSION_UI_STATE_CONFLICT') continue;
                stage = 'write-receipt'; const confirmed = await confirmWrite(repository, sessionId, prepare);
                if (confirmed) {report(); return confirmed.value;}
                throw error;
            }
            report(); return change.value;
        }
        throw options.conflict();
    } catch (error) {report(error); throw error;}
}
function validRevision(revision: number | undefined): revision is number {
    return revision !== undefined && Number.isSafeInteger(revision) && revision >= 0;
}
function prepareProposal<T>(prepare: Prepare<T>, state: ConversationUIState | undefined, cached: boolean): UIStateChange<T> | undefined {
    try {return prepare(state, !cached);}
    catch (error) {if (!cached) throw error;}
}
async function confirmWrite<T>(repository: ConditionalUIRepository, sessionId: string,
    prepare: Prepare<T>): Promise<UIStateChange<T> | undefined> {
    try {const change = prepare((await repository.getManifest(sessionId)).uiState, true); return change.patch ? undefined : change;}
    catch {return;}
}
