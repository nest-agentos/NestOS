import type {IndependentCallInput, SubmissionRequest} from '@nestos/llm-session/contracts';
import type {KanbanExternalReference, KanbanItem, KanbanBoard, KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal,KanbanOperationRecord} from '@nestos/kanban/integration';
import type {createPublishedOperation as publishedOperation} from '@nestos/llm-session';
import type {createSessionSubmission as sessionSubmission} from '@nestos/llm-session';
export type ReviewAction = 'build' | 'deploy' | 'accept' | 'analyze' | 'merge';
export interface ReviewSnapshot {version: string; sourceVersion: string; targetVersion: string; context: unknown}
export type {MergePlan} from '@nestos/git-delivery/contracts';
export interface ReviewJob extends KanbanOperationRecord {
    scopeId?:string;
    action:ReviewAction;snapshot:ReviewSnapshot;
    managed?:import('@nestos/app-contracts/services').ServiceSwitchRequest;
    operationContext?: unknown; input?: IndependentCallInput; request?: SubmissionRequest;
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
    managed?:{describe?(item:KanbanItem):Promise<import('@nestos/app-contracts/services').RuntimeServiceDescriptor|undefined>;prepare(input:{id:string;board:KanbanBoard;item:KanbanItem;snapshot:ReviewSnapshot;context:unknown}):Promise<import('@nestos/app-contracts/services').ServiceSwitchRequest|undefined>;
        submit(request:import('@nestos/app-contracts/services').ServiceSwitchRequest):Promise<void>;
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
export interface DeliveryPlan {ordering?:'configured';manualAfter?:string;steps:string[];acceptance:'source'|'runtime';acceptanceLabel?:string;acceptanceConfirmation?:string|null}
export interface ReviewOperationsOptions {
    uncancellableActions?:string[];
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
    log(event: {operationId: string; boardId?:string;itemId?:string;count?:number;stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
export interface ReviewOperationScope {ready?:boolean;completed?:boolean;id:string;label:string;contributors:Array<{itemId:string;title:string}>}
export type ResolvedOperationScope=Partial<Pick<ReviewOperationsOptions,'adapter'|'deliveryPlan'|'automaticTarget'|'cleanup'>>;
export interface OperationScopeProvider {
    describe(board:string,item:string):Promise<{owner?:{boardId:string;itemId:string};permittedActions?:string[];scopes?:ReviewOperationScope[]}|undefined>;
    resolve(board:string,item:string,scopeId:string):Promise<ResolvedOperationScope>;
    handoff?(board:KanbanBoard,item:KanbanItem):Promise<{boardId:string;itemId:string}|undefined>;
    dependencyReady?(board:string,item:KanbanItem):Promise<boolean|undefined>;
    close?():Promise<void>;
}


export interface ReviewContext {scoped:boolean;cleanup?:import('@nestos/kanban/integration').ReviewCleanup;deliveryPlan?:DeliveryPlan;board: KanbanBoard; item: KanbanItem; archived: boolean; settings: ReviewSettings; jobs: ReviewJob[]; cancellations:import('@nestos/kanban/integration').ReviewCancellation[]}
