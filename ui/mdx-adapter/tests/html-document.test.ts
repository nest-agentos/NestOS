// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {MDxRenderer} from '@nestos/mdxeditor';
import {HtmlPreview} from '../../../libraries/mdxeditor/src/editor/html-preview';
import {defaultEditorFactory, resolveDocumentFormat} from '../src/factory';

beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    vi.spyOn(HtmlPreview.prototype, 'render').mockResolvedValue();
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();});

it('uses the isolated path and preserves raw HTML through save failures and retry', async () => {
    const render = vi.spyOn(MDxRenderer.prototype, 'render'), save = vi.fn().mockRejectedValueOnce(Error('FIXTURE_CONFLICT')).mockResolvedValue(undefined);
    const original = '<!DOCTYPE html>\n<style>p{color:red}</style><script>count++</script>';
    const editor = await defaultEditorFactory(document.createElement('div'), {target: {kind: 'file', path: '/page.HtM'}, initialContent: original,
        hostContext: {toggleSidebar() {}, saveContent: save}});
    try {
        expect(editor.getMode()).toBe('render'); expect(render).not.toHaveBeenCalled();
        await editor.switchToMode('edit'); editor.setText(original + '<p>changed</p>'); editor.setDirty(true);
        await expect(editor.flushPendingSave()).rejects.toThrow(); expect(editor.isDirty()).toBe(true);
        await editor.flushPendingSave(); expect(save).toHaveBeenLastCalledWith('/page.HtM', original + '<p>changed</p>');
        expect(editor.isDirty()).toBe(false); expect(editor.getText()).toBe(original + '<p>changed</p>');
    } finally {await editor.destroy();}
});

it('recomputes host aliases when entering and leaving HTML without rewriting content', async () => {
    const resolveContentFormat = (path: string) => /\.html?$/i.test(path) ? 'html' as const : /\.mind$/.test(path) ? 'markdown' as const : 'text' as const;
    const editor = await defaultEditorFactory(document.createElement('div'), {target: {kind: 'file', path: '/page.mind'},
        initialContent: 'raw', contentFormat: 'markdown', resolveContentFormat});
    try {
        editor.updateNodeId('/page.HTML'); expect(editor.getDocumentFormat()).toBe('html'); expect(editor.getMode()).toBe('render');
        editor.updateNodeId('/page.txt'); expect(editor.getDocumentFormat()).toBe('text'); expect(editor.getMode()).toBe('edit');
        editor.updateNodeId('/page.htm'); expect(editor.getDocumentFormat()).toBe('html'); expect(editor.getMode()).toBe('render');
        editor.updateNodeId('/page.mind'); expect(editor.getDocumentFormat()).toBe('markdown');
        expect(editor.getText()).toBe('raw'); expect(editor.isDirty()).toBe(false);
    } finally {await editor.destroy();}
    expect(resolveDocumentFormat({target: {kind: 'file', path: '/raw.HTML'}})).toBe('html');
});
