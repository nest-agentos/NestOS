import type {KanbanBoard} from '@nestos/kanban/contracts';
import {compileCoordinationProposal,type Definition,type SavedFix} from '@nestos/kanban/integration';
import {sha256HexSync} from '@nestos/common';
/** The host supplies stable identities and authorized resource inheritance. */
export function coordinationProposal(input:unknown,fix:SavedFix,board:KanbanBoard):Definition{
    return compileCoordinationProposal(input,fix.item,board,{idForKey:key=>'sub-'+sha256HexSync(JSON.stringify([fix.id,key])).slice(0,40),inheritReferences:refs=>refs.filter(ref=>['nestos-remote-project','nestos-decision-run'].includes(ref.system))});
}
