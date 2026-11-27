import { runSessionSkillOperation } from './operation-queue';
import type { SessionSkillControls, ISkillService, SkillVersionSnapshot } from '@nestos/tools/contracts';
import type { EffectExecutionContext, Kernel } from '@nestos/durable-kernel';
import type { SessionCapabilityRegistry, SessionCapabilityScope } from '../ports/capabilities';
import { forgetLoadedSkill, parseLoadedSkillIds, parseLoadedSkillVersions, rememberLoadedSkill, rollbackFailedLoad } from './loaded-state';
import {interactionApproved} from '@nestos/durable-kernel';
import {mcpSkillManifestDigest,type McpSkillEntry} from './mcp-skill-verification';
import {validateMcpSkillApproval,type McpSkillApprovalBinding} from '../programs/approved-effect-program';
import {randomUUID} from '../utils/random';
import {MCP_CONTEXT_WINDOW_KEY} from './mcp-execution-window';
import {createSkillVersionSnapshot} from './version-snapshot';

const mcpWindows=new WeakMap<object,string>();
const consumedDynamicApprovals=new WeakMap<object,Set<string>>();
type SkillState=NonNullable<EffectExecutionContext['sessionState']>;
function scopeWindow(scope:object):string {
    let id=mcpWindows.get(scope);if(!id){id=randomUUID();mcpWindows.set(scope,id);}return id;
}

