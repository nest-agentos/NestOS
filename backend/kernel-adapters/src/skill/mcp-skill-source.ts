import {sha256HexSync} from '@nestos/llm-context';
import type {SkillDefinition} from '@nestos/tools/contracts';
import type {SkillScopeSnapshot,SkillSource} from '../ports/capabilities';
import {McpSkillVerification,readMcpSkillFile,sameMcpSkillEntry,type McpSkillEntry} from './mcp-skill-verification';
import type {SessionSkillControls} from '@nestos/tools/contracts';

export interface McpSkillOriginBinding {projectId:string;projectRevision:number;mountId:string;principalId:string;authorizationRevision:string}
interface McpSkillModule {id:string; version:string; publishedVersion?:string}

/** Discover remote metadata without fetching or activating its files. */
export class McpSkillSource implements SkillSource {
    private entries=new Map<string,McpSkillEntry>();
    private generation=0;
    constructor(private readonly serverId:string,private readonly connection:{listMcpSkills():Promise<McpSkillEntry[]>;getMcpSkill?(uri:string):Promise<McpSkillEntry>;readMcpSkillBytes?(uri:string):Promise<Uint8Array>;module?(uri:string):McpSkillModule|undefined},private readonly scopeId?:string,private readonly origin?:McpSkillOriginBinding) {
        if(!serverId)throw new Error('MCP_SKILL_SERVER_REQUIRED');
    }
    async loadScope(cwd:string):Promise<SkillScopeSnapshot> {
        const generation=++this.generation;
        const entries=await this.connection.listMcpSkills();
        if(generation!==this.generation)throw new Error('MCP_SKILL_SCOPE_CHANGED');
        const skills=entries.map(entry=>metadata(this.serverId,entry,this.scopeId,this.origin,this.connection.module?.(entry.uri)));
        if(new Set(skills.map(skill=>skill.id)).size!==skills.length)throw new Error('MCP_SKILL_IDENTITY_CONFLICT');
        this.entries=new Map(skills.map((skill,index)=>[skill.id,structuredClone(entries[index])]));
        return {cwd,skills,agentInstructions:''};
    }
    async readApproved(sessionId:string,skillId:string,taskId:string,windowId:string,controls:Pick<SessionSkillControls,'verifyMcpApproval'>):Promise<string> {
        const generation=this.generation;
        const held=this.entries.get(skillId);
        if(!held||!this.connection.getMcpSkill||!this.connection.readMcpSkillBytes||!controls.verifyMcpApproval)throw new Error('MCP_SKILL_UNAVAILABLE');
        const current=await this.connection.getMcpSkill(held.uri);
        if(!sameMcpSkillEntry(current,held))throw new Error('MCP_SKILL_MANIFEST_CHANGED');
        const verified=new McpSkillVerification(this.serverId,current,{read:uri=>this.connection.readMcpSkillBytes!(uri)});
        const content=await verified.load(()=>controls.verifyMcpApproval!(sessionId,taskId,skillId,windowId));
        if(generation!==this.generation)throw new Error('MCP_SKILL_SCOPE_CHANGED');
        if(!await controls.verifyMcpApproval(sessionId,taskId,skillId,windowId))throw new Error('MCP_SKILL_APPROVAL_REVOKED');
        if(generation!==this.generation)throw new Error('MCP_SKILL_SCOPE_CHANGED');
        return content;
    }
    async readSupporting(skillId:string,entry:McpSkillEntry,path:string):Promise<Uint8Array> {
        const generation=this.generation,held=this.entries.get(skillId);
        if(!held||!this.connection.getMcpSkill||!this.connection.readMcpSkillBytes)throw new Error('MCP_SKILL_UNAVAILABLE');
        if(!sameMcpSkillEntry(held,entry))throw new Error('MCP_SKILL_MANIFEST_CHANGED');
        if(!path||path.length>4096||/[:\\?#]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))
            throw new Error('MCP_SKILL_RESOURCE_UNAUTHORIZED');
        const uri=new URL(path,new URL('.',entry.uri)).href;
        if(uri===entry.uri||!Array.isArray(entry.resources)||!entry.resources.some(file=>file.uri===uri))
            throw new Error('MCP_SKILL_RESOURCE_UNAUTHORIZED');
        const current=await this.connection.getMcpSkill(entry.uri);
        if(!sameMcpSkillEntry(current,entry)||generation!==this.generation)throw new Error('MCP_SKILL_MANIFEST_CHANGED');
        const result=await readMcpSkillFile(entry,uri,{read:target=>this.connection.readMcpSkillBytes!(target)});
        if(generation!==this.generation)throw new Error('MCP_SKILL_SCOPE_CHANGED');
        return result;
    }
    invalidate():void {this.generation++;this.entries.clear();}
}
function metadata(serverId:string,entry:McpSkillEntry,scopeId?:string,origin?:McpSkillOriginBinding,module?:McpSkillModule):SkillDefinition {
    const {uri,frontmatter}=entry;
    if(typeof uri!=='string'||!uri||!frontmatter||typeof frontmatter.name!=='string'||typeof frontmatter.description!=='string')throw new Error('MCP_SKILL_RESULT_INVALID');
    return {id:'mcp-'+sha256HexSync(JSON.stringify(origin?[serverId,uri,scopeId,origin]:scopeId?[serverId,uri,scopeId]:[serverId,uri])),name:frontmatter.name,description:frontmatter.description,
        type:'prompt',enabled:true,instructions:'',tools:[],triggerPatterns:[],autoLoad:false,priority:50,
        source:'filesystem',scopeLevel:'global-fs',disableModelInvocation:true,
        metadata:{mcpOrigin:{serverId,uri,...(scopeId?{scopeId}:{}),...origin},mcpEntry:structuredClone(entry),mcpActivationPending:true,
            ...(module?{mcpModule:module}:{})}};
}
