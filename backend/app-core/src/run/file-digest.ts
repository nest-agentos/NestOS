import {sha256HexSync} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import {failure} from './prompt-bundle';

/** Verify bounded immutable bytes; artifact manifests are not prompt documents. */
export async function verifyFileDigest(fs: IFileSystem, path: string, digest: string, maxBytes: number, operationId?: string): Promise<void> {
    const started = Date.now(); let stage = 'stat', size: number | undefined;
    try {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw failure('ARTIFACT_LIMIT_INVALID');
        const before = await fs.driver.getNode(path);
        if (before?.type !== 'file') throw failure('OPERATION_RESULT_ARTIFACT_MISSING');
        size = before.size;
        if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) throw failure('OPERATION_RESULT_ARTIFACT_LIMIT');
        stage = 'read'; const bytes = await fs.driver.readContent(path, {encoding: 'binary', length: size});
        stage = 'recheck'; const after = await fs.driver.getNode(path);
        if (bytes.byteLength !== size || after?.type !== 'file' || after.size !== size ||
            after.revision !== before.revision || after.modifiedAt !== before.modifiedAt) throw failure('ARTIFACT_READ_CONFLICT');
        stage = 'digest'; if (sha256HexSync(bytes) !== digest) throw failure('OPERATION_RESULT_ARTIFACT_UNVERIFIED');
    } catch (error) {
        const code = (error as {code?: string})?.code;
        console.warn('[ArtifactVerification]', JSON.stringify({operation: 'artifact.verify', operationId: /^[a-zA-Z0-9_-]{1,128}$/.test(operationId ?? '') ? operationId : undefined, stage, result: 'failure', size, maxBytes,
            code: /^[A-Z][A-Z0-9_]{0,79}$/.test(code ?? '') ? code : 'ARTIFACT_READ_FAILED', durationMs: Date.now() - started}));
        throw error;
    }
}