/** UI control uses Session shared state directly; it does not impersonate an Agent Effect. */
export function createSessionSkillControls(kernel: Pick<Kernel, 'openSession'>, registry: SessionCapabilityRegistry): SessionSkillControls {
    const serial = <T>(id: string, action: () => Promise<T>) => runSessionSkillOperation(registry, id, action);
    const list = async (sessionId: string, onlyLoaded: boolean) => {
            const session = await kernel.openSession(sessionId);
            const saved = (await session.getShared('kernel-adapters.skills.loaded'))?.value;
            const ids = parseLoadedSkillIds(saved);
            const versions = parseLoadedSkillVersions(saved);
            const hasRemote=Object.values(versions?.snapshots??{}).some(snapshot=>!!snapshot.definition.metadata?.mcpOrigin);
            const updateState=hasRemote?(await session.getShared('kernel-adapters.skills.mcp-updates'))?.value as {items?:Record<string,{status?:string}>}|undefined:undefined;
            const scope = await registry.get(sessionId);
            const live=scope.skillService.getLoadedSkills(),loaded = new Set([...ids, ...live.map(skill => skill.id)]);
            const all = new Set([...loaded, ...(onlyLoaded ? [] : scope.skillService.listSkills().map(skill => skill.id))]);
            return [...all].sort().map(id => {
                const skill = live.find(item=>item.id===id)??scope.skillService.getSkill(id);
                const remoteSaved=!!versions?.snapshots[id]?.definition.metadata?.mcpOrigin;
                const raw=scope.skillService.getSkill(id),previous=versions?.snapshots[id]?.definition.metadata;
                const moduleUpdate=hasPublishedMcpUpdate(raw);
                const changed=remoteSaved&&(!raw?.metadata?.mcpEntry||JSON.stringify(raw.metadata.mcpEntry)!==JSON.stringify(previous?.mcpEntry)
                    ||JSON.stringify(raw.metadata.mcpOrigin)!==JSON.stringify(previous?.mcpOrigin));
                return { id, name: skill?.name ?? id, description: skill?.description ?? '', loaded: loaded.has(id)&&(!remoteSaved||live.some(item=>item.id===id)),
                    enabled: !!skill?.enabled && !skill.disableModelInvocation && skill.triggerStrategy !== 'action',
                    // Definition-level enablement, independent of whether the input-side checkbox may
                    // load it: `/sk-<id>` exists exactly for the manual (action/silent) invocations.
                    definitionEnabled: !!skill?.enabled && skill.metadata?.mcpActivationPending!==true,
                    ...(skill?.metadata?.mcpActivationPending===true?{mcpApprovalAvailable:!!scope.readMcpSkillApproved&&!moduleUpdate}:{}),
                    ...(moduleUpdate||changed||(!live.some(item=>item.id===id)&&(updateState?.items?.[id]?.status==='restart-required'
                        ||scope.skillService.getMcpSkillUpdates?.()[id]?.status==='restart-required'))?{mcpUpdateRequired:true}:{}),
                    toolCount: skill?.tools.length ?? 0, toolIds: skill?.tools.map(tool => tool.toolId) ?? [], versionDigest: versions?.snapshots[id]?.digest,
                    versionPolicy: versions?.snapshots[id]?.policy, drift: versions?.drifts[id],
                    unversioned: ids.includes(id) && (!versions || !Object.hasOwn(versions.snapshots, id)) };
            });
    };
    const verify=async(sessionId:string,taskId:string,skillId:string,windowId:string)=>{
        const expected=await approvalBinding(registry,sessionId,skillId,windowId);
        const session=await kernel.openSession(sessionId),task=await session.attachTask(taskId),record=(await task.status()).task;
        const interaction=record.interactions['approve:mcp-skill'];
        return record.sessionId===sessionId&&record.program.kind==='kernel-adapters.mcp-skill-approval'&&record.program.version==='1'
            &&record.status==='succeeded'&&interaction?.status==='resolved'&&interactionApproved(interaction.response!)
            &&sameApprovalBinding(record.input,expected)&&sameApprovalBinding(record.output,expected);
    };
    const readApproved=async(sessionId:string,skillId:string,taskId:string,windowId:string,activate:boolean)=>{
        const scope=await registry.get(sessionId);
        if(!scope.readMcpSkillApproved)throw new Error('MCP_SKILL_UNAVAILABLE');
        const entry=scope.skillService.getSkill(skillId)?.metadata?.mcpEntry as McpSkillEntry|undefined;
        if(entry?.resources==='dynamic') {
            if(!activate)throw new Error('MCP_SKILL_ACTIVATION_GATE_REQUIRED');
            if(!await controls.verifyMcpApproval!(sessionId,taskId,skillId,windowId))throw new Error('MCP_SKILL_APPROVAL_DENIED');
            if(scope.skillService.getLoadedSkills().some(item=>item.id===skillId))throw new Error('MCP_SKILL_ACTIVATION_DENIED');
            consumeDynamicApproval(scope,taskId);
        }
        const content=await scope.readMcpSkillApproved(sessionId,skillId,taskId,windowId,{verifyMcpApproval:controls.verifyMcpApproval});
        if(await registry.get(sessionId)!==scope||!await controls.verifyMcpApproval!(sessionId,taskId,skillId,windowId))throw new Error('MCP_SKILL_APPROVAL_REVOKED');
        return {content,scope};
    };
    const controls:SessionSkillControls = {
        mcpApprovalWindow:sessionId=>serial(sessionId,async()=>scopeWindow(await registry.get(sessionId))),
        requestMcpApproval:(sessionId,skillId,requestId,windowId)=>serial(sessionId,async()=>{
            if(typeof requestId!=='string'||!requestId.trim()||requestId.length>128)throw new Error('MCP_SKILL_REQUEST_INVALID');
            const binding=await approvalBinding(registry,sessionId,skillId,windowId);
            const session=await kernel.openSession(sessionId);
            const task=await session.submit({requestId,program:{kind:'kernel-adapters.mcp-skill-approval',version:'1'},input:binding});
            return task.id;
        }),
        verifyMcpApproval:(sessionId,taskId,skillId,windowId)=>serial(sessionId,()=>verify(sessionId,taskId,skillId,windowId)),
        readMcpApproved:async(sessionId,skillId,taskId,windowId)=>{
            const {content,scope}=await readApproved(sessionId,skillId,taskId,windowId,false);
            attachMcpWindow(scope,registry,verify,sessionId,skillId,taskId,windowId);
            return content;
        },
        activateMcpApproved:async(sessionId,skillId,taskId,windowId)=>{
            const {content,scope}=await readApproved(sessionId,skillId,taskId,windowId,true);
            return serial(sessionId,async()=>{
                const skill=scope.skillService.getSkill(skillId);
                if(await registry.get(sessionId)!==scope||!skill||!scope.stageMcpSkill||!scope.commitMcpSkill
                    ||scope.skillService.getLoadedSkills().some(item=>item.id===skillId))throw new Error('MCP_SKILL_ACTIVATION_DENIED');
                attachMcpWindow(scope,registry,verify,sessionId,skillId,taskId,windowId);
                if(!await scope.validateMcpSkillWindow?.(skill))throw new Error('MCP_SKILL_APPROVAL_REVOKED');
                const snapshot=scope.stageMcpSkill(skillId,content),session=await kernel.openSession(sessionId);
                const state:SkillState={get:key=>session.getShared(key),set:(key,value,expectedVersion)=>session.setShared(key,value,{expectedVersion})};
                return settleMcpActivation(scope,state,snapshot,async()=>{
                    if(await registry.get(sessionId)!==scope||!await scope.validateMcpSkillWindow?.(skill))throw new Error('MCP_SKILL_APPROVAL_REVOKED');
                });
            });
        },
        list: id => serial(id, () => list(id, false)),
        listLoaded: id => serial(id, () => list(id, true)),
        load: (id, skillId) => serial(id, async () => {
            const session = await kernel.openSession(id);
            const state: NonNullable<import('@nestos/durable-kernel').EffectExecutionContext['sessionState']> = {
                get: key => session.getShared(key),
                set: (key, value, expectedVersion) => session.setShared(key, value, { expectedVersion }) };
            parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value);
            const service = (await registry.get(id)).skillService;
            await service.refreshScopedSkills?.();
            return loadAndRemember(service, skillId, state);
        }),
        describe: (sessionId, skillId) => serial(sessionId, async () => {
            const skill = (await registry.get(sessionId)).skillService.getSkill(skillId);
            return skill ? { name: skill.name, type: skill.type, instructions: skill.instructions,
                triggerStrategy: skill.triggerStrategy, disableModelInvocation: skill.disableModelInvocation,
                enabled: skill.enabled } : undefined;
        }),
        mountByGlob: (sessionId, filePath) => serial(sessionId, async () => {
            requireEditorPath(filePath);
            (await registry.get(sessionId)).skillService.mountByGlob(filePath);
        }),
        unmountByGlob: (sessionId, filePath) => serial(sessionId, async () => {
            requireEditorPath(filePath);
            (await registry.get(sessionId)).skillService.unmountByGlob(filePath);
        }),
        onChange: async (sessionId, listener) => {
            if (typeof listener !== 'function') throw new Error('Skill change listener is required');
            return (await registry.get(sessionId)).skillService.onChange(listener);
        },
        unload: (sessionId, skillId) => serial(sessionId, async () => {
            const session = await kernel.openSession(sessionId);
            await forgetLoadedSkill(skillId, {
                get: key => session.getShared(key),
                set: (key, value, expectedVersion) => session.setShared(key, value, { expectedVersion }),
            });
            await (await registry.get(sessionId)).skillService.unloadSkill(skillId);
        }),
    };
    return controls;
}

