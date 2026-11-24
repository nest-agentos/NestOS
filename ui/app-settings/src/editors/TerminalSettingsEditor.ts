import {BaseSettingsEditor} from '@nestos/ui-common-adapter';
import {randomUUID, t} from '@nestos/common';
import {TerminalWidget} from '@nestos/terminal-ui';
import type {EditorOptions} from '@nestos/ui-common-adapter';
import type {ServerTerminals} from '@nestos/app-contracts/services';

export class TerminalSettingsEditor extends BaseSettingsEditor<ServerTerminals | undefined> {
    private readonly widget: TerminalWidget;
    constructor(container: HTMLElement, service: ServerTerminals | undefined, options: EditorOptions) {
        super(container, service, options);
        this.widget = new TerminalWidget(container, service, key => t(key as Parameters<typeof t>[0]), service, randomUUID);
    }
    async render(): Promise<void> { await this.widget.render(); }
    async destroy(): Promise<void> { try { await this.widget.destroy(); } finally { await super.destroy(); } }
}
