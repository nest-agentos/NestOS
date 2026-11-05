import type {KanbanItem} from '@nestos/kanban/contracts';

/** Publish candidate summaries separately from frozen details so planning reads stay bounded. */
export function planningSections(context: unknown): Record<string, unknown> {
    const value = context as {snapshot?: {item?: KanbanItem; items?: KanbanItem[]}} | null;
    if (!value || !Array.isArray(value.snapshot?.items)) return {context: context ?? null};
    const items = value.snapshot.items, item = value.snapshot.item;
    const snapshot = {...value.snapshot,
        ...(item ? {item: {id:item.id,number:item.number,title:item.title,responsibility:item.responsibility,acceptance:item.acceptance,planning:item.planning}} : {}),
        items: items.map(row => ({id:row.id,title:row.title,status:row.status,kind:row.planning?.kind,
            parentId:row.planning?.parentId,dependencies:row.planning?.dependencies ?? [],section:'dependency:'+row.id}))};
    return {context: {...value,snapshot}, 'planning-input': snapshot,
        ...Object.fromEntries(items.map(row => ['dependency:'+row.id,row]))};
}
