import {McpSkillSource,type SkillSource} from '@nestos/kernel-adapters';
import type {ProjectRemoteMountService} from './remote-mounts';
import {readContextCatalog,type ContextInspector} from './harness-context-catalog';
import {createModuleLogger,randomUUID} from '@nestos/common';

const log=createModuleLogger('session-channel-skills');

type Files={cwd:string;sessionId:string;scopeId?:string};
type Manifest={folder?:string|null;currentBranch:string};
type Project={project:{id:string}};
type Dependencies={kernel:()=>ContextInspector|undefined;manifest(id:string):Promise<Manifest>;project(folder:string|null|undefined):Promise<Project|undefined>;
    remote:Pick<ProjectRemoteMountService,'list'|'projectHarness'|'sessionChannel'>};

/** Discover metadata through a confirmed native context; content remains unavailable here. */
export function sessionChannelSkillSource(files:Files,local:SkillSource|undefined,deps:Dependencies):SkillSource {
    let source:McpSkillSource|undefined,generation=0;
    return {
        async loadScope(cwd) {
            const current=++generation;source?.invalidate();source=undefined;
            const [base,remote]=await Promise.all([local?.loadScope(cwd)??{cwd,skills:[],agentInstructions:''},metadata(files,deps)]);
            if(current!==generation)throw new Error('MCP_SKILL_SCOPE_CHANGED');
            const selected=remote?new McpSkillSource(remote.serverId,{
                listMcpSkills:async()=>remote.skills,
                getMcpSkill:async uri=>{const fresh=await sameBinding(files,deps,remote);const skill=fresh.skills.find(item=>item.uri===uri);
                    if(!skill)throw new Error('MCP_SKILL_UNAVAILABLE');return skill;},
                readMcpSkillBytes:async uri=>{
                    await sameBinding(files,deps,remote);
                    const value=await deps.remote.sessionChannel(remote.projectId,'messages',{cwd:remote.cwd,scopeId:remote.scopeId,
                        nativeSessionId:remote.nativeSessionId,skillResourceUri:uri});
                    const bytes=resourceBytes(value,uri);await sameBinding(files,deps,remote);return bytes;
                },
            },remote.scopeId,{projectId:remote.sourceProjectId,projectRevision:remote.projectRevision,mountId:remote.mountAlias,
                principalId:remote.principalId,authorizationRevision:remote.authorizationRevision}):undefined;
            const extra=await selected?.loadScope(cwd);
            if(current!==generation){selected?.invalidate();throw new Error('MCP_SKILL_SCOPE_CHANGED');}source=selected;
            return {...base,skills:[...base.skills,...extra?.skills??[]]};
        },
        readApproved:async(sessionId,skillId,taskId,windowId,controls)=>{
            if(sessionId!==files.sessionId||!source)throw new Error('MCP_SKILL_UNAVAILABLE');
            return source.readApproved(sessionId,skillId,taskId,windowId,controls);
        },
        dispose:async()=>{generation++;source?.invalidate();source=undefined;await local?.dispose?.();},
        ...(local?.loadDirectory?{loadDirectory:local.loadDirectory.bind(local)}:{}),
    };
}

async function metadata(files:Files,deps:Dependencies) {
    const started=Date.now(),operationId=randomUUID();
    try {const skills=await readMetadata(files,deps);
        log.info('Session skill discovery',{operation:'skills.session.discover',operationId,stage:'metadata',result:'success',count:skills?.skills.length??0,durationMs:Date.now()-started});return skills;
    } catch(error) {const code=(error as {code?:unknown;remoteCode?:unknown}).remoteCode??(error as {code?:unknown}).code;
        log.warn('Session skill discovery',{operation:'skills.session.discover',operationId,stage:'metadata',result:'failure',
            code:typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'MCP_SKILL_DISCOVERY_FAILED',durationMs:Date.now()-started});throw error;}
}

