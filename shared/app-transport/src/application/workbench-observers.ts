import type {ApplicationViewEvent, ConversationWorkbenchView} from '@nestos/app-contracts/services';

interface Registration {listener: (event: ApplicationViewEvent) => void; failed?: (failure: {code: string}) => void}
interface Group {cursor: number; listeners: Set<Registration>; queued: boolean; read: ConversationWorkbenchView['eventSnapshot']}
const groups = new WeakMap<object, Group>();
/** Source observation is owned by the view; local consumers do not register more RPCs. */
export function installWorkbenchObservers(proxy: ConversationWorkbenchView): void {
    let group = groups.get(proxy);
    if (!group) {
        group = {cursor: proxy.cursor, listeners: new Set(), queued: false, read: proxy.eventSnapshot};
        groups.set(proxy, group);
    } else group.read = proxy.eventSnapshot;
    const current = group;
    proxy.subscribe = async (listener, failed) => {
        const registration = {listener, failed}; current.listeners.add(registration); schedule(current);
        return () => {current.listeners.delete(registration);};
    };
    schedule(current);
}
function schedule(group: Group): void {
    if (group.queued) return;
    group.queued = true;
    queueMicrotask(() => {
        group.queued = false;
        if (!group.listeners.size) return;
        const snapshot = group.read();
        if (group.cursor < snapshot.firstSequence - 1) {
            group.cursor = snapshot.cursor; fail(group, 'WORKBENCH_OBSERVATION_GAP'); return;
        }
        for (const event of snapshot.events) {
            if (event.sequence <= group.cursor) continue;
            for (const registration of [...group.listeners]) {
                if (!group.listeners.has(registration)) continue;
                try {registration.listener(event);}
                catch {registration.failed?.({code: 'WORKBENCH_OBSERVATION_HANDLER_FAILED'});}
            }
            group.cursor = event.sequence;
        }
    });
}
function fail(group: Group, code: string): void {
    for (const registration of [...group.listeners]) registration.failed?.({code});
}
