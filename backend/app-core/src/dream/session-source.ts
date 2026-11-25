import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {DreamSource, SourceAuthority, SourcePort} from '@nestos/dream';
import type {NestosTwinSourceReader} from '../digital-twin/source-reader';

export interface DreamSessionSource {id: string; projectId: string; connectionId: string; sessionId: string; profileId?: string; maxRounds: number}
const log = createModuleLogger('dream-session-source');

/** The host verifies project membership and grant on each authorization. */
export function sessionSourcePort(selected: DreamSessionSource, reader: Pick<NestosTwinSourceReader, 'readSessionWindow' | 'readHarnessWindow'>,
    authorize: (source: DreamSessionSource) => Promise<SourceAuthority>): SourcePort<string> {
    const frozen = structuredClone(selected);
    const check = (source: DreamSource) => {
        if (source.id !== frozen.id || source.projectId !== frozen.projectId || source.connectionId !== frozen.connectionId)
            throw new Error('DREAM_SOURCE_BINDING_CHANGED');
    };
    return {authorize: async source => {check(source); return authorize(frozen);}, read: async (source, limit) => {
        const started = Date.now();
        try {
            check(source); if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('DREAM_SOURCE_LIMIT');
            const result = frozen.profileId ? await reader.readHarnessWindow(frozen.projectId, frozen.profileId, frozen.sessionId, frozen.maxRounds, source.cursor)
                : await reader.readSessionWindow(frozen.sessionId, frozen.maxRounds);
            const version = JSON.stringify([result.nativeIdentity, result.hash]), cursor = 'cursor' in result && typeof result.cursor === 'string' ? result.cursor : sha256HexSync(version);
            log.info('dream.session.source', {operationId: frozen.id, stage: 'window', result: 'success', maxRounds: frozen.maxRounds,
                hasOlder: result.hasOlder, ...('historyBytes' in result && 'contextBytes' in result
                    ? {returnedVisibleTurns: result.scannedRounds, historyBytes: result.historyBytes, contextBytes: result.contextBytes}
                    : {scannedRounds: result.scannedRounds}), durationMs: Date.now() - started});
            return {items: cursor === source.cursor || !result.text ? [] : [result.text], cursor, version, scanned: 1};
        } catch (error) {
            const code = error instanceof Error && /^(DREAM|TWIN)_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_SOURCE_READ_FAILED';
            log.warn('dream.session.source', {operationId: frozen.id, stage: 'window', result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }};
}