async function readMetadata(files:Files,deps:Dependencies) {
    const kernel=deps.kernel();if(!kernel)return;
    const manifest=await deps.manifest(files.sessionId),project=await deps.project(manifest.folder);if(!project)return;
    const catalog=await readContextCatalog(kernel,files.sessionId);
    const bindings=Object.values(catalog.value.bindings).filter(binding=>binding.branchId===manifest.currentBranch&&binding.validity==='valid'&&binding.nativeRef);
    if(bindings.length!==1)return;
    const native=bindings[0].nativeRef!,root=deps.remote.list(project.project.id).find(mount=>mount.at==='/');
    if(!root?.serverId||!root.serverProjectRevision||!root.authorization?.principalId||!root.authorization.revision
        ||root.connectionId!==native.nodeConnectionId||root.serverProjectId!==native.workspaceId)return;
    const client=await deps.remote.projectHarness(project.project.id,{requireRegistered:true});
    let cwd:string|undefined;
    try {const observed=await (client.inspect?client.inspect(native.profileId,native.sessionId):client.read(native.profileId,native.sessionId));
        if(observed.session.id!==native.sessionId)return;cwd=observed.session.cwd??undefined;
    } finally {await client.close();}
    if(!cwd)return;
    let current:{scopeId?:unknown;execution?:{sessionId?:unknown}};
    try {current=await deps.remote.sessionChannel(project.project.id,'current',{cwd}) as typeof current;}
    catch(error) {const detail=error as {remoteCode?:string;code?:string};
        if(['CHANNEL_SCOPE_UNKNOWN','CHANNEL_WORKSPACE_INVALID'].includes(detail.remoteCode??detail.code??''))return;throw error;}
    if(typeof current.scopeId!=='string'||current.execution?.sessionId!==native.sessionId||files.scopeId&&files.scopeId!==current.scopeId)return;
    const result=await deps.remote.sessionChannel(project.project.id,'messages',{cwd,scopeId:current.scopeId,nativeSessionId:native.sessionId,skillsMetadata:true}) as {skills?:unknown};
    const [after,latest]=await Promise.all([readContextCatalog(kernel,files.sessionId),deps.manifest(files.sessionId)]);
    const rebound=deps.remote.list(project.project.id).find(mount=>mount.at==='/');
    if(after.version!==catalog.version||latest.currentBranch!==manifest.currentBranch||rebound?.serverId!==root.serverId
        ||rebound.serverProjectId!==root.serverProjectId||rebound.serverProjectRevision!==root.serverProjectRevision||rebound.connectionId!==root.connectionId
        ||rebound.mountId!==root.mountId||rebound.alias!==root.alias||rebound.authorization?.principalId!==root.authorization?.principalId
        ||rebound.authorization?.revision!==root.authorization?.revision)throw new Error('MCP_SKILL_SESSION_BINDING_CHANGED');
    if(result.skills===undefined)return; // Legacy Cells ignores the metadata selector.
    if(!Array.isArray(result.skills))throw new Error('MCP_SKILL_RESULT_INVALID');
    return {serverId:root.serverId,scopeId:current.scopeId,projectId:project.project.id,cwd,nativeSessionId:native.sessionId,
        sourceProjectId:root.serverProjectId!,projectRevision:root.serverProjectRevision,mountId:root.mountId,mountAlias:root.alias,
        principalId:root.authorization.principalId,authorizationRevision:root.authorization.revision,
        skills:result.skills as Array<{uri:string;frontmatter:Record<string,unknown>;resources:Array<{uri:string;digest:string;size:number}>|'dynamic'}>};
}

async function sameBinding(files:Files,deps:Dependencies,expected:NonNullable<Awaited<ReturnType<typeof metadata>>>) {
    const current=await metadata(files,deps);
    if(!current||['serverId','scopeId','projectId','cwd','nativeSessionId','sourceProjectId','projectRevision','mountId','mountAlias','principalId','authorizationRevision'].some(key=>current[key as keyof typeof current]!==expected[key as keyof typeof expected]))
        throw new Error('MCP_SKILL_SESSION_BINDING_CHANGED');
    return current;
}
function resourceBytes(value:unknown,uri:string):Uint8Array {
    const contents=(value as {contents?:unknown})?.contents;
    if(!Array.isArray(contents)||contents.length!==1||contents[0]?.uri!==uri)throw new Error('MCP_SKILL_RESOURCE_MISMATCH');
    const item=contents[0] as {text?:unknown;blob?:unknown};
    if(typeof item.text==='string')return new TextEncoder().encode(item.text);
    if(typeof item.blob==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.blob))
        return Uint8Array.from(atob(item.blob),character=>character.charCodeAt(0));
    throw new Error('MCP_SKILL_RESOURCE_INVALID');
}
