import {t} from '@nestos/common';
import type {WindowTimes} from '@nestos/app-contracts/services';

const dateTime = new Intl.DateTimeFormat(undefined, {dateStyle: 'short', timeStyle: 'medium'});

export const windowTimeFields = ['accessedAt', 'modifiedAt', 'createdAt'] as const;
export type WindowTimeField = typeof windowTimeFields[number];

export function compareWindows(a: WindowTimes & {pinned: boolean}, b: WindowTimes & {pinned: boolean}, field: WindowTimeField): number {
    return Number(b.pinned) - Number(a.pinned) || (b[field] ?? -1) - (a[field] ?? -1);
}

export function appendWindowTimes(text: Element, window: WindowTimes): void {
    for (const field of windowTimeFields) {
        const value = window[field];
        const line = document.createElement('small');
        const time = document.createElement('time');
        if (value !== undefined) {
            const date = new Date(value);
            time.dateTime = date.toISOString();
            time.textContent = dateTime.format(date);
        } else time.textContent = '—';
        line.append(t(`workbench.${field}`), ' · ', time);
        text.append(line);
    }
}

export function readWindowTimes(window: WindowTimes): WindowTimes {
    const times: WindowTimes = {};
    for (const field of windowTimeFields) {
        const value = window[field];
        if (value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15) times[field] = value;
    }
    return times;
}