async function settleMcpActivation(scope:SessionCapabilityScope,state:SkillState,snapshot:SkillVersionSnapshot,authorize:()=>Promise<void>):Promise<string[]> {
    const id=snapshot.definition.id,marker=await state.get(MCP_CONTEXT_WINDOW_KEY);
    const next=nextMcpMarker(scope,snapshot,marker?.value);
    const previous=parseLoadedSkillVersions((await state.get('kernel-adapters.skills.loaded'))?.value)?.snapshots[id];
    let markerVersion:number|undefined,persisted=false;
    try {
        if(next)markerVersion=(await state.set(MCP_CONTEXT_WINDOW_KEY,next,marker?.version??null)).version;
        await rememberLoadedSkill(id,state,snapshot);persisted=true;
        await authorize();
        const result=scope.commitMcpSkill!(snapshot);
        if(!result.success)throw new Error(result.error??'MCP_SKILL_ACTIVATION_FAILED');
        return result.toolIds;
    } catch(error) {
        const cleanup=[
            ()=>persisted?(previous?rememberLoadedSkill(id,state,previous):forgetLoadedSkill(id,state)):undefined,
            ()=>markerVersion===undefined?undefined:state.set(MCP_CONTEXT_WINDOW_KEY,marker?.value??null,markerVersion),
            ()=>scope.skillService.unloadSkill(id),
        ];
        const failures:unknown[]=[];
        for(const step of cleanup)try {await step();} catch(failure) {failures.push(failure);}
        if(failures.length)throw new AggregateError([error,...failures],'MCP Skill activation rollback failed');
        throw error;
    }
}

