import type { EditorFactory } from '@nestos/ui-common-adapter';

/** The file editor is only needed when a document opens, after the VFS sidebar paints. */
export const lazyMdxEditorFactory: EditorFactory = async (container, options) =>
    (await import('@nestos/mdx-adapter')).defaultEditorFactory(container, options);
