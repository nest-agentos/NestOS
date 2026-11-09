import { createModuleLogger, randomUUID, t } from '@nestos/common';
import type { MenuItem } from '@nestos/ui-common-adapter';
import { createMoveOperation, type VFSNodeUI } from '@nestos/vfs-ui';
import { showNameDialog } from '../files/project-dialog';
import { drawerField } from './drawer-field';
import { DRAWER_KINDS, drawerKind, ungroupedId, type Drawer, type DrawerKind } from '@nestos/app-contracts';
import type { ToolboxDrawers } from '@nestos/app-contracts/services';
import { toolboxKind } from './routes';
import {OrganizeItems} from './organize-items';

interface Options {
    groups: ToolboxDrawers; signal: AbortSignal; refresh(): void;
    create(group: Drawer): Promise<unknown>; title(path: string): string;
    kinds?: readonly DrawerKind[];
    remove?(paths: string[], signal: AbortSignal): Promise<import('@nestos/vfs-ui').DeleteResult>;
    canRemove?(paths: string[]): boolean;
}
const log = createModuleLogger('toolbox-drawers');
export class DrawerActions {
    constructor(private readonly options: Options) {}
    menu(item: VFSNodeUI): MenuItem<VFSNodeUI>[] {
        const group = this.options.groups.get(item.id), kind = toolboxKind(item.id);
        const action = (id: 'moveDrawer' | 'organize' | 'new' | 'renameDrawer' | 'deleteDrawer', run: () => Promise<unknown>): MenuItem<VFSNodeUI> => ({ id, label: t(`toolbox.${id}`),
            onClick: async () => { await run(); } });
        if (!group) return drawerKind(kind) ? [action('moveDrawer', () => this.move(kind, [item.id]))] : [];
        const items = [group.kind === 'tools' ? action('organize', () => this.move(group.kind, group.paths))
            : action('new', () => this.options.create(group))];
        if (group.id !== ungroupedId(group.kind)) items.push(
            action('renameDrawer', () => showNameDialog(t('toolbox.renameDrawer'), t('toolbox.drawer'), this.options.signal,
                async name => { await this.options.groups.rename(group, name); this.options.refresh(); }, undefined,
                { initialName: group.name, confirmLabel: t('toolbox.save') })),
            action('deleteDrawer', async () => {
                if (!await Promise.resolve(confirm(t('toolbox.deleteDrawerHint', { name: group.name })))) return;
                await this.options.groups.remove(group); this.options.refresh();
            }));
        return items;
    }
    async move(kind: DrawerKind, selected: string[] = []): Promise<void> {
        const kinds = this.options.kinds ?? DRAWER_KINDS;
        if (!kinds.length || this.options.signal.aborted) return;
        if (!kinds.includes(kind)) {kind = kinds[0]; selected = [];}
        const controller = new AbortController(), abort = () => controller.abort();
        this.options.signal.addEventListener('abort', abort, {once: true});
        try {await this.organize(kind, selected, kinds, controller.signal);}
        finally {controller.abort(); this.options.signal.removeEventListener('abort', abort);}
    }
    private async organize(kind: DrawerKind, selected: string[], kinds: readonly DrawerKind[], signal: AbortSignal): Promise<void> {
        const {groups} = this.options, picker = drawerField(groups);
        picker.update(kind, selected.length === 1 ? groups.forPath(selected[0])?.name : '');
        const extra = document.createElement('div'); extra.append(picker.field);
        const items = new OrganizeItems({...this.options, signal, paths: kind => groups.list(kind).flatMap(group => group.paths)});
        extra.append(items.element);
        const category = document.createElement('label'); category.textContent = t('toolbox.type');
        const select = document.createElement('select'); select.name = 'kind'; category.append(select); extra.prepend(category);
        for (const value of kinds) {
            const option = document.createElement('option'); option.value = value; option.textContent = t(`toolbox.${value}`); select.append(option);
        }
        select.value = kind; items.setKind(kind, selected);
        select.onchange = () => {if (select.disabled || signal.aborted) return; kind = select.value as DrawerKind; picker.update(kind); items.setKind(kind);};
        await showNameDialog(t('toolbox.organize'), t('toolbox.drawer'), signal, async () => {
            const chosen = items.selected();
            if (!chosen.length) throw new Error(t('toolbox.selectMove'));
            await this.moveItems(chosen, picker.input.value, signal);
        }, extra, { hideName: true, confirmLabel: t('toolbox.moveDrawer') });
    }
    async moveSelection(kind: DrawerKind, selected: readonly string[], validate: () => Promise<void>): Promise<void> {
        const paths = [...selected], picker = drawerField(this.options.groups);
        picker.update(kind, paths.length === 1 ? this.options.groups.forPath(paths[0])?.name : '');
        const extra = document.createElement('div'), count = document.createElement('p');
        count.textContent = t('toolbox.moveSelectionCount', {count: paths.length}); extra.append(count, picker.field);
        await showNameDialog(t('toolbox.moveDrawer'), t('toolbox.drawer'), this.options.signal, async () => {
            await validate(); await this.moveItems(paths, picker.input.value);
        }, extra, {hideName: true, confirmLabel: t('toolbox.moveDrawer')});
    }
    private readonly moveItems = async (paths: string[], name: string, signal = this.options.signal): Promise<void> => {
        const move = createMoveOperation<string[], string>({
            resolve: (ids, destination) => ({ batches: [{ ids, execute: async selected => {
                await this.assign(selected, destination);
                return 'completed';
            } }] }),
            completed: () => this.options.refresh(),
        });
        await move({ selection: paths, destination: name }, signal);
    };
    private async assign(paths: string[], name: string): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        const metadata = {operation: 'toolbox.drawer.move', operationId, stage: 'persist', count: paths.length};
        log.info('drawer.move', {...metadata, result: 'start'});
        try {
            await this.options.groups.assign(paths.map(path => ({path, name})));
            log.info('drawer.move', {...metadata, result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.error('drawer.move', {...metadata, result: 'failure', durationMs: Date.now() - started,
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'TOOLBOX_DRAWER_ASSIGN_FAILED',
                errorType: error instanceof Error ? error.name : 'Unknown'});
            throw error;
        }
    }
}
