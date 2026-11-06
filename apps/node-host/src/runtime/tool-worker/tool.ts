import type {Tool} from '@nestos/tools';
import {runToolProcess, type ToolWorkerOptions} from './process';

/** Metadata stays in the host; immutable business implementations execute only in the worker. */
export function processTool(tool: Tool, options: ToolWorkerOptions): Tool {
    const run = (phase: 'invoke' | 'reconcile', args: Record<string, unknown>, context: Parameters<Tool['call']>[1]) => {
        const work = () => runToolProcess(options, tool, phase, args, context);
        return options.group && !tool.isConcurrencySafe() ? options.group.run(context.signal, work) : work();
    };
    return new Proxy(tool, {get(target, key) {
        if (key === 'executionIsolation') return 'process';
        if (key === 'call') return (args: Record<string, unknown>, context: Parameters<Tool['call']>[1]) => run('invoke', args, context);
        if (key === 'reconcile' && target.reconcile) return (args: Record<string, unknown>, context: Parameters<Tool['call']>[1]) => run('reconcile', args, context);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
}
