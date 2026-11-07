import type {ToolPackages} from '@nestos/app-contracts/services';
/** Keep package discovery off overview while retaining its live change subscription once opened. */
export function lazyScannerPackages(load: () => Promise<ToolPackages | undefined>, own: (release: () => void) => void): ToolPackages {
    const listeners = new Set<() => void>();
    let pending: Promise<ToolPackages | undefined> | undefined;
    const get = () => pending ??= load().then(port => {
        if (port?.onChange) own(port.onChange(() => {for (const listener of listeners) listener();}));
        return port;
    }).catch(error => {pending = undefined; throw error;});
    return {
        onChange: listener => {listeners.add(listener); return () => listeners.delete(listener);},
        list: async () => (await get())?.list() ?? [],
        ensure: async dependencies => {
            const port = await get(); if (!port) throw new Error('TOOL_PACKAGE_UNAVAILABLE');
            return port.ensure(dependencies);
        },
        switchVersion: async (...args) => {
            const port = await get(); if (!port?.switchVersion) throw new Error('TOOL_PACKAGE_SWITCH_UNAVAILABLE');
            return port.switchVersion(...args);
        },
    };
}
