import type {ConversationControls, ConversationSnapshot} from '../contracts';

export type NativeInputRoute = 'steer' | 'queue' | 'send' | 'blocked';
export interface NativeInputPolicy {
    readonly route: NativeInputRoute;
    readonly mode: 'steer' | 'queue' | 'send';
    readonly turnId?: string;
}

/** One decision for availability, presentation and dispatch; execution is not admission. */
export function nativeInputPolicy(state: ConversationSnapshot, controls: ConversationControls,
    steerSelection = true): NativeInputPolicy {
    const turnId = state.observation?.activeTurnId;
    if (state.canSteer && controls.steer && steerSelection && turnId)
        return {route: 'steer', mode: 'steer', turnId};
    if (state.canQueue && controls.enqueue)
        return {route: 'queue', mode: !state.canSend || state.active ? 'queue' : 'send'};
    if (state.canSend && !state.pending) return {route: 'send', mode: 'send'};
    return {route: 'blocked', mode: 'send'};
}

export function nativeCommandAvailable(state: ConversationSnapshot, controls: ConversationControls,
    execution?: 'query' | 'serial'): boolean {
    if (execution === 'query') return !!(state.canQueryCommand && controls.queryCommand)
        || !!((state.canCommand ?? state.canSend) && !state.pending && controls.command);
    return !!(state.canQueue && controls.enqueue || state.canSend && !state.pending && controls.command);
}
