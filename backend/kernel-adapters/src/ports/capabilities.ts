import type { ISkillService, SkillDefinition, SkillLoadResult, SkillScopeLevel, SkillToolBinding } from '@nestos/tools/contracts';
import type { ToolHandler } from '@nestos/tools/contracts';
import type { EffectExecutionContext } from '@nestos/durable-kernel';

export type CapabilityResolver<T> = (
    context: EffectExecutionContext,
) => T | Promise<T>;

export type CapabilitySource<T> = T | CapabilityResolver<T>;

export interface SkillScopeSnapshot {
    cwd: string;
    agentInstructions: string;
    skills: SkillDefinition[];
}

export interface SkillSource {
    loadScope(cwd: string): Promise<SkillScopeSnapshot>;
    dispose?():void|Promise<void>;
    readApproved?(sessionId:string,skillId:string,taskId:string,windowId:string,
        controls:Pick<import('@nestos/tools/contracts').SessionSkillControls,'verifyMcpApproval'>):Promise<string>;
    readSupporting?(skillId:string,entry:import('../skill/mcp-skill-verification').McpSkillEntry,path:string):Promise<Uint8Array>;
    loadDirectory?(
        dirPath: string,
        scopeLevel: SkillScopeLevel,
        scopeRoot: string,
    ): Promise<SkillDefinition[]>;
}

export interface SkillToolHandlerFactory {
    create(skill: SkillDefinition, binding: SkillToolBinding): ToolHandler | undefined;
}

export interface SessionCapabilityScope {
    resolveMCPToolIds?(profiles: string[]): Promise<string[]>;
    prepareTools?(ids: string[]): Promise<void>;
    /** Host-owned validation of an active remote Skill's current approval window. */
    validateMcpSkillWindow?(skill:SkillDefinition):Promise<boolean>;
    /** A separate host authorization is required for effects with side effects. */
    validateMcpSkillEffect?(skill:SkillDefinition,kind:string):Promise<boolean>;
    checkMcpSkillVersions?(snapshots:import('@nestos/tools/contracts').SkillVersionSnapshot[]):void;
    stageMcpSkill?(id:string,content:string):import('@nestos/tools/contracts').SkillVersionSnapshot;
    commitMcpSkill?(snapshot:import('@nestos/tools/contracts').SkillVersionSnapshot):SkillLoadResult;
    readMcpSkillApproved?(sessionId:string,skillId:string,taskId:string,windowId:string,
        controls:Pick<import('@nestos/tools/contracts').SessionSkillControls,'verifyMcpApproval'>):Promise<string>;
    readonly toolService: import('@nestos/tools/contracts').IToolService;
    readonly skillService: ISkillService;
    dispose(): Promise<void>;
}

export interface SessionCapabilityRegistry {
    get(sessionId: string): Promise<SessionCapabilityScope>;
    /** Host-routed metadata lookup, without restoring Skills before an unload. */
    getForEffect?(context: EffectExecutionContext): Promise<SessionCapabilityScope>;
    /** Restore persisted loaded identities once per live scope, before building prompts or Effects. */
    restore(sessionId: string, loadedSkillIds: unknown): Promise<SessionCapabilityScope>;
    disposeSession(sessionId: string): Promise<void>;
    dispose(): Promise<void>;
}

export function resolveCapability<T>(
    source: CapabilitySource<T>,
    context: EffectExecutionContext,
): Promise<T> {
    return Promise.resolve(typeof source === 'function'
        ? (source as CapabilityResolver<T>)(context)
        : source);
}

export function failedSkillLoad(skillId: string, error: string): SkillLoadResult {
    return { skillId, success: false, toolIds: [], error };
}
