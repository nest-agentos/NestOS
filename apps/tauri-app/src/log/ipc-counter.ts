export interface IpcPort {
    invoke: (command: string, ...args: unknown[]) => Promise<unknown>;
}

/** Trace-only wrapper. Count submissions, including failures, without recording payloads. */
export function countIpc(port: IpcPort) {
    const original = port.invoke;
    const counts: Record<string, number> = Object.create(null);
    const record = (command: string) => { counts[command] = (counts[command] ?? 0) + 1; };
    const invoke: IpcPort['invoke'] = (command, ...args) => {
        record(command);
        return original.call(port, command, ...args);
    };
    return {
        invoke,
        record,
        snapshot: () => ({ ...counts }),
        uncounted: (command: string, ...args: unknown[]) => original.call(port, command, ...args),
    };
}
