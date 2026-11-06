import {getLocale, t} from '@nestos/common';
import {getPreviewText} from '@nestos/llm-ui';
import type {SessionGroup} from '@nestos/llm-session/contracts';
/** Host policy: only user input windows participate in the navigation index. */
export function promptWindowName(group: SessionGroup): string | undefined {
    if (group.role !== 'user') return undefined;
    const time = group.timestamp ? new Date(group.timestamp).toLocaleString(getLocale()) : '';
    return [time, getPreviewText(group.content ?? '', 160) || t('chat.promptNav.attachment')].filter(Boolean).join(' · ');
}
