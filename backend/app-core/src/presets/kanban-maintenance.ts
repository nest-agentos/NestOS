import type {ReviewAction,ReviewSnapshot} from '../kanban/item-operation-types';
/** Policy lives in the frozen Markdown bundle; the request carries only admission facts. */
export function maintenanceInstruction(input:{id:string;action:ReviewAction;snapshot:ReviewSnapshot},_directory:string):string {
    const entry=input.action==='merge'?'integrate':input.action;
    return JSON.stringify({dependencies:{lifecycle:{stage:'postload.succeeded'}},operation:{action:input.action,id:input.id},
        instruction:`Continue this SAME Session for the admitted ${input.action} operation. Read operation.md, context, task-${entry}-pre.md and task-${entry}-post.md through session_context. Context.operation contains frozen approval, versions and the durable receipt path. Preserve the original Session and worktree; do not rerun development.`});
}
