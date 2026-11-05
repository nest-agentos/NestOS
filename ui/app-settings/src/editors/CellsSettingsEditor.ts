import {BaseSettingsEditor} from '@nestos/ui-common-adapter';
import type {EditorOptions} from '@nestos/ui-common-adapter';
import type {ProjectRemoteMountPort} from '@nestos/app-contracts/services';
import {escapeHTML, t} from '@nestos/common';

/** Multiple nodes share the existing project connection service and credential owner. */
export class CellsSettingsEditor extends BaseSettingsEditor<ProjectRemoteMountPort | undefined> {
    private selected?: string;
    private busy = false;
    private stop?:()=>void;
    constructor(container: HTMLElement, service: ProjectRemoteMountPort | undefined, options: EditorOptions) {super(container, service, options);}
    render(): void {
        this.stop?.();
        this.container.innerHTML = `<div class="settings-page"><h2>${escapeHTML(t('cells.title'))}</h2>
            <p>${escapeHTML(t('cells.description'))}</p><div data-cells-list></div>
            <form data-cells-form>${this.field('name')}${this.field('endpoint')}${this.field('username')}${this.field('password', 'password')}
            <button type="submit" class="settings-btn">${escapeHTML(t('cells.save'))}</button>
            <button type="button" data-cells-new class="settings-btn">${escapeHTML(t('cells.new'))}</button></form>
            <p data-cells-status role="status" aria-live="polite"></p></div>`;
        this.container.querySelector('form')!.addEventListener('submit', event => {event.preventDefault(); void this.run(() => this.save());});
        this.container.onclick = event => {
            const button = (event.target as HTMLElement).closest<HTMLElement>('button');
            if (button?.hasAttribute('data-cells-new')) {this.selected = undefined; this.form().reset();}
            const id = button?.dataset.cellsId, action = button?.dataset.cellsAction;
            if (id && action === 'edit') this.edit(id);
            if (id && action === 'check') void this.run(() => this.service!.checkConnection(id));
            if (id && action === 'remove') void this.run(async()=>{await this.service!.removeConnection(id);if(this.selected===id){this.selected=undefined;this.form().reset();}});
        };
        this.list();
        this.stop=this.service?.onChange(()=>this.list());
        if(!this.service){this.container.querySelector('[data-cells-status]')!.textContent=t('cells.unavailable');this.container.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=true);}
    }
    override async destroy():Promise<void>{this.stop?.();this.stop=undefined;this.container.onclick=null;await super.destroy();}
    private field(name: string, type = 'text'): string {
        return `<label>${escapeHTML(t(`cells.${name}` as Parameters<typeof t>[0]))}<input name="${name}" type="${type}" autocomplete="${type === 'password' ? 'new-password' : 'off'}" ${['name', 'endpoint'].includes(name) ? 'required' : ''}></label>`;
    }
    private form(): HTMLFormElement {return this.container.querySelector('form')!;}
    private list(): void {
        const target = this.container.querySelector('[data-cells-list]')!;
        target.innerHTML = (this.service?.connections() ?? []).map(node => `<div><strong>${escapeHTML(node.name)}</strong> ${escapeHTML(node.endpoint)}
            ${['edit', 'check', 'remove'].map(action => `<button type="button" class="settings-btn" data-cells-id="${escapeHTML(node.id)}" data-cells-action="${action}">${escapeHTML(t(`cells.${action}` as Parameters<typeof t>[0]))}</button>`).join('')}</div>`).join('');
    }
    private edit(id: string): void {
        const value = this.service?.connections().find(node => node.id === id); if (!value) return;
        this.selected = id;
        for (const key of ['name', 'endpoint', 'username'] as const) (this.form().elements.namedItem(key) as HTMLInputElement).value = value[key] ?? '';
        (this.form().elements.namedItem('password') as HTMLInputElement).value = '';
    }
    private async save(): Promise<void> {
        if (!this.service) throw new Error(t('cells.unavailable'));
        const data = new FormData(this.form()), value = (key: string) => String(data.get(key) ?? '');
        this.selected = await this.service.saveConnection({name: value('name'), endpoint: value('endpoint'), username: value('username') || undefined}, value('password'), this.selected);
        (this.form().elements.namedItem('password') as HTMLInputElement).value = '';
    }
    private async run(action: () => Promise<unknown>): Promise<void> {
        if (this.busy) return; this.busy = true;
        const buttons = this.container.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(button => button.disabled = true);
        const status = this.container.querySelector('[data-cells-status]')!;
        try {await action(); status.textContent = t('cells.saved'); this.list();}
        catch (error) {status.textContent = error instanceof Error ? error.message : t('cells.failed');}
        finally {this.busy = false; buttons.forEach(button => button.disabled = false);}
    }
}