function nextMcpMarker(scope:SessionCapabilityScope,snapshot:SkillVersionSnapshot,value:unknown) {
    const old=value as {format?:unknown;skills?:Record<string,string>}|undefined|null;
    if(old!==undefined&&old!==null&&(old.format!==1||!old.skills||typeof old.skills!=='object'||Array.isArray(old.skills)))throw new Error('MCP_SKILL_CONTEXT_RESTART_REQUIRED');
    const id=snapshot.definition.id,previous=old?.skills?.[id];
    if(previous&&!sameMcpContextDigest(previous,snapshot))throw new Error('MCP_SKILL_CONTEXT_RESTART_REQUIRED');
    const loaded=new Set(scope.skillService.getLoadedSkills().map(skill=>skill.id));
    for(const [other,digest] of Object.entries(old?.skills??{}))if(other!==id
        &&(!loaded.has(other)||scope.skillService.getSkillSnapshot?.(other)?.digest!==digest))
        throw new Error('MCP_SKILL_CONTEXT_RESTART_REQUIRED');
    if(previous!==snapshot.digest)return {format:1,skills:{...old?.skills,[id]:snapshot.digest}};
}

function consumeDynamicApproval(scope:object,taskId:string):void {
    const consumed=consumedDynamicApprovals.get(scope)??new Set<string>();
    if(consumed.has(taskId))throw new Error('MCP_SKILL_APPROVAL_CONSUMED');
    consumed.add(taskId);
    consumedDynamicApprovals.set(scope,consumed);
}

function sameMcpContextDigest(previous:string,snapshot:SkillVersionSnapshot):boolean {
    if(previous===snapshot.digest)return true;
    const {mcpModule,...metadata}=snapshot.definition.metadata??{};
    if(!mcpModule)return false;
    return previous===createSkillVersionSnapshot({...snapshot.definition,metadata},snapshot.instructions,snapshot.compactInstructions).digest;
}

const mcpWindowBindings=new WeakMap<object,Map<string,{taskId:string;windowId:string;origin:string;manifest:string}>>();
function attachMcpWindow(scope:import('../ports/capabilities').SessionCapabilityScope,registry:SessionCapabilityRegistry,verify:NonNullable<SessionSkillControls['verifyMcpApproval']>,
    sessionId:string,skillId:string,taskId:string,windowId:string):void {
    const skill=scope.skillService.getSkill(skillId),entry=skill?.metadata?.mcpEntry as McpSkillEntry|undefined;
    if(!skill?.metadata?.mcpOrigin||!entry)throw new Error('MCP_SKILL_UNAVAILABLE');
    const bindings=mcpWindowBindings.get(scope)??new Map();mcpWindowBindings.set(scope,bindings);
    bindings.set(skillId,{taskId,windowId,origin:JSON.stringify(skill.metadata.mcpOrigin),manifest:mcpSkillManifestDigest(entry)});
    scope.validateMcpSkillWindow=async active=>{
        const held=bindings.get(active.id),current=active.metadata?.mcpEntry as McpSkillEntry|undefined;
        if(!held||!current||JSON.stringify(active.metadata?.mcpOrigin)!==held.origin||mcpSkillManifestDigest(current)!==held.manifest)return false;
        try {return await registry.get(sessionId)===scope&&await verify(sessionId,held.taskId,active.id,held.windowId)
            &&await registry.get(sessionId)===scope;}catch{return false;}
    };
}

function sameApprovalBinding(value:unknown,expected:McpSkillApprovalBinding):boolean {
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const row=value as Record<string,unknown>,keys=Object.keys(expected);
    return Object.keys(row).length===keys.length&&keys.every(key=>row[key]===expected[key as keyof McpSkillApprovalBinding]);
}

