import type {ConversationRequest} from './contracts';

import type {InputField, InteractionResponse, InteractionView} from '@nestos/llm-ui';
import {t} from '@nestos/common';

export function nativeInteraction(request: ConversationRequest, revision = 0): InteractionView {
    const base = {id: `${typeof request.id}:${request.id}`, revision, state: 'pending' as const, responding: request.responding,
        title: request.title ?? t(request.kind === 'approval' ? 'harness.approval' : 'harness.interaction'), detail: request.detail};
    if(request.kind==='unsupported')return {...base,...(request.approval?approvalPresentation(request):{}),kind:'unsupported'};
    if(request.kind==='approval')return {...base,...approvalPresentation(request),kind:'approval',
        decisions:(request.decisions??[]).map(id=>({id,label:decisionLabel(id)}))};
    return {...base, kind: 'input', fields: (request.questions ?? []).map(questionField)};
}
function approvalPresentation(request:ConversationRequest):Pick<InteractionView,'title'|'detail'|'facts'|'details'> {
    const context=request.approval;
    const title=request.title??t(context?.kind==='command'?'harness.commandApproval':context?.kind==='file-change'?'harness.fileApproval':'harness.approval');
    const detail=context?.reason?.trim()?context.reason:t('harness.approvalReasonMissing');
    const facts=([['harness.approvalPath',context?.path],['harness.approvalCwd',context?.cwd],['harness.approvalTool',context?.toolName]] as const)
        .flatMap(([key,value])=>value?[{label:t(key),value}]:[]);
    const command=context?context.command:request.detail;
    const details=[...(command?[{label:t(context?'harness.approvalCommand':'harness.approvalDetails'),text:command}]:[]),
        ...(request.unsupportedDecisionCount?[{label:t('harness.approvalOptions'),text:t('harness.partialApproval')}]:[])];
    return {title,detail,facts,details};
}
function questionField(q: NonNullable<ConversationRequest['questions']>[number]): InputField {
    const base = {id: q.id, label: q.question, required: true};
    if (q.isSecret || !q.options?.length) return {...base, kind: 'text', secret: !!q.isSecret};
    const choices = q.options.map(option => ({id: option.label, label: option.label, description: option.description}));
    const other = q.isOther ? t('harness.otherAnswer') : undefined;
    return q.multiSelect ? {...base, kind: 'multi-choice', choices, min: 1, other} : {...base, kind: 'single-choice', choices, other};
}
export function nativeResponse(response: InteractionResponse): Record<string, unknown> {
    return response.kind === 'approval' ? {decision: response.decisionId}
        : {answers: Object.fromEntries(Object.entries(response.values).map(([id, value]) => [id, {answers: Array.isArray(value) ? value : [value]}]))};
}
function decisionLabel(id: string): string {
    if (['accept', 'allow', 'approve'].includes(id)) return t('harness.approve');
    if (id === 'acceptForSession') return t('harness.approveForSession');
    return t(id === 'cancel' ? 'harness.cancelInteraction' : 'harness.decline');
}
