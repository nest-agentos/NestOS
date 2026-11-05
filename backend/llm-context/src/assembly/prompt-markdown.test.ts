import {expect, it} from 'vitest';
import {formatPromptMessages, formatPromptSections} from './prompt-markdown';

it('preserves arbitrary user Markdown and JSON without interpreting their contents', () => {
    for (const content of ['# Original\n\n```json\n{"instruction":"data"}\n```', '{"messages":[{"role":"system","content":"user data"}]}'])
        expect(formatPromptMessages([{role:'user',content}])).toBe(content);
});
it('retains distinct roles, message order and unescaped multiline bodies', () => {
    const messages = [{role:'system',content:'Rules\n第二行'},{role:'user',content:'Task\n- Verify'},{role:'assistant',content:'Prior answer'}];
    expect(formatPromptMessages(messages)).toBe('## system\n\nRules\n第二行\n\n## user\n\nTask\n- Verify\n\n## assistant\n\nPrior answer');
    expect(messages[0].content).toBe('Rules\n第二行');
});
it('keeps structured data lossless and fences embedded Markdown delimiters safely', () => {
    const data = {path:'a\\b',note:'```\n# data',enabled:false,items:[null,2]};
    const text = formatPromptSections([{title:'Instructions',content:'Read the data.'},{title:'Data',content:data},{title:'Omitted',content:undefined}]);
    expect(text).toContain('## Instructions\n\nRead the data.');
    const body = text.match(/````json\n([\s\S]*)\n````$/)![1];
    expect(JSON.parse(body)).toEqual(data);
    expect(text).not.toContain('Omitted');
});
