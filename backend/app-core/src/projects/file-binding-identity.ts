import {sha256HexSync} from '@nestos/common';
import type {RemoteAuthorization, RemoteProject} from '@nestos/cells-driver';

export function sameFileAuthorization(saved?: RemoteAuthorization, current?: RemoteAuthorization): boolean {
    return !!saved && !!current && saved.principalId === current.principalId
        && saved.anonymous === current.anonymous && saved.revision === current.revision;
}

/** Include the directory identities so a replacement at the same path still requires rebinding. */
export function fileBindingIdentity(project: RemoteProject): string | undefined {
    const {rootIdentity, mountIdentities} = project as RemoteProject & {rootIdentity?: unknown; mountIdentities?: unknown};
    if (!directoryIdentity(rootIdentity) || !Array.isArray(mountIdentities)
        || mountIdentities.length !== project.mounts.length || !mountIdentities.every(directoryIdentity)) return;
    const mounts = project.mounts.map(({at, alias, path, access}, index) => [at, alias, path, access, mountIdentities[index]]);
    mounts.sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1);
    return sha256HexSync(JSON.stringify([project.id, project.alias, project.path, project.access, rootIdentity, mounts]));
}

function directoryIdentity(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
