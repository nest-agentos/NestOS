import {MailWorkbench} from '@itookit/mail/ui';
import type {MailClient} from '@itookit/mail/contracts';
import {ACTION_ICONS, CHAT_ICONS, createModuleLogger, randomUUID, t} from '@itookit/common';
import {createWorkspaceModule} from '../workspaces/module';
import {VFS_DOM_EVENTS} from '@itookit/vfs-ui';
const log = createModuleLogger('mail');
export {MailWorkbench} from '@itookit/mail/ui';
interface Options {client: MailClient; sidebar: HTMLElement; editor: HTMLElement; selected(path: string): void; scanners(): Promise<void>}
export function createMailModule(options: Options) {
    const workbench = new MailWorkbench({...options, presentation: {
        text: key => t(('mail.' + key) as Parameters<typeof t>[0]), createOperationId: randomUUID,
        icons: {refresh: ACTION_ICONS.refreshView, settings: ACTION_ICONS.settings, fold: CHAT_ICONS.chevron, unfold: CHAT_ICONS.chevron, copy: CHAT_ICONS.copy},
        diagnostic: record => log.warn(record.operation, record),
    }, createEditor: async (container, content, title) => (await import('@itookit/mdxeditor')).createMDxEditor(container, {
        initialContent: content, title, initialMode: 'render', contentFormat: 'text', htmlPolicy: 'literal', readOnly: true, scrollMode: 'host',
        translate: key => t(key as Parameters<typeof t>[0]),
    }), selected: id => {options.selected(id); options.sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}));}});
    return createWorkspaceModule(workbench);
}