async function approvalBinding(registry:SessionCapabilityRegistry,sessionId:string,skillId:string,windowId:string):Promise<McpSkillApprovalBinding> {
    const scope=await registry.get(sessionId);
    if(scopeWindow(scope)!==windowId)throw new Error('MCP_SKILL_WINDOW_CHANGED');
    const skill=scope.skillService.getSkill(skillId),origin=skill?.metadata?.mcpOrigin as {serverId?:unknown;uri?:unknown;scopeId?:unknown;projectId?:unknown;projectRevision?:unknown;mountId?:unknown;principalId?:unknown;authorizationRevision?:unknown}|undefined;
    const entry=skill?.metadata?.mcpEntry as McpSkillEntry|undefined;
    if(hasPublishedMcpUpdate(skill))throw new Error('MCP_SKILL_CONTEXT_RESTART_REQUIRED');
    if(!skill?.enabled||skill.metadata?.mcpActivationPending!==true||typeof origin?.serverId!=='string'||typeof origin.uri!=='string'||!entry||entry.uri!==origin.uri)throw new Error('MCP_SKILL_UNAVAILABLE');
    if(origin.scopeId!==undefined&&typeof origin.scopeId!=='string')throw new Error('MCP_SKILL_UNAVAILABLE');
    if(origin.projectId!==undefined&&(typeof origin.projectId!=='string'||typeof origin.projectRevision!=='number'||typeof origin.mountId!=='string'||typeof origin.principalId!=='string'||typeof origin.authorizationRevision!=='string'))throw new Error('MCP_SKILL_UNAVAILABLE');
    const module=skill.metadata?.mcpModule as {id:string;version:string}|undefined;
    const binding={sessionId,serverId:origin.serverId,uri:origin.uri,manifestDigest:mcpSkillManifestDigest(entry),windowId,
        ...(module?{moduleId:module.id,moduleVersion:module.version}:{}),
        ...(entry.resources==='dynamic'?{dynamic:true as const}:{}),...(origin.scopeId?{scopeId:origin.scopeId}:{}),
        ...(typeof origin.projectId==='string'?{projectId:origin.projectId,projectRevision:origin.projectRevision as number,mountId:origin.mountId as string,principalId:origin.principalId as string,authorizationRevision:origin.authorizationRevision as string}:{})};
    validateMcpSkillApproval(binding);return binding;
}

function hasPublishedMcpUpdate(skill:import('@nestos/tools/contracts').SkillDefinition|undefined):boolean {
    return !!(skill?.metadata?.mcpModule as {publishedVersion?:string}|undefined)?.publishedVersion;
}

/** Editor paths are virtual Session paths; reject anything that is not a non-empty string. */
function requireEditorPath(filePath: string): void {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Editor file path is required');
}

async function loadAndRemember(service: ISkillService, id: string,
    state: NonNullable<import('@nestos/durable-kernel').EffectExecutionContext['sessionState']>): Promise<string[]> {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Skill id is required');
    const skill = service.getSkill(id);
    if (!skill?.enabled || skill.disableModelInvocation || skill.triggerStrategy === 'action') throw new Error(`Skill cannot be loaded into model context: ${id}`);
    const wasLoaded = service.getLoadedSkills().some(item => item.id === id);
    const versions = parseLoadedSkillVersions((await state.get('kernel-adapters.skills.loaded'))?.value);
    const previous = service.getSkillSnapshot?.(id)
        ?? (versions && Object.hasOwn(versions.snapshots, id) ? versions.snapshots[id] : undefined);
    const result = await (service.reloadSkill?.(id) ?? service.loadSkill(id));
    if (!result.success) throw new Error(result.error ?? `Failed to load Skill: ${id}`);
    try { await rememberLoadedSkill(id, state, result.snapshot); }
    catch (error) {
        if (previous && service.restoreSkillSnapshot) {
            try {
                const restored = await service.restoreSkillSnapshot(previous);
                if (!restored.success) throw new Error(restored.error ?? 'Previous Skill version cannot be restored');
            } catch (cleanup) { throw new AggregateError([error, cleanup], 'Skill reload persistence and rollback failed'); }
        } else if (!wasLoaded) await rollbackFailedLoad(service, id, error);
        throw error;
    }
    return result.toolIds;
}
