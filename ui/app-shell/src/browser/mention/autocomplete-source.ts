import type {IAutocompleteSource, Suggestion} from '@nestos/vfs-ui';
/**
 * @file app-shell/src/browser/mention/autocomplete-source.ts
 * Editor mention integration built on shared autocomplete contracts.
 * HoverPreviewData is defined in @nestos/common and re-exported here for convenience.
 */

import type { HoverPreviewData } from '@nestos/common';

export type { HoverPreviewData };


export type { Suggestion } from '@nestos/vfs-ui';

export abstract class IMentionSource implements IAutocompleteSource {
    abstract getSuggestions(query: string): Promise<Suggestion[]>;
    abstract readonly key: string;
    public triggerChar: string = '@';

    async getDataForProcess(_targetURL: URL): Promise<unknown | null> { return null; }
    async handleClick(_targetURL: URL): Promise<void> {}
    async getHoverPreview(_uri: string): Promise<HoverPreviewData | null> { return null; }
    async getContentForTransclusion(_targetURL: URL): Promise<string | null> { return null; }
}
