import type {Tool} from '@nestos/tools';
import {createModuleLogger} from '@nestos/common';
const log = createModuleLogger('tool-packages');

/** Disposal must never turn a committed business result into an execution failure. */
export async function disposePackageTools(tools: Iterable<Tool>, stage: string): Promise<void> {
    const results = await Promise.allSettled([...new Set(tools)].map(tool => Promise.resolve().then(() => tool.dispose?.())));
    const failures = results.filter(result => result.status === 'rejected').length;
    if (failures) log.warn('tool.package.dispose', {stage, result: 'failure', code: 'TOOL_PACKAGE_DISPOSE_FAILED', count: failures});
}
