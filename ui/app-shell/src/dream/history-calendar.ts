import {getLocale, t} from '@nestos/common';
import type {DreamService} from '@nestos/app-contracts/services';
import {dateKey, monthDays} from '../calendar/model';

type History = Awaited<ReturnType<DreamService['history']>>;

export class DreamHistoryCalendar {
    readonly element = document.createElement('section');
    private readonly heading = document.createElement('h3');
    private readonly grid = document.createElement('div');
    private readonly agenda = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly more: HTMLButtonElement;
    private readonly formatDay: Intl.DateTimeFormat;
    private readonly items: History['items'];
    private readonly weekdays = weekdayLabels();
    private cursor?: number;
    private month: Date;
    private selected: string;

    constructor(initial: History, timeZone: string | undefined, private readonly load: (before: number) => Promise<History>,
        private readonly show: (items: History['items'], section: HTMLElement) => void) {
        this.formatDay = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});
        this.selected = this.day(Date.now());
        this.month = new Date(this.selected.slice(0, 7) + '-01T12:00:00');
        this.items = [...initial.items];
        this.cursor = initial.nextCursor;
        this.more = control(t('dream.moreHistory'), () => this.loadMore());
        this.status.setAttribute('role', 'status');
        this.grid.className = 'calendar__grid';
        this.element.append(this.heading, control(t('calendar.previous'), () => this.move(-1)),
            control(t('calendar.next'), () => this.move(1)), this.grid, this.agenda, this.more, this.status);
        this.render();
    }

    private day(timestamp: number): string {
        const fields = this.formatDay.formatToParts(timestamp);
        return ['year', 'month', 'day'].map(key => fields.find(field => field.type === key)?.value).join('-');
    }

    private move(delta: number): void {
        this.month = new Date(this.month.getFullYear(), this.month.getMonth() + delta, 1, 12);
        this.selected = dateKey(this.month);
        this.render();
    }

    private async loadMore(): Promise<void> {
        if (!this.cursor) return;
        this.more.disabled = true;
        this.status.textContent = '';
        try {
            const page = await this.load(this.cursor);
            this.items.push(...page.items);
            this.cursor = page.nextCursor;
            this.render();
        } catch {
            this.status.textContent = t('dream.historyReadFailed');
        } finally {
            this.more.disabled = false;
        }
    }

    private render(): void {
        this.heading.textContent = this.month.toLocaleDateString(getLocale(), {year: 'numeric', month: 'long'});
        const byDay = new Map<string, History['items']>();
        for (const item of this.items) {
            const day = this.day(item.startedAt), runs = byDay.get(day) ?? [];
            runs.push(item); byDay.set(day, runs);
        }
        this.grid.replaceChildren(...this.weekdays, ...monthDays(this.month).map(day => this.cell(day, byDay.get(day)?.length ?? 0)));
        const runs = byDay.get(this.selected) ?? [];
        const date = document.createElement('h4');
        date.textContent = this.selected;
        this.agenda.replaceChildren(date);
        if (runs.length) this.show(runs, this.agenda);
        else this.agenda.append(t(this.cursor ? 'dream.historyPartial' : 'dream.historyEmpty'));
        this.more.hidden = !this.cursor;
    }

    private cell(day: string, count: number): HTMLElement {
        const date = Number(day.slice(-2));
        const button = control(count ? `${date} · ${count}` : String(date), () => {
            this.selected = day;
            this.render();
            this.grid.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
        });
        button.className = 'calendar__date';
        button.setAttribute('aria-label', count ? `${day} · ${count}` : day);
        button.setAttribute('aria-pressed', String(day === this.selected));
        const cell = document.createElement('div');
        cell.className = 'calendar__day';
        cell.dataset.outside = String(Number(day.slice(5, 7)) !== this.month.getMonth() + 1);
        cell.dataset.selected = String(day === this.selected);
        cell.append(button);
        return cell;
    }
}

function weekdayLabels(): HTMLElement[] {
    const format = new Intl.DateTimeFormat(getLocale(), {weekday: 'short'});
    return Array.from({length: 7}, (_, day) => {
        const label = document.createElement('span');
        label.className = 'calendar__weekday';
        label.textContent = format.format(new Date(2024, 0, 1 + day, 12));
        return label;
    });
}

function control(label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label;
    button.onclick = () => {void run();};
    return button;
}
