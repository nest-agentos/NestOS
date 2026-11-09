/** Share one release result across editor initialization and its owning workspace. */
export function conversationLifetime<T extends {close(): Promise<void>}>(source: T): T {
    let closing: Promise<void> | undefined;
    const close = () => closing ??= Promise.resolve().then(() => source.close());
    return new Proxy(source, {
        get(target, key) {
            if (key === 'close') return close;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
