import type {KanbanItem} from '@nestos/kanban/contracts';

const decisionRun=(item:KanbanItem)=>item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id;

/** Keep the current plan, relevant decision tasks, and possible active dependencies. */
export function planningCandidates(item:KanbanItem, items:KanbanItem[]) {
    const active=items.filter(row=>!row.deletedAt||row.id===item.id);
    const byId=new Map(active.map(row=>[row.id,row])),children=new Map<string,string[]>();
    for(const row of active) {
        const parent=row.planning?.parentId;
        if(!parent)continue;
        const siblings=children.get(parent);
        if(siblings)siblings.push(row.id);
        else children.set(parent,[row.id]);
    }
    const run=decisionRun(item);
    const related=new Set<string>(),pending=[item.id,...active.filter(row=>run&&decisionRun(row)===run).map(row=>row.id)];
    for(let i=0;i<pending.length;i++) {
        const id=pending[i];
        if(related.has(id))continue;
        related.add(id);
        pending.push(...byId.get(id)?.planning?.dependencies??[],...children.get(id)??[]);
    }
    return active.filter(row=>related.has(row.id)||!['completed','cancelled'].includes(row.status))
        .map(({id,title,responsibility,acceptance,planning,status})=>({id,title,responsibility,acceptance,planning,status}));
}
