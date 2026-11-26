import type { SessionSkillControls } from '@nestos/tools/contracts';
import type { SkillInfo } from '../domain/types';

/** Share one refresh queue between catalog notifications and explicit popup refreshes. */
export function bindSkillRefresh(controls: SessionSkillControls, sessionId: string,
    render: (skills: SkillInfo[]) => void, initial?: SkillInfo[]): { refresh(): void; dispose(): void } {
    let disposed = false, running = false, dirty = false;
    let requested = false;
    let unsubscribe: (() => void) | undefined;
    const reload = async () => {
        running = true;
        while (dirty && !disposed) {
            dirty = false;
            const skills = await Promise.resolve().then(() => controls.list(sessionId)).catch(() => undefined);
            if (skills && !disposed && !dirty) render(skills);
        }
        running = false;
    };
    const refresh = () => {
        if (disposed) return;
        requested = true;
        dirty = true;
        if (!running) void reload();
    };
    void Promise.resolve().then(() => controls.onChange(sessionId, refresh))
        .then(off => { if (disposed) off(); else unsubscribe = off; })
        .catch(() => { /* Listing remains available without a live subscription. */ })
        .then(() => {if (!disposed && !requested) {if (initial) render(initial); else refresh();}});
    return { refresh, dispose: () => { disposed = true; unsubscribe?.(); unsubscribe = undefined; } };
}
