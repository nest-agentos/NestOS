import { createMDXFile, FSError, guessMimeType, pathUtils, type IFileSystem } from '@nestos/vfs-core';
import type { AssetProvider } from '@nestos/mdxeditor';

/** Reject traversal before forwarding a relative attachment name to a granted view. */
function assetName(name: string): string {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Invalid attachment name');
    }
    return name;
}

function documentImagePath(fs: IFileSystem, document: string, reference: string): string {
    const address = reference.split(/[?#]/, 1)[0]!;
    if (!address || /^(?:[a-z][a-z0-9+.-]*:|\/|@asset\/)/i.test(address)) throw new FSError('EINVAL', 'Invalid relative image path');
    const boundary = fs.discoveryRoot?.(document) ?? '/';
    const minimumDepth = pathUtils.depth(boundary);
    const parts = pathUtils.segments(pathUtils.dirname(document));
    for (const encoded of address.split('/')) {
        const part = decodeURIComponent(encoded);
        if (/[\/\\\0]/.test(part)) throw new FSError('EINVAL', 'Invalid relative image path');
        if (part === '..') {
            if (parts.length <= minimumDepth) throw new FSError('EACCES', 'Image path leaves the document view');
            parts.pop();
        } else if (part && part !== '.') parts.push(part);
    }
    const path = '/' + parts.join('/');
    if (!pathUtils.isUnder(path, boundary) || (fs.discoveryRoot?.(path) ?? '/') !== boundary) {
        throw new FSError('EACCES', 'Image path leaves the document view');
    }
    return path;
}

async function readDocumentImage(fs: IFileSystem, document: string, reference: string, signal: AbortSignal) {
    const path = documentImagePath(fs, document, reference);
    const mimeType = /\.avif$/i.test(path) ? 'image/avif' : guessMimeType(path);
    if (!mimeType.startsWith('image/')) throw new FSError('EINVAL', 'Unsupported document image type');
    const data = await fs.driver.readContent(path, { encoding: 'binary', signal });
    return { data, mimeType };
}

export function createAssetProvider(fs?: IFileSystem, documentPath: () => string | undefined = () => undefined,
    assets?: IFileSystem): AssetProvider | undefined {
    if (!assets && (!fs || !documentPath())) return undefined;
    return {
        readDocumentImage: fs && documentPath() ? (reference, signal) => readDocumentImage(fs, documentPath()!, reference, signal) : undefined,
        read: name => assets ? assets.driver.readContent('/' + assetName(name), { encoding: 'binary' }) as Promise<ArrayBuffer>
            : createMDXFile(fs!, documentPath()!).asset(assetName(name)).read(),
        upload: async (name, content) => {
            const node = assets ? await assets.driver.createFile({ parentPath: '/', name: assetName(name), content })
                : await fs!.meta.assets.putAsset(documentPath()!, assetName(name), content);
            return { name: node.name };
        },
        prune: () => fs && documentPath() ? createMDXFile(fs, documentPath()!).pruneUnusedAssets() : Promise.resolve(0),
        mimeType: guessMimeType,
    };
}
