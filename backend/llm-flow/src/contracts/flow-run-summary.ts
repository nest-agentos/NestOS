import type {InvocationIdentity} from './flow';

export interface FlowRunPreview { text: string; truncated: boolean }

export interface FlowRunSummary {
    taskId: string;
    sessionId: string;
    name: string;
    status: string;
    createdAt: number;
    inputPreview?: FlowRunPreview;
    outputPreview?: FlowRunPreview;
    failure?: {code?: string; message: string};
    invocation?: InvocationIdentity;
}
