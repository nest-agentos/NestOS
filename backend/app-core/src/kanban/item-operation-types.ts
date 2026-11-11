import type {IndependentCallInput, SubmissionRequest} from '@nestos/llm-session/contracts';
import type {KanbanExternalReference, KanbanItem, KanbanBoard, KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {createPublishedOperation as publishedOperation, OperationObservation} from '@nestos/llm-session';
import type {createSessionSubmission as sessionSubmission} from '@nestos/llm-session';
export type ReviewAction = 'build' | 'deploy' | 'accept' | 'analyze' | 'merge';
export interface ReviewSnapshot {version: string; sourceVersion: string; targetVersion: string; context: unknown}
export type {MergePlan} from '@nestos/git-delivery/contracts';
export interface ReviewJob {
    scopeId?:string;
    id: string; boardId: string; itemId: string; action: ReviewAction; fingerprint: string; snapshot: ReviewSnapshot;
    phase: 'prepared' | 'submitting' | 'settled'; state: OperationObservation['state']; code?: string; sessionId?: string;
    managed?:import('../runtime/service-control').ServiceSwitchRequest;
    operationContext?: unknown; input?: IndependentCallInput; request?: SubmissionRequest; result?: unknown; createdAt: number;
    followUp?:{action:'deploy';state:'queued'|'started'|'failed';code?:string;request?:import('@nestos/kanban/contracts').KanbanItemOperationRequest};
    command?: import('@nestos/kanban/contracts').KanbanCommand; acceptanceVersion?: string; acceptanceScope?: 'source'|'runtime'; acceptanceEvidence?: unknown;
    commands?:import('@nestos/kanban/contracts').KanbanCommand[];
}
export interface ReviewSettings {invalidatedAnalysis?:{id:string;code:string};revision: number; bindings: Partial<Record<ReviewAction, KanbanExternalReference>>; jobs: string[]; receipts: Record<string, string>}
export interface ReviewAdapter {
    relatedSession?(board:KanbanBoard,item:KanbanItem):Promise<string|undefined>;
    ready?(board:KanbanBoard,item:KanbanItem):boolean;
    acceptanceCommands?(board:KanbanBoard,item:KanbanItem):Promise<import('@nestos/kanban/contracts').KanbanCommand[]>;
    cancel?(job:ReviewJob,operationId:string):Promise<'accepted'|'cancelled'|'unknown'>;
    managed?:{describe?(item:KanbanItem):Promise<import('../runtime/service-control').RuntimeServiceDescriptor|undefined>;prepare(input:{id:string;board:KanbanBoard;item:KanbanItem;snapshot:ReviewSnapshot;context:unknown}):Promise<import('../runtime/service-control').ServiceSwitchRequest|undefined>;
        submit(request:import('../runtime/service-control').ServiceSwitchRequest):Promise<void>;
        inspect(job:ReviewJob):Promise<import('@nestos/llm-session').OperationObservation>};
    supports?(board: KanbanBoard, item: KanbanItem): boolean;
    runningVersion?(): string | undefined;
    snapshot(board: KanbanBoard, item: KanbanItem): Promise<ReviewSnapshot>;
    acceptanceVersion?(board:KanbanBoard,item:KanbanItem,expectedVersion:string):Promise<{version:string;receipt:unknown}|undefined>;
    prepareOperation?(input: {id: string; action: Exclude<ReviewAction, 'accept'>; context?: unknown; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot}): Promise<SubmissionRequest>;
    readOperation?(job: ReviewJob): Promise<unknown | undefined>;
    prepareAnalysis(input: {id: string; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot}): Promise<SubmissionRequest>;
    exchange?(job: ReviewJob, observation: import('@nestos/llm-session').SessionSubmissionObservation, beforeResume?:()=>Promise<void>): Promise<import('@nestos/llm-session').SessionSubmissionObservation>;
    close?(): Promise<void>;
    readAnalysis(job: ReviewJob): Promise<unknown | undefined>;
}
export interface DeliveryPlan {ordering?:'configured';manualAfter?:string;steps:string[];acceptance:'source'|'runtime';acceptanceLabel?:string;acceptanceConfirmation?:string}
export interface ReviewOperationsOptions {
    scopeId?:string;
    scopes?:OperationScopeProvider;
    cancelOperation?(job:ReviewJob,operationId:string):Promise<'accepted'|'cancelled'|'unknown'>;
    deliveryPlan?(board:KanbanBoard,item:KanbanItem):Promise<DeliveryPlan>;
    automaticTarget?(board:KanbanBoard,item:KanbanItem):string|undefined;
    automatic?(board:KanbanBoard,item:KanbanItem):Promise<boolean>;
    cleanup?(board:string,item:string,id:string):Promise<boolean>;
    reportAutomatic?(state:{id:string;boardId:string;itemId:string;step:number;waitingForUser?:boolean;code?:string;done?:boolean;handoff?:{boardId:string;itemId:string;at:number}}):Promise<void>;
    report?(job: ReviewJob): Promise<void>;
    sessionResource?(sessionId: string): Promise<string | undefined>;
    service: KanbanService; journal: KanbanAutomationJournal;
    catalog(): Promise<import('@nestos/llm-session/contracts').RootTargetCatalog>;
    published: ReturnType<typeof publishedOperation>; submission: ReturnType<typeof sessionSubmission>; adapter: ReviewAdapter;
    log(event: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
export interface ReviewOperationScope {completed?:boolean;id:string;label:string;contributors:Array<{itemId:string;title:string}>}
export interface OperationScopeProvider {
    describe(board:string,item:string):Promise<{owner?:{boardId:string;itemId:string};permittedActions?:string[];scopes?:ReviewOperationScope[]}|undefined>;
    resolve(board:string,item:string,scopeId:string):Promise<Partial<ReviewOperationsOptions>>;
    handoff?(board:KanbanBoard,item:KanbanItem):Promise<{boardId:string;itemId:string}|undefined>;
    dependencyReady?(board:string,item:KanbanItem):Promise<boolean|undefined>;
    close?():Promise<void>;
}
export const reviewKey = (board: string, item: string,scopeId?:string) => 'review-operations:' + JSON.stringify(scopeId?[board,item,scopeId]:[board,item]);
export const jobKey = (id: string) => 'review-operation:' + id;
