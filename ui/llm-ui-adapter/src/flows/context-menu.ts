import { ACTION_ICONS, t } from '@nestos/common';
import { Toast, type ContextMenuConfig } from '@nestos/ui-common-adapter';
import type { FlowLauncher, FlowRunOptions } from './run-flow';
import {flowIdFromNodeId} from './flow-node-id';
import { restoreFlowLibrary } from './library';
import type { FlowDraft } from '@nestos/llm-flow/contracts';

export interface FlowContextMenuOptions extends FlowRunOptions { library?: readonly FlowDraft[]; }

export interface FlowMenuNode { id: string; type: 'file' | 'directory'; }

/** Storage remains in the host's flows directory; UI only invokes commands. */
export function createFlowContextMenuConfig<TNode extends FlowMenuNode>(options: FlowContextMenuOptions): ContextMenuConfig<TNode> {
    let launcher: FlowLauncher | undefined;
    let restoring = false;
    return { items(node, defaults) {
        if (options.library?.length && node.type === 'directory' && ['/', '/@flows'].includes(node.id)) return [...defaults,
            { id: 'flow:restore', label: t('flow.library.restore'), onClick: async () => {
                if (restoring) return;
                restoring = true;
                try {
                    const count = await restoreFlowLibrary(options.commands, options.library!);
                    Toast.success(t('flow.library.restored', { count }));
                } catch (error) { Toast.error(String(error)); }
                finally { restoring = false; }
            } }];
        const id = node.type === 'file' ? flowIdFromNodeId(node.id) : null;
        if (!id) return defaults;
        return [{ id: 'flow:run', label: t('flow.launch.run'), iconHTML: `<span class="flow-run-icon">${ACTION_ICONS.run}</span>`,
            onClick: async () => {
                try {launcher ??= new (await import('./run-flow')).FlowLauncher(options); await launcher.run(id); }
                catch (error) { Toast.error(error instanceof Error ? error.message : t('flow.launch.failed')); }
            } }, ...(defaults.length ? [{ type: 'separator' as const }, ...defaults] : [])];
    } };
}
