import {createModuleLogger, randomUUID, t} from '@nestos/common';
import type {ApplicationBackend} from '@nestos/app-contracts/services';

const log = createModuleLogger('system-path');
export async function resolveSystemPath(backend: Pick<ApplicationBackend, 'openSystemPath'>, projectId: string, input: string) {
    const operationId = randomUUID(), started = performance.now();
    try {
        const {path, line} = parseSystemPath(input);
        const opening = await backend.openSystemPath(projectId, path, operationId);
        log.info('system.path.resolve', {operation:'system.path.resolve', operationId, stage:'resolve.open', result:'success', durationMs:performance.now()-started});
        return {...opening, line};
    } catch (error) {
        const code = (error as {remoteCode?: string; code?: string}).remoteCode ?? (error as {code?: string}).code;
        log.warn('system.path.resolve', {operation:'system.path.resolve', operationId, stage:'resolve.open', result:'failure', code:typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'PATH_RESOLUTION_FAILED', durationMs:performance.now()-started});
        if (code) throw Object.assign(pathError(code), {code});
        throw error;
    }
}
export function parseSystemPath(input: string): {path: string; line?: number} {
    let value = input;
    if (/^https:\/\//i.test(value)) {
        let url: URL;
        try {url = new URL(value);} catch {throw new Error(t('systemPath.invalid'));}
        if (url.origin !== location.origin || url.search || url.username || url.password) throw new Error(t('systemPath.invalid'));
        const rawPath = input.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] || '/';
        try {value = decodeURIComponent(rawPath) + (url.hash.match(/^#L([1-9]\d*)$/)?.[1] ? ':' + url.hash.slice(2) : '');} catch {throw new Error(t('systemPath.invalid'));}
    }
    const match = value.match(/^(.*):([1-9]\d*)$/), path = match?.[1] ?? value, line = match ? Number(match[2]) : undefined;
    if (!path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..') || line !== undefined && !Number.isSafeInteger(line)) throw new Error(t('systemPath.invalid'));
    return {path, line};
}

function pathError(code?: string): Error {
    if (code === 'EINVAL') return new Error(t('systemPath.invalid'));
    if (code === 'PATH_UNMAPPED') return new Error(t('systemPath.unmapped'));
    if (code === 'PATH_AMBIGUOUS') return new Error(t('systemPath.ambiguous'));
    if (code === 'PATH_NOT_FOUND' || code === 'PATH_NOT_FILE' || code === 'ENOENT') return new Error(t('systemPath.missing'));
    if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') return new Error(t('systemPath.denied'));
    if (code === 'ECAPABILITY') return new Error(t('systemPath.unavailable'));
    if (code === 'PROJECT_REVISION_CHANGED' || code === 'PROJECT_DIRECTORY_CHANGED' || code === 'ECONFLICT') return new Error(t('systemPath.changed'));
    return new Error(t('systemPath.failed'));
}

export function systemLineOffset(text: string, line: number): number {
    const lines = text.split('\n');
    if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) throw new Error(t('systemPath.line'));
    return lines.slice(0, line - 1).reduce((sum, part) => sum + part.length + 1, 0);
}
