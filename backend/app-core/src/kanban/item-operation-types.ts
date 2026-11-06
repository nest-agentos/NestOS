import type {IndependentCallInput, SubmissionRequest} from '@nestos/llm-session/contracts';
import type {KanbanExternalReference, KanbanItem, KanbanBoard, KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {publishedOperation, OperationObservation} from '../run/published-operation';
import type {sessionSubmission} from '../run/session-submission';
export type ReviewAction = 'build' | 'deploy' | 'accept' | 'analyze' | 'merge';
export interface ReviewSnapshot {version: string; sourceVersion: string; targetVersion: string; context: unknown}
export interface MergePlan {
    sourceVersion: string; targetVersion: string; summary: string;
    conflicts: Array<{id: string; path: string; reason: string; options: Array<{id: string; label: string; detail?: string}>}>;
}
export interface ReviewJob {
    id: string; boardId: string; itemId: string; action: ReviewAction; fingerprint: string; snapshot: ReviewSnapshot;
    phase: 'prepared' | 'submitting' | 'settled'; state: OperationObservation['state']; code?: string; sessionId?: string;
    managed?:import('../runtime/service-control').ServiceSwitchRequest;
    operationContext?: unknown; input?: IndependentCallInput; request?: SubmissionRequest; result?: unknown; createdAt: number;
    followUp?:{action:'deploy';state:'queued'|'started'|'failed';code?:string;request?:import('@nestos/kanban/contracts').KanbanItemOperationRequest};
    command?: import('@nestos/kanban/contracts').KanbanCommand; acceptanceVersion?: string;
}
export interface ReviewSettings {revision: number; bindings: Partial<Record<ReviewAction, KanbanExternalReference>>; jobs: string[]; receipts: Record<string, string>}
export interface ReviewAdapter {
    managed?:{describe?(item:KanbanItem):Promise<import('../runtime/service-control').RuntimeServiceDescriptor|undefined>;prepare(input:{id:string;board:KanbanBoard;item:KanbanItem;snapshot:ReviewSnapshot;context:unknown}):Promise<import('../runtime/service-control').ServiceSwitchRequest|undefined>;
        submit(request:import('../runtime/service-control').ServiceSwitchRequest):Promise<void>;
        inspect(job:ReviewJob):Promise<import('../run/published-operation').OperationObservation>};
    supports?(board: KanbanBoard, item: KanbanItem): boolean;
    runningVersion?(): string | undefined;
    snapshot(board: KanbanBoard, item: KanbanItem): Promise<ReviewSnapshot>;
    prepareOperation?(input: {id: string; action: Exclude<ReviewAction, 'accept'>; context?: unknown; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot}): Promise<SubmissionRequest>;
    readOperation?(job: ReviewJob): Promise<unknown | undefined>;
    prepareAnalysis(input: {id: string; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot}): Promise<SubmissionRequest>;
    exchange?(job: ReviewJob, observation: import('../run/session-submission').SessionSubmissionObservation): Promise<import('../run/session-submission').SessionSubmissionObservation>;
    close?(): Promise<void>;
    readAnalysis(job: ReviewJob): Promise<unknown | undefined>;
}
export interface ReviewOperationsOptions {
    automaticTarget?(board:KanbanBoard,item:KanbanItem):string|undefined;
    automatic?(board:KanbanBoard,item:KanbanItem):Promise<boolean>;
    cleanup?(board:string,item:string,id:string):Promise<boolean>;
    reportAutomatic?(state:{id:string;boardId:string;itemId:string;step:number;code?:string;done?:boolean}):Promise<void>;
    report?(job: ReviewJob): Promise<void>;
    sessionResource?(sessionId: string): Promise<string | undefined>;
    service: KanbanService; journal: KanbanAutomationJournal;
    catalog(): Promise<import('@nestos/llm-session/contracts').RootTargetCatalog>;
    published: ReturnType<typeof publishedOperation>; submission: ReturnType<typeof sessionSubmission>; adapter: ReviewAdapter;
    log(event: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
export const reviewKey = (board: string, item: string) => 'review-operations:' + JSON.stringify([board, item]);
export const jobKey = (id: string) => 'review-operation:' + id;
