import type {SessionCapabilityScope} from '../ports/capabilities';
import type {EffectExecutionContext} from '@nestos/durable-kernel';
import type {KernelAdapterDiagnostics} from '../ports/diagnostics';
import {persistMcpSkillUpdates} from './loaded-state';

export const MCP_CONTEXT_WINDOW_KEY='kernel-adapters.skills.mcp-context-window';
export function assertMcpContextWindow(scope:SessionCapabilityScope,value:unknown):void {
    if(value===undefined||value===null)return;
    const marker=value as {format?:unknown;skills?:unknown};
    if(marker.format!==1||!marker.skills||typeof marker.skills!=='object'||Array.isArray(marker.skills))throw new Error('MCP_SKILL_CONTEXT_RESTART_REQUIRED');
    const loaded=new Set(scope.skillService.getLoadedSkills().map(skill=>skill.id));
    for(const [id,digest] of Object.entries(marker.skills))if(typeof digest!=='string'||!loaded.has(id)
        ||scope.skillService.getSkillSnapshot?.(id)?.digest!==digest)throw new Error('MCP_SKILL_CONTEXT_RESTART_REQUIRED');
}

/** A loaded remote Skill must have a live receipt for its exact source and window. */
export async function assertMcpSkillExecution(scope:SessionCapabilityScope,context?:EffectExecutionContext,
    logger?:KernelAdapterDiagnostics['logger'],effectKind?:string):Promise<void> {
    const started=Date.now();
    if(context?.sessionState)await persistMcpSkillUpdates(scope.skillService,context.sessionState);
    if(context?.sessionState)assertMcpContextWindow(scope,(await context.sessionState.get(MCP_CONTEXT_WINDOW_KEY))?.value);
    for(const skill of scope.skillService.getLoadedSkills()) {
        if(!skill.metadata?.mcpOrigin)continue;
        if(!scope.validateMcpSkillWindow||!await scope.validateMcpSkillWindow(skill)) {
            try {logger?.warn('Remote Skill execution window rejected',{operation:'skills.execution.authorize',stage:'window',result:'failure',
                code:'MCP_SKILL_EXECUTION_WINDOW_DENIED',sessionId:context?.sessionId,taskId:context?.taskId,effectId:context?.effectId,durationMs:Date.now()-started});}catch {}
            throw new Error('MCP_SKILL_EXECUTION_WINDOW_DENIED');
        }
        if(effectKind&&(!scope.validateMcpSkillEffect||!await scope.validateMcpSkillEffect(skill,effectKind))) {
            try {logger?.warn('Remote Skill effect authorization rejected',{operation:'skills.execution.authorize',stage:'effect',result:'failure',
                code:'MCP_SKILL_EFFECT_APPROVAL_REQUIRED',sessionId:context?.sessionId,taskId:context?.taskId,effectId:context?.effectId,durationMs:Date.now()-started});}catch {}
            throw new Error('MCP_SKILL_EFFECT_APPROVAL_REQUIRED');
        }
    }
}
