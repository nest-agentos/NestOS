import {captureIntegrationModules} from './integration-modules-source';
import {requireValue} from './errors';
import type {GitSource} from './contracts';

export function dirtyIntegrationModules(repositories:GitSource['repositories']): Array<[string,string]> {
    return (repositories??[]).filter(row=>row.path!=='.'&&row.dirty).map(({path,head})=>{
        requireValue(path.split('/').every(part=>/^[\w.-]+$/.test(part)&&!['.','..','.git'].includes(part.toLowerCase()))
            &&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head),'OPERATION_GIT_IDENTITY_INVALID');
        return [path,head];
    });
}

/** Snapshot the task tree without staging in its real index. */
export const captureIntegrationSource = `
capture_source_tree() {
    GIT_INDEX_FILE="$3" git -C "$1" read-tree "$2"
    GIT_INDEX_FILE="$3" git -C "$1" add -A -- .
    GIT_INDEX_FILE="$3" git -C "$1" write-tree
    rm -f "$3"
}
`;

export const integrationSourceSnapshotScript = `
set -eu
tmp=$(mktemp -d "$(git rev-parse --absolute-git-dir)/nestos-source.XXXXXXXX")
trap 'rm -f "$tmp/index"; rmdir "$tmp"' EXIT
${captureIntegrationSource}
${captureIntegrationModules}
if [ "\${2:-[]}" = '[]' ]; then
    capture_source_tree . "$1" "$tmp/index"
else
    capture_module_tree . "$1" "$2" "$tmp" '' ''
fi
`;
