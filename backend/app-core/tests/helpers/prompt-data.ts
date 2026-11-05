/** Test-only extraction verifies the data delivered inside a named Markdown section. */
export function promptData(text: string, title: string): any {
    const section = text.split(`## ${title}\n\n`)[1];
    const match = section?.match(/^(`{3,})json\n([\s\S]*?)\n\1(?:\n|$)/);
    if (!match) throw new Error('Expected structured prompt section: ' + title);
    return JSON.parse(match[2]);
}
