import type { ChatAttachment } from './chat';
import type { ExecutionOverrides, HistoryPolicy, SessionOrigin } from '../core/types';
import type { SendIntent } from '@nestos/llm-flow/contracts';

/** A durable user request; execution history is resolved only when it is dispatched. */
export interface SessionInstructionInput {
    branchFrom?: import('./submission').SubmissionRequest['branchFrom'];
    expectedBranch?: string;
    target?: import('@nestos/llm-flow/contracts').TargetSelection;
    expectedTarget?: import('@nestos/llm-flow/contracts').TargetRef;
    source?: import('@nestos/llm-flow/contracts').FlowCallSource;
    text: string;
    files: ChatAttachment[];
    agentId: string;
    overrides?: ExecutionOverrides;
    origin?: SessionOrigin;
    historyPolicy?: HistoryPolicy;
    sendIntent?: SendIntent;
}

export interface SessionInstruction extends SessionInstructionInput {
    /** Assigned and persisted in the dispatch claim, before any execution starts. */
    invocation?: import('@nestos/llm-flow/contracts').InvocationIdentity;
    /** Digest of the original request, before host-derived bindings or attachment paths. */
    submissionDigest?: string;
    connectionBinding?: {
        /** New target metadata must not change old admitted task submission fingerprints. */
        identityVersion?: 1;
        /** Frozen ordinary Agent identity; connection credentials remain in the live catalog. */
        agent?: {version: 1; config: import('../core/types').ExecutorConfig; digest: string};
        /** Frozen remote Agent identity and execution target; credentials remain host-owned. */
        harnessConnection?: import('@nestos/kernel-adapters/contracts').HarnessConnectionSnapshot;
        harnessAgent?: import('../core/types').ExecutorConfig;
        connectionId?: string;
        source?: 'run' | 'session' | 'agent' | 'system';
        defaults: import('@nestos/kernel-adapters/contracts').ModelDefaults;
        /** Safe connection/model choices captured before queue acceptance. */
        connections?: import('./flow-connection-snapshot').FlowConnectionSnapshot;
    };
    /** Host-resolved source definitions; accepted instructions do not follow later edits. */
    flowBinding?: {
        source?: 'explicit' | 'target';
        target?: import('@nestos/llm-flow/contracts').TargetRef;
        inputResolution?: import('@nestos/llm-flow/contracts').FlowResolvedInput;
        definition: import('@nestos/llm-flow/contracts').FlowRevision;
        dependencies: import('@nestos/llm-flow/contracts').FlowRevision[];
        agent?: import('../core/types').ExecutorConfig;
        connections: import('./flow-connection-snapshot').FlowConnectionSnapshot;
        /** Absent only for legacy accepted instructions. */
        plan?: import('./flow-run-plan').FlowRunPlan;
    };
    id: string;
    branch: string;
    createdAt: number;
    state: 'pending' | 'dispatching' | 'failed' | 'uncertain';
    error?: string;
    /** Read-only execution evidence; observation never admits another request. */
    observation?: {lastProgressAt: number; code?: string; stopping?: boolean};
}

export interface SessionInstructionQueue {
    sessionId: string;
    revision: number;
    paused: boolean;
    reason?: 'failed' | 'aborted' | 'branch-changed' | 'recovery';
    items: SessionInstruction[];
    /** Durable fences prevent late admission of explicitly cancelled submission IDs. */
    cancelledIds?: string[];
}

/** Every edit is conditional on the projection the caller actually saw. */
export type InstructionQueueEdit = { expectedRevision: number } & (
    | { action: 'check' | 'stop'; id: string }
    | { action: 'cancel'; id: string }
    | { action: 'update'; id: string; text: string }
    | { action: 'update-input'; id: string; source: import('@nestos/llm-flow/contracts').FlowCallSource }
    | { action: 'remove'; id: string }
    | { action: 'reorder'; ids: string[] }
    | { action: 'merge'; ids: string[] }
    | { action: 'pause' }
    | { action: 'resume' }
    | { action: 'retry'; id: string }
);
