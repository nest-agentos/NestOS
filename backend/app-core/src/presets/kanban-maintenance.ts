import type {ReviewAction} from '../kanban/item-operation-types';
/** Runtime identity and business policy stay in the frozen channel, not the message. */
export function maintenanceInstruction(action:ReviewAction,additional:string[]=[]):string {
    const entry=action==='analyze'?'merge':action==='merge'?'integrate':action;
    const sections=[...additional,`task-${entry}-pre.md`];
    return `Read ${sections.map(name=>'`'+name+'`').join(', ')} via \`session_context\` and follow this operation's instructions.`;
}
