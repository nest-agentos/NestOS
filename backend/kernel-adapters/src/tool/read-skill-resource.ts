import type {ToolDefinition,ToolHandler,ToolMeta} from '@nestos/tools/contracts';
import type {SessionCapabilityScope,SkillSource} from '../ports/capabilities';
import type {McpSkillEntry} from '../skill/mcp-skill-verification';

export const readSkillResourceMeta:ToolMeta={
    id:'read_skill_resource',name:'Read Skill Resource',description:'Read an approved MCP Skill supporting file',
    sideEffect:'none',timeoutMs:30_000,type:'builtin',enabled:true,tags:['skill','read'],
};

export const readSkillResourceDefinition:ToolDefinition={
    name:readSkillResourceMeta.id,description:readSkillResourceMeta.description,
    parameters:{type:'object',properties:{skill_id:{type:'string'},path:{type:'string',description:'Path relative to the Skill directory'}},
        required:['skill_id','path']},
};

export function createReadSkillResourceHandler(scope?:SessionCapabilityScope,source?:SkillSource):ToolHandler {
    return async ({skill_id,path})=>{
        if(typeof skill_id!=='string'||typeof path!=='string')throw new Error('MCP_SKILL_RESOURCE_ARGS_INVALID');
        if(!scope||!source?.readSupporting)throw new Error('MCP_SKILL_UNAVAILABLE');
        const active=()=>scope.skillService.getLoadedSkills().find(item=>item.id===skill_id);
        const skill=active(),entry=skill?.metadata?.mcpEntry as McpSkillEntry|undefined;
        if(!skill||!entry||!await scope.validateMcpSkillWindow?.(skill))throw new Error('MCP_SKILL_APPROVAL_REQUIRED');
        const bytes=await source.readSupporting(skill_id,entry,path).catch(async error=>{
            if(isIntegrityFailure(error)&&active()===skill)await scope.skillService.unloadSkill(skill_id);
            throw error;
        });
        if(active()!==skill||!await scope.validateMcpSkillWindow?.(skill))throw new Error('MCP_SKILL_APPROVAL_REVOKED');
        return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    };
}

function isIntegrityFailure(error:unknown):boolean {
    const detail=error as {message?:string;code?:string;remoteCode?:string};
    return /^(?:MCP_)?SKILL_(?:SIZE_MISMATCH|DIGEST_MISMATCH|MANIFEST_CHANGED)$/.test(detail.remoteCode??detail.code??detail.message??'');
}
