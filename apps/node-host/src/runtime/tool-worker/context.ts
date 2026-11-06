import type {ToolUseContext} from '@nestos/tools';

/** The parent remains the sole storage/authorization owner; workers receive only this call's ports. */
export function workerContext(context: ToolUseContext): Omit<ToolUseContext, 'signal' | 'abortController'> {
    const check = () => context.signal?.throwIfAborted(), files = context.vfs;
    const vfs = files ? {
        readFile: async (path: string, options?: {maxBytes?: number}) => {check(); return files.readFile(path, options);},
        writeFile: async (path: string, value: string) => {check(); await files.writeFile(path, value);},
        listFiles: async (path?: string, options?: Parameters<typeof files.listFiles>[1]) => {check(); return files.listFiles(path, {...options, signal: context.signal});},
        ...(files.walkFiles ? {walkFiles: (path?: string, options?: Parameters<NonNullable<typeof files.walkFiles>>[1]) => {
            check(); return files.walkFiles!(path, {...options, signal: context.signal});}} : {}),
        ...(files.stat ? {stat: async (path: string) => {check(); return files.stat!(path);}} : {}),
        ...(files.readBinaryFile ? {readBinaryFile: async (path: string, options?: {maxBytes?: number}) => {check(); return files.readBinaryFile!(path, options);}} : {}),
        ...(files.writeBinaryFile ? {writeBinaryFile: async (path: string, bytes: Uint8Array) => {check(); await files.writeBinaryFile!(path, bytes);}} : {}),
    } : undefined;
    const {signal: _signal, abortController: _abortController, shell, ...rest} = context;
    const callbacks = Object.fromEntries(['readAsset', 'writeAsset', 'getAssetRecord', 'putAssetRecord', 'onProgress', 'setAppState'].filter(name => typeof rest[name as keyof typeof rest] === 'function')
        .map(name => [name, (...args: unknown[]) => {check(); return (rest[name as keyof typeof rest] as (...args: unknown[]) => unknown)(...args);} ]));
    return {...rest, ...callbacks, ...(vfs ? {vfs} : {}), ...(shell ? {shell: {capabilities: shell.capabilities, exec: (command: string, args: string[], options?: Parameters<typeof shell.exec>[2]) => {
        check(); return shell.exec(command, args, {...options, signal: context.signal});
    }}} : {})};
}
