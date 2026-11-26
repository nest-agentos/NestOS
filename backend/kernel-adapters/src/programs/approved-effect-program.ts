import { interactionApproved } from '@nestos/durable-kernel';
import type {
    Decision,
    DurableTaskProgram,
    EffectRequest,
    JsonValue,
    SerializableError,
    TaskInputEvent,
} from '@nestos/durable-kernel';

export interface ApprovedEffectInput {
    effect: EffectRequest & { id: string };
    prompt: string;
    title?: string;
    details?: JsonValue;
}

interface ApprovedEffectState {
    effect: EffectRequest & { id: string };
    phase: 'approval' | 'effect';
}

export class ApprovedEffectProgram implements DurableTaskProgram<ApprovedEffectState, ApprovedEffectInput, unknown> {
    readonly manifest = { kind: 'kernel-adapters.approved-effect', version: '1' };

    init(input: ApprovedEffectInput): Decision<ApprovedEffectState, unknown> {
        validateInput(input);
        return {
            state: { effect: input.effect, phase: 'approval' },
            actions: [{
                type: 'request-interaction',
                interaction: {
                    id: approvalId(input.effect.id),
                    kind: 'approval',
                    prompt: input.prompt,
                    payload: interactionPayload(input),
                },
            }],
            next: { type: 'wait', on: { type: 'interaction', id: approvalId(input.effect.id) } },
        };
    }

    reduce(
        state: Readonly<ApprovedEffectState>,
        event: TaskInputEvent,
    ): Decision<ApprovedEffectState, unknown> {
        if (state.phase === 'approval') return handleApproval(state, event);
        if (event.type === 'effect-completed') {
            return { state: { ...state }, next: { type: 'complete', output: event.result } };
        }
        if (event.type === 'effect-failed') {
            return { state: { ...state }, next: { type: 'fail', error: event.error } };
        }
        return unexpected(state, event);
    }
}

export interface McpSkillApprovalBinding {
    sessionId:string;serverId:string;uri:string;manifestDigest:string;windowId:string;scopeId?:string;
    projectId?:string;projectRevision?:number;mountId?:string;principalId?:string;authorizationRevision?:string;
}

/** The durable interaction itself is the authority; a failed task carries no approval. */
export class McpSkillApprovalProgram implements DurableTaskProgram<McpSkillApprovalBinding,McpSkillApprovalBinding,McpSkillApprovalBinding> {
    readonly manifest={kind:'kernel-adapters.mcp-skill-approval',version:'1'};
    init(input:McpSkillApprovalBinding):Decision<McpSkillApprovalBinding,McpSkillApprovalBinding> {
        validateMcpSkillApproval(input);
        const binding={...input};
        return {state:binding,actions:[{type:'request-interaction',interaction:{id:'approve:mcp-skill',kind:'approval',
            prompt:'Allow this remote Skill in this session?',payload:{...binding}}}],next:{type:'wait',on:{type:'interaction',id:'approve:mcp-skill'}}};
    }
    reduce(state:Readonly<McpSkillApprovalBinding>,event:TaskInputEvent):Decision<McpSkillApprovalBinding,McpSkillApprovalBinding> {
        if(event.type!=='interaction-resolved'||event.interactionId!=='approve:mcp-skill')return {state:{...state},next:{type:'fail',error:{code:'MCP_SKILL_APPROVAL_EVENT_INVALID',message:'Unexpected approval event'}}};
        if(!interactionApproved(event.value))return {state:{...state},next:{type:'fail',error:{code:'MCP_SKILL_APPROVAL_DENIED',message:'Remote Skill approval denied'}}};
        return {state:{...state},next:{type:'complete',output:{...state}}};
    }
}

export function validateMcpSkillApproval(value:McpSkillApprovalBinding):void {
    const source=[value?.projectId,value?.projectRevision,value?.mountId,value?.principalId,value?.authorizationRevision];
    const sourcePresent=source.some(part=>part!==undefined);
    if(!value||[value.sessionId,value.serverId,value.uri,value.windowId].some(part=>typeof part!=='string'||!part.trim()||part.length>4096)
        ||(value.scopeId!==undefined&&(typeof value.scopeId!=='string'||!value.scopeId.trim()||value.scopeId.length>128))
        ||(sourcePresent&&(!value.scopeId||[value.projectId,value.mountId,value.principalId,value.authorizationRevision].some(part=>typeof part!=='string'||!part.trim()||part.length>4096)
            ||!Number.isSafeInteger(value.projectRevision)||value.projectRevision! < 1))
        ||!/^sha256:[a-f0-9]{64}$/.test(value.manifestDigest))throw new Error('MCP_SKILL_APPROVAL_INVALID');
}

function handleApproval(
    state: Readonly<ApprovedEffectState>,
    event: TaskInputEvent,
): Decision<ApprovedEffectState, unknown> {
    if (event.type !== 'interaction-resolved') return unexpected(state, event);
    if (!interactionApproved(event.value)) {
        return {
            state: { ...state },
            next: { type: 'fail', error: { message: 'Effect approval was denied', code: 'APPROVAL_DENIED' } },
        };
    }
    return {
        state: { effect: state.effect, phase: 'effect' },
        actions: [{ type: 'effect', effect: state.effect }],
        next: { type: 'wait', on: { type: 'effect', id: state.effect.id } },
    };
}

function validateInput(input: ApprovedEffectInput): void {
    if (!input.prompt.trim()) throw new Error('Approval prompt is required');
    if (!input.effect.id) throw new Error('Approved Effect requires a stable effect id');
}

function approvalId(effectId: string): string { return `approve:${effectId}`; }

function interactionPayload(input: ApprovedEffectInput): JsonValue {
    const payload: Record<string, JsonValue> = {};
    if (input.title !== undefined) payload.title = input.title;
    if (input.details !== undefined) payload.details = input.details;
    return payload;
}

function unexpected(
    state: Readonly<ApprovedEffectState>,
    event: TaskInputEvent,
): Decision<ApprovedEffectState, unknown> {
    const error: SerializableError = { message: `Unexpected event while waiting for ${state.phase}: ${event.type}` };
    return { state: { ...state }, next: { type: 'fail', error } };
}
