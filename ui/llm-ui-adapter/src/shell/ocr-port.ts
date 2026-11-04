import {createModuleLogger} from '@nestos/common';
import type {OcrControls} from '@nestos/app-contracts/services';
import type {OcrPort} from '@nestos/llm-ui';

/** Bind recognition and authorized asset reads; llm-ui owns the interaction. */
export function chatOcrPort(controls: OcrControls | undefined, read: NonNullable<OcrPort['read']>): OcrPort | undefined {
    if (!controls) return;
    const log = createModuleLogger('chat-ocr');
    return {recognize: (image, signal) => controls.recognize(image, signal), read,
        onDiagnostic: event => {if (event.result === 'failure') log.warn('chat.ocr', event); else log.info('chat.ocr', event);}};
}
