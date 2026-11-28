import type {ReviewSnapshot} from '@nestos/kanban-development';
import type {GitSource} from '@nestos/git-delivery/contracts';
import {previewGitIntegration,type GitIntegrationPreview} from '@nestos/git-delivery/integration-transaction';
import type {PromptBundle} from '../run/prompt-bundle';
import type {DevelopmentReviewOptions} from './kanban-development-review';
import {developmentWorkspace} from './kanban-development-workspace';
import {managementBatch} from './kanban-management-snapshot';

export const integrationAnalysisInstruction='Read the `integration-analysis` section via `session_context` and report the frozen integration plan. Its guidance is inline unless it lists separate guidance sections.';

export async function freezeIntegrationPreview(options:DevelopmentReviewOptions, id:string, projectId:string,snapshot:ReviewSnapshot) {
    const key='merge-preview:'+id,existing=await options.journal.get<GitIntegrationPreview>(key);
    if(existing)return existing;
    const sources=(snapshot.context as {management?:unknown})?.management
        ?managementBatch(snapshot).sources.map(row=>row.snapshot.context as GitSource):[snapshot.context as GitSource];
    const preview=await developmentWorkspace(options.remote,options.provider,projectId,
        process=>previewGitIntegration(process,id,snapshot.targetVersion,sources));
    return options.journal.update<GitIntegrationPreview>(key,current=>current??preview);
}

export function integrationAnalysisView(context:unknown,prompts:PromptBundle,policy:unknown) {
    const value=context as {operation?:{phase?:string;commitContexts?:unknown;gitPreview?:unknown}}|undefined;
    if(value?.operation?.phase!=='analyze'||!value.operation.gitPreview)return {context,sections:{}};
    const {commitContexts,gitPreview,...operation}=value.operation;
    const entry=prompts.files.some(file=>file.name==='management-integration-pre.md')?'management-integration-pre.md':'task-merge-pre.md';
    const names=[entry,'workspace-rules.md','session-protocol.md','task-merge-post.md','session-learnings.md'];
    const guidance=Object.fromEntries(prompts.files.filter(file=>names.includes(file.name)).map(file=>[file.name,file.content]));
    const lookups={provenance:'commit-contexts',intentAndIdentity:['context','identity'],acknowledgments:'channel-status'};
    const complete={guidance,operation,gitPreview,policy,lookups};
    const analysis=new TextEncoder().encode(JSON.stringify(complete)).byteLength<=65536
        ?complete:{guidanceSections:names,lookups,operationSection:'context',policySection:'policy',gitPreview};
    return {context:{...value,operation:{...operation,commitContexts}},
        sections:{'integration-analysis':analysis,'commit-contexts':commitContexts}};
}
