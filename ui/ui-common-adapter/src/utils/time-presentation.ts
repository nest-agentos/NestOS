import {getLocale} from '@nestos/common';
import {setTimePresentation as presentTime} from '@nestos/ui-common';

export function setTimePresentation(element: HTMLTimeElement, value: number | null | undefined, fallback: string): void {
    presentTime(element, value, fallback, getLocale());
}
