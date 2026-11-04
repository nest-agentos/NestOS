import {MailWorkbench} from '@nestos/mail/ui';
import type {MailClient} from '@nestos/mail/contracts';
import {ACTION_ICONS, CHAT_ICONS, createModuleLogger, randomUUID, t} from '@nestos/common';
import {createWorkspaceModule} from '../workspaces/module';
import {VFS_DOM_EVENTS} from '@nestos/vfs-ui';
const log = createModuleLogger('mail');
export {MailWorkbench} from '@nestos/mail/ui';
interface Options {client: MailClient; sidebar: HTMLElement; editor: HTMLElement; selected(path: string): void; scanners(): Promise<void>}
export function createMailModule(options: Options) {
    const workbench = new MailWorkbench({...options, presentation: {
        text: key => t(('mail.' + key) as Parameters<typeof t>[0]), createOperationId: randomUUID,
        icons: {refresh: ACTION_ICONS.refreshView, settings: ACTION_ICONS.settings, fold: CHAT_ICONS.chevron, unfold: CHAT_ICONS.chevron, copy: CHAT_ICONS.copy},
        diagnostic: record => log.warn(record.operation, record),
    }, createEditor: async (container, content, title) => (await import('@nestos/mdxeditor')).createMDxEditor(container, {
        initialContent: content, title, initialMode: 'render', contentFormat: 'text', htmlPolicy: 'literal', readOnly: true, scrollMode: 'host',
        translate: key => t(key as Parameters<typeof t>[0]),
    }), selected: id => {options.selected(id); options.sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}));}});
    return createWorkspaceModule(workbench);
}
