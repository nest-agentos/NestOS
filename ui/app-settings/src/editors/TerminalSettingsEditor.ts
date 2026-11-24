import {BaseSettingsEditor} from '@nestos/ui-common-adapter';
import {FILE_BROWSER_ICONS, randomUUID, t} from '@nestos/common';
import {TerminalWidget} from '@nestos/terminal-ui';
import type {EditorOptions} from '@nestos/ui-common-adapter';
import type {ServerTerminals} from '@nestos/app-contracts/services';

export class TerminalSettingsEditor extends BaseSettingsEditor<ServerTerminals | undefined> {
    private readonly widget: TerminalWidget;
    private releaseTitleBar?: () => void;
    constructor(private readonly root: HTMLElement, service: ServerTerminals | undefined, options: EditorOptions) {
        super(root, service, options);
        this.widget = new TerminalWidget(root, service, key => t(key as Parameters<typeof t>[0]), service, randomUUID);
    }
    async render(): Promise<void> {
        this.releaseTitleBar?.();
        const rendering = this.widget.render();
        const mount = this.options.mountTitleBar;
        const body = this.root.querySelector<HTMLElement>('.terminal-widget');
        if (mount && body) {
            const menu = document.createElement('details'), summary = document.createElement('summary');
            const menuBody = document.createElement('div');
            menu.className = 'settings-terminal-menu';
            summary.innerHTML = FILE_BROWSER_ICONS.more;
            summary.setAttribute('aria-label', t('editor.moreActions'));
            menu.append(summary, menuBody);
            this.releaseTitleBar = mount(body, {menu, menuBody});
            body.querySelector('.terminal-widget__title')?.remove();
        }
        await rendering;
    }
    async destroy(): Promise<void> {
        this.releaseTitleBar?.();
        try { await this.widget.destroy(); } finally { await super.destroy(); }
    }
}
