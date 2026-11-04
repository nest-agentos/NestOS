import {OcrReviewPanel as ReviewPanel} from '@nestos/llm-ui';
import {getLocale} from '@nestos/common';
export type {OcrReviewCallbacks} from '@nestos/llm-ui';

export class OcrReviewPanel extends ReviewPanel {
    constructor(container: HTMLElement) {super(container, {locale: getLocale()});}
}
