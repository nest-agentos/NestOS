/** The Node host reads deployment configuration, separate from decision or model input. */
export function kanbanModulePermissions(raw:string|undefined):Readonly<Record<string,unknown>>|undefined {
    if(raw===undefined)return;
    try {
        const value:unknown=JSON.parse(raw);
        if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>;
    }catch { /* Report a stable configuration error without printing policy content. */ }
    throw Object.assign(new Error('Invalid Kanban module permissions'),{code:'KANBAN_MODULE_PERMISSIONS_INVALID'});
}

/** Skill permissions are explicit per project and never inherited from execution rules. */
export function kanbanSkillPermissions(raw:string|undefined) {
    if(raw===undefined)return;
    try {
        const nodes=kanbanModulePermissions(raw)!;
        const grants=new Map(Object.entries(nodes).map(([serverId,projects])=>[serverId,projectSkillGrants(projects)]));
        return async (_input:unknown,_localProjectId:string,source?:{serverId:string;projectId:string})=>
            source?grants.get(source.serverId)?.get(source.projectId)??[]:[];
    } catch {
        throw Object.assign(new Error('Invalid Kanban Skill permissions'),{code:'KANBAN_SKILL_PERMISSIONS_INVALID'});
    }
}

function projectSkillGrants(projects:unknown):Map<string,readonly string[]> {
    if(!projects||typeof projects!=='object'||Array.isArray(projects))throw new Error('Invalid projects');
    return new Map(Object.entries(projects).map(([projectId,permissions])=>{
        if(!projectId||!Array.isArray(permissions)||permissions.some(value=>typeof value!=='string'||!value.trim()))
            throw new Error('Invalid project grants');
        return [projectId,Object.freeze([...new Set<string>(permissions)])];
    }));
}
