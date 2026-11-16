import {defaultEditorFactory} from '../../ui/mdx-adapter/src/factory';
import {fileContentFormat} from '../../ui/app-shell/src/browser/file-format';
import type {MDxEditor} from '@nestos/mdxeditor';
import '../../libraries/mdxeditor/src/styles/index.css';

let editor: MDxEditor | undefined;
const fixture = {
    async open(path: string, content: string) {
        await editor?.destroy();
        editor = await defaultEditorFactory(document.querySelector('main')!, {
            ...fileContentFormat(path), target: {kind: 'file', path}, initialContent: content,
            hostContext: {toggleSidebar() {}, async saveContent(path, content) {
                const response = await fetch('/save', {method: 'POST', body: JSON.stringify({path, content})});
                if (!response.ok) throw new Error('FIXTURE_SAVE_REJECTED');
            }},
        }) as MDxEditor;
    },
    async mode(mode: 'edit' | 'render') {await editor!.switchToMode(mode);},
    rename(path: string) {editor!.updateDocumentPath(path);},
    async save(content: string) {editor!.setText(content); editor!.setDirty(true); await editor!.flushPendingSave();},
    replace(content: string) {editor!.setText(content);},
    async destroy() {await editor?.destroy(); editor = undefined;},
    state() {return {format: editor?.getDocumentFormat(), mode: editor?.getMode(), text: editor?.getText(), dirty: editor?.isDirty()};},
};
Object.assign(window, {htmlFixture: fixture});
