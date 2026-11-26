import type {ConversationSlashCommand} from '../../../contracts';
import {createModuleLogger, getLocale, randomUUID, t} from '@nestos/common';

import type {InputPlugin, InputPluginContext} from './InputPlugin';
import {commandCompletionQuery, localPromptCommandSuggestions, PopupPanel} from '@nestos/llm-ui';

type CommandSuggestion = Pick<ConversationSlashCommand, 'name' | 'description' | 'argumentHint' | 'disabled'>;
const log = createModuleLogger('slash-suggestions');

/** Catalogs supply suggestions; sending and acceptance stay with the controller. */
export class SlashSuggestionsPlugin implements InputPlugin {
    readonly id: string = 'slash-suggestions';
    readonly priority = 40;
    private context?: InputPluginContext;
    private panel?: PopupPanel;
    private generation = 0;
    private cached?: {at: number; commands: CommandSuggestion[]};
    private pending?: Promise<CommandSuggestion[]>;
    constructor(private readonly load: () => Promise<CommandSuggestion[]>, private readonly enabled: () => boolean = () => true,
        private readonly local: readonly CommandSuggestion[] = []) {}
    activate(context: InputPluginContext): void {
        this.context = context;
        this.panel = new PopupPanel(context.textarea, {locale: getLocale(), positionAnchor: context.textarea.closest<HTMLElement>('.llm-input') ?? undefined, variant: 'slash', maxVisible: 12, showSearch: false,
            emptyText: t('slash.panel.empty'), footerHint: t('slash.panel.footer')});
    }
    onInput(text: string): void {
        ++this.generation;
        const query = commandCompletionQuery(text);
        if (!this.enabled() || query === undefined) {this.cached = undefined; this.panel?.hide(); return;}
        if (this.cached && Date.now() - this.cached.at < 1000) {this.show(query, this.cached.commands); return;}
        this.show(query, []);
        const generation = this.generation;
        void this.read().then(commands => {
            if (generation !== this.generation || !this.context || !this.enabled()) return;
            this.show(query, commands);
        }).catch(() => {if (generation === this.generation) this.show(query, []);});
    }
    private show(query: string, commands: CommandSuggestion[]): void {
        if (!this.panel) return;
        const rows = [...this.local, ...commands.filter(command => !command.disabled && !this.local.some(local => local.name === command.name))];
        if (!rows.length) {this.panel.hide(); return;}
        const items = rows.map(command => ({id: command.name, label: '/' + command.name, description: command.description, shortcut: command.argumentHint}));
        if (this.panel.isVisible) this.panel.updateItems(items, query);
        else this.panel.show(items, {onSelect: item => {
            this.context?.setText('/' + item.id + ' '); this.context?.focus();
        }, onClose: () => {++this.generation;}}, query);
    }
    private read(): Promise<CommandSuggestion[]> {
        if (this.pending) return this.pending;
        const operationId = randomUUID(), started = Date.now();
        const pending = this.load().then(commands => {
            if (this.context) this.cached = {at: Date.now(), commands};
            log.debug('chat.slash.catalog', {operationId, stage: 'read', result: 'success', count: commands.length, durationMs: Date.now() - started});
            return commands;
        }, error => {
            const code = (error as {remoteCode?: unknown; code?: unknown})?.remoteCode ?? (error as {code?: unknown})?.code;
            log.warn('chat.slash.catalog', {operationId, stage: 'read', result: 'failure', durationMs: Date.now() - started,
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SLASH_CATALOG_READ_FAILED'});
            throw error;
        }).finally(() => {if (this.pending === pending) this.pending = undefined;});
        this.pending = pending; return pending;
    }
    onKeyDown(event: KeyboardEvent): boolean {
        if (!this.enabled()) {this.panel?.hide(); return false;}
        if (event.key === 'Escape' && this.context?.getText().startsWith('/')) {
            ++this.generation; this.panel?.hide(); event.preventDefault(); return true;
        }
        return this.panel?.isVisible ? this.panel.handleKeyDown(event) : false;
    }
    onBlur(): void {++this.generation; this.cached = undefined; this.panel?.hide();}
    deactivate(): void {++this.generation; this.cached = undefined; this.panel?.destroy(); this.panel = undefined; this.context = undefined;}
}

export class NativeSlashCommandPlugin extends SlashSuggestionsPlugin {
    override readonly id = 'native-slash-commands';
    constructor(load: () => Promise<CommandSuggestion[]>, enabled?: () => boolean) {
        super(load, enabled, localPromptCommandSuggestions(getLocale()));
    }
}
