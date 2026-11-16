import { expect, it } from 'vitest';
import { fileContentFormat } from '../src/browser/file-format';

it('preserves registered Markdown aliases and treats other files as source text', () => {
    for (const path of ['/AGENTS.md', '/notes.MD', '/a.markdown', '/a.mdx', '/lesson.prj', '/notes.mind', '/a.email', '/a.private']) {
        expect(fileContentFormat(path)).toMatchObject({ contentFormat: 'markdown' });
    }
    for (const path of ['/pnpm-lock.yaml', '/package.json', '/error.log', '/a.txt', '/a.custom', '/LICENSE', '/.gitignore', '/a.flow', '/a.agent']) {
        expect(fileContentFormat(path)).toMatchObject({ contentFormat: 'text' });
    }
});

it('uses host declarations only in their owning scope', () => {
    expect(fileContentFormat('/a.custom', [{ extensions: ['.custom'], contentFormat: 'markdown' }])).toMatchObject({ contentFormat: 'markdown' });
    expect(fileContentFormat('/a.custom')).toMatchObject({ contentFormat: 'text' });
});

it('recognizes HTML suffixes and recalculates host aliases after rename', () => {
    const format = fileContentFormat('/page.HtMl');
    expect(format.contentFormat).toBe('html');
    expect(format.resolveContentFormat!('/page.hTM')).toBe('html');
    expect(format.resolveContentFormat!('/page.txt')).toBe('text');
    expect(format.resolveContentFormat!('/page.mind')).toBe('markdown');
});
