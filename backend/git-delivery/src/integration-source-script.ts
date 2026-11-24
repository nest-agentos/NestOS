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
capture_source_tree . "$1" "$tmp/index"
`;
