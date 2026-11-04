import {ContentView} from '@nestos/mdxeditor';
import type {MailThreadPage} from '../contracts';
import {element, type MailPresentation, type MailReader} from './ports';
export type Message = MailThreadPage['messages'][number];
export interface MessageView {message: Message; card: HTMLElement; content: ContentView; body: HTMLElement; reader?: MailReader}
export function messageCard(message: Message, p: MailPresentation, expanded: boolean, onToggle: () => void): MessageView {
    const content = new ContentView({title: message.from, subtitle: message.subject,
        preview: message.body.replace(/\s+/g, ' ').trim().slice(0, 180),
        avatar: Array.from(message.from.trim().replace(/^["'<]+/, ''))[0]?.toLocaleUpperCase() ?? '',
        variant: 'card', expanded, locale: p.locale, labels: {expand: p.text('unfold'), collapse: p.text('fold'), details: p.text('timeDetails'), copy: p.text('copyMessage'), more: p.text('more')}, onToggle});
    const card = content.element; card.classList.add('mail__message');
    content.setTimes(message.date ? {label: p.text('date'), value: message.date} : undefined);
    const metadata = element('dl', 'mail__metadata');
    for (const [key, value] of [['from', message.from], ['to', message.to], ['account', `${message.source.provider} / ${message.source.account}`]])
        metadata.append(element('dt', '', p.text(key)), element('dd', '', value));
    content.metadata.append(metadata);
    return {message, card, content, body: content.body};
}
export function copyMessage(message: Message, t: MailPresentation['text']): string {
    return [message.subject, `${t('from')}: ${message.from}`, `${t('to')}: ${message.to}`,
        `${t('account')}: ${message.source.provider} / ${message.source.account}`,
        `${t('date')}: ${message.date ? new Date(message.date).toLocaleString() : ''}`, '', message.body].join('\n');
}
