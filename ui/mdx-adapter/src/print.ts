import { DefaultPrintService as StandalonePrintService } from '@nestos/mdxeditor';
import type { IFileSystem } from '@nestos/vfs-core';
import { createAssetProvider } from './assets';

export class DefaultPrintService extends StandalonePrintService {
    constructor(fs?: IFileSystem, path?: string, assets?: IFileSystem) {
        super({ documentPath: path, assets: createAssetProvider(fs, () => path, assets) });
    }
}
