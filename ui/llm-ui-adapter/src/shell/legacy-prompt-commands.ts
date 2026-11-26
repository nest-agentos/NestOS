import {ComposerHistory, parseLocalPromptCommand, SavedPrompts, type ChatMessage, type SavedPromptsPort} from '@nestos/llm-ui';
import {getLocale} from '@nestos/common';
import type {InputPlugin, InputPluginContext} from '../components/input/plugins/InputPlugin';

export class LegacyPromptCommands implements InputPlugin {
    readonly id = 'local-prompt-commands';
    readonly priority = 0;
    private context?: InputPluginContext;
    private history?: ComposerHistory;
    private saved?: SavedPrompts;
    constructor(private readonly port: () => SavedPromptsPort | undefined, private readonly messages: () => readonly ChatMessage[],
        private readonly reveal: (id: string, text: string) => void, private readonly earlier: () => Promise<void>,
        private readonly hasEarlier: () => boolean, private readonly error: () => string = () => '') {}
    activate(context: InputPluginContext): void {this.context = context;}
    onBeforeSend(text: string): boolean {return !this.handle(text);}
    onBeforeRemoteSend(text: string): boolean {return !this.handle(text);}
    handle(text: string): boolean {
        const command = parseLocalPromptCommand(text);
        if (!command || !this.context) return false;
        if (command.name === 'history') {this.saved?.close(); this.historyPanel().show(); return true;}
        this.history?.close();
        if (!command.arguments) {void this.savedPanel().open(); return true;}
        const context = this.context, revision = context.getDraftRevision?.(), value = text.trim();
        void this.savedPanel().save(command.arguments).then(saved => {
            if (saved && this.context === context && context.getText().trim() === value && context.getDraftRevision?.() === revision) context.setText('');
        });
        return true;
    }
    private historyPanel(): ComposerHistory {
        const context = this.context!;
        return this.history ??= new ComposerHistory(context.container, getLocale(), this.messages,
            text => {context.setText(text); context.focus();}, this.reveal, this.earlier, this.hasEarlier, this.error);
    }
    private savedPanel(): SavedPrompts {
        const context = this.context!;
        return this.saved ??= new SavedPrompts(context.container, getLocale(), this.port, text => {context.setText(text); context.focus();});
    }
    setActive(active: boolean): void {if (!active) {this.history?.close(); this.saved?.close();}}
    deactivate(): void {this.history?.destroy(); this.saved?.destroy(); this.history = undefined; this.saved = undefined; this.context = undefined;}
}
