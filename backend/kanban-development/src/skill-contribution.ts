import {sha256HexSync} from '@nestos/common';
import {projectKanbanSkills,type KanbanSkillContribution,type KanbanSkillProvider,type KanbanSkillProviderContext} from '@nestos/kanban/contracts';

const root='backend/kanban-development/skills/kanban-work';
const files=['SKILL.md','references/planning.md','references/execution.md'] as const;
export type KanbanWorkSkillSource=KanbanSkillProviderContext;
export const kanbanWorkSkillProvider:KanbanSkillProvider={moduleId:'software-development',moduleVersion:'1',stages:['decision','task','fix'],permission:'kanban-work:read',build:kanbanWorkSkillContribution};

/** Package-owned example; the host supplies the authorized project read port. */
export async function kanbanWorkSkillContribution(source:KanbanWorkSkillSource):Promise<KanbanSkillContribution> {
    const started=Date.now();let stage='read';
    try {
        const prefix=workspacePrefix(source.workspacePath);
        const data=await Promise.all(files.map(path=>source.readBytes(`${prefix}${root}/${path}`)));
        stage='frontmatter';const frontmatter=parseFrontmatter(data[0],source.parseYaml);
        const contribution:KanbanSkillContribution={moduleId:'software-development',moduleVersion:'1',serverId:source.serverId,
            uri:'skill://kanban-work/SKILL.md',stages:['decision','task','fix'],permission:'kanban-work:read',
            source:{projectId:source.projectId,revision:source.revision,mountId:source.mountId},frontmatter,
            resources:files.map((path,index)=>({uri:`skill://kanban-work/${path}`,path:`${prefix}${root}/${path}`,
                size:data[index].byteLength,digest:'sha256:'+sha256HexSync(data[index])}))};
        stage='validate';projectKanbanSkills([contribution],{projectId:source.projectId,stage:'task',permissions:['kanban-work:read'],
            modules:[{system:'nestos-decision-module',id:contribution.moduleId,revision:contribution.moduleVersion}]});
        log(source,stage,'success',started);return contribution;
    } catch(error) {log(source,stage,'failure',started);throw error;}
}
function workspacePrefix(path:string):string {
    if(typeof path!=='string'||path.length>4096||path.includes('\\')||path.includes('\0')||path.startsWith('/')
        ||(path!==''&&path.split('/').some(part=>!part||part==='.'||part==='..')))throw new Error('KANBAN_SKILL_WORKSPACE_INVALID');
    return path?`${path}/`:'';
}
function parseFrontmatter(bytes:Uint8Array,parse:(text:string)=>unknown):Record<string,unknown> {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if(!match)throw new Error('KANBAN_SKILL_FRONTMATTER_MISSING');
    const result=parse(match[1]);
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('KANBAN_SKILL_FRONTMATTER_INVALID');
    return result as Record<string,unknown>;
}
function log(source:KanbanWorkSkillSource,stage:string,result:'success'|'failure',started:number):void {
    try {source.log?.({operation:'kanban.skill.contribution',operationId:source.operationId,stage,result,
        ...(result==='failure'?{code:`KANBAN_SKILL_${stage.toUpperCase()}_FAILED`}:{}),durationMs:Date.now()-started});}catch {/* Diagnostics cannot change the contribution result. */}
}
