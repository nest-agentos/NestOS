import type {KanbanClient} from '@nestos/kanban/contracts';

/** Share concurrent reads within one workspace; never retain settled or failed results. */
export function shareKanbanCatalog(service?: KanbanClient): KanbanClient | undefined {
    if (!service) return;
    let pending: ReturnType<KanbanClient['catalog']> | undefined;
    const catalog = () => pending ??= Promise.resolve().then(() => service.catalog()).finally(() => {pending = undefined;});
    return new Proxy(service, {get(target, key) {
        if (key === 'catalog') return catalog;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    }});
}
