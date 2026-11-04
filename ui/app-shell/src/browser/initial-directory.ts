import type { IFileSystem } from '@nestos/vfs-core';
import type { NavigationDirectory } from '@nestos/app-contracts/services';
import { directorySnapshot } from './directory-snapshot';

/** Root-navigation convenience over the shared, single-use metadata seed. */
export function withInitialDirectory(fs: IFileSystem, initial: NavigationDirectory): IFileSystem {
    const snapshot = directorySnapshot(fs);
    snapshot.seed([{ ...initial, path: '/' }]);
    return snapshot.files;
}
