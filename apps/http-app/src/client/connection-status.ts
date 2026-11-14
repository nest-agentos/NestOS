export type ConnectionState = 'connected' | 'reconnecting' | 'expired' | 'view-error';
/** A late UI subscriber receives the latest connection state before further notifications. */
export class ConnectionStatus {
    private state: ConnectionState = 'connected';
    private readonly listeners = new Set<(state: ConnectionState) => void>();
    subscribe(listener: (state: ConnectionState) => void): () => void {
        this.listeners.add(listener); listener(this.state);
        return () => {this.listeners.delete(listener);};
    }
    publish(state: ConnectionState): void {
        if (this.state === state || this.state === 'view-error' || this.state === 'expired') return;
        this.state = state;
        for (const listener of this.listeners) {
            try {listener(state);} catch {console.warn('[HTTP] Status observer failed');}
        }
        const event = state === 'connected' ? new Event('nestos:http-reconnected') : state === 'view-error'
            ? new Event('nestos:http-view-error') : new CustomEvent('nestos:http-disconnected', {detail: {state}});
        window.dispatchEvent(event);
    }
    close(): void {this.listeners.clear();}
}

