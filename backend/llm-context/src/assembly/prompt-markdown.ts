/** Explicit host-authored sections; arbitrary user text is never parsed or rewritten. */
export interface PromptSection {title: string; content: unknown}

export function formatPromptSections(sections: readonly PromptSection[]): string {
    return sections.filter(section => section.content !== undefined).map(section => {
        const body = typeof section.content === 'string' ? section.content : jsonBlock(section.content);
        return `## ${section.title.replace(/[\r\n]+/g, ' ')}\n\n${body}`;
    }).join('\n\n');
}

/** Text-only transports retain message order and explicit role boundaries. */
export function formatPromptMessages(messages: readonly {role: string; content: string}[]): string {
    if (messages.length === 1 && messages[0].role === 'user') return messages[0].content;
    return formatPromptSections(messages.map(message => ({title: message.role, content: message.content})));
}

function jsonBlock(value: unknown): string {
    const body = JSON.stringify(value, null, 2);
    if (body === undefined) throw new Error('PROMPT_DATA_INVALID');
    const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), match => match[0].length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}json\n${body}\n${fence}`;
}
