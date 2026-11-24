import {integrationPublication} from './integration-publication-script';
import {preserveIntegrationGitlinks} from './integration-gitlinks-script';
import {captureIntegrationModules} from './integration-modules-source';
import {captureIntegrationSource} from './integration-source-script';
import {approvedMerge} from './integration-merge-script';

/** Run the compare, replay and ref publication in one authorized project process. */
export const integrationScript = `
set -eu
ref=$1 target=$2 branch=$3 choices=$4
shift 4
stop() { stage=$2; exit "$1"; }
stage=INTEGRATION_PREPARATION_FAILED
trap 'result=$?; if [ "$result" -ne 0 ]; then printf "%s\\n" "$stage"; fi' EXIT
${integrationPublication}
${approvedMerge}
${preserveIntegrationGitlinks}
${captureIntegrationSource}
${captureIntegrationModules}
integration_lock
git check-ref-format "$branch"
[ "$(git symbolic-ref HEAD)" = "$branch" ] && [ "$(git rev-parse HEAD)" = "$target" ] ||
    stop 4 INTEGRATION_TARGET_CHANGED
for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-apply rebase-merge sequencer
do
    [ ! -e "$(git rev-parse --git-path "$state")" ] || stop 3 INTEGRATION_TARGET_BUSY
done
[ -z "$(git ls-files --unmerged)" ] || stop 3 INTEGRATION_TARGET_CONFLICT
[ "$(git config --bool core.sparseCheckout || true)" != true ] || stop 3 INTEGRATION_SPARSE_WORKTREE
target_idle || stop 3 INTEGRATION_INDEX_FLAGS_UNSUPPORTED
tmp=$(mktemp -d "$(git rev-parse --absolute-git-dir)/nestos-integrate.XXXXXXXX")
trap 'result=$?; rm -f "$tmp/index" "$tmp/gitlinks" "$tmp/steps" "$tmp/probe" "$tmp/modules" "$tmp/candidate-paths" "$tmp/original-paths"; rmdir "$tmp"; if [ "$result" -ne 0 ]; then printf "%s\\n" "$stage"; fi' EXIT
commit() { git -c user.useConfigOnly=true commit-tree "$@"; }
merge_tree() {
    rc=0
    tree=$(git merge-tree --write-tree "$1" "$2") || rc=$?
    [ "$rc" -ne 1 ] && [ "$rc" -ne 129 ] || return 3
    [ "$rc" -eq 0 ] || return 4
    printf '%s\\n' "$tree"
}
# Git unpack-trees can replace ignored paths. Check only newly tracked paths and blockers.
check_untracked() {
    GIT_INDEX_FILE="$tmp/index" python3 - "$original_tree" "$new_work" <<'PYTHON'
import os
import subprocess
import sys

paths = subprocess.check_output([
    "git", "diff-tree", "-r", "--no-commit-id", "--name-only", "--no-renames",
    "--diff-filter=A", "-z", *sys.argv[1:],
]).split(b"\\0")
blockers = set()
for raw in filter(None, paths):
    path = os.fsdecode(raw)
    if os.path.lexists(path):
        blockers.add(path)
    parent = os.path.dirname(path)
    while parent:
        if os.path.islink(parent) or os.path.lexists(parent) and not os.path.isdir(parent):
            blockers.add(parent)
        parent = os.path.dirname(parent)
blockers = sorted(blockers)
for offset in range(0, len(blockers), 128):
    batch = blockers[offset:offset + 128]
    if subprocess.check_output(["git", "ls-files", "--others", "-z", "--", *[":(literal)" + p for p in batch]]):
        sys.exit(3)
PYTHON
}
merge_source() {
    source=$1 head=$2 dirty=$3 trailers=$4 frozen_tree=$5 source_modules=$6
    [ "$(git -C "$source" rev-parse HEAD)" = "$head" ] || stop 4 INTEGRATION_SOURCE_CHANGED
    next=$head
    if [ "$dirty" = dirty ]; then
        [ "$(git -C "$source" config --bool core.sparseCheckout || true)" != true ] || stop 3 INTEGRATION_SPARSE_WORKTREE
        if [ "$source_modules" = '[]' ]; then
            source_tree=$(capture_source_tree "$source" "$head" "$tmp/index")
        else
            rc=0
            source_tree=$(capture_module_tree "$source" "$head" "$source_modules" "$tmp" "$PWD" "$frozen_tree") || rc=$?
            [ "$rc" -ne 4 ] || stop 4 INTEGRATION_SOURCE_CHANGED
            [ "$rc" -eq 0 ] || stop 3 INTEGRATION_MODULE_CAPTURE_FAILED
        fi
        [ -z "$frozen_tree" ] || [ "$source_tree" = "$frozen_tree" ] || stop 4 INTEGRATION_SOURCE_CHANGED
        next=$(commit "$source_tree" -p "$head" -m "chore(delivery): snapshot approved worktree")
    fi
    if git merge-base --is-ancestor "$next" "$candidate"; then
        verify_module_links "$next" "$candidate" "$candidate" "$source_modules" || stop 3 INTEGRATION_MODULE_REVIEW_REQUIRED
        return
    fi
    rc=0
    tree=$(approved_merge "$candidate" "$next") || rc=$?
    [ "$rc" -eq 0 ] || stop "$rc" INTEGRATION_SOURCE_MERGE
    verify_module_links "$next" "$tree" "$candidate" "$source_modules" || stop 3 INTEGRATION_MODULE_REVIEW_REQUIRED
    if [ "$dirty" = dirty ] && git merge-base --is-ancestor "$head" "$candidate"; then
        [ "$tree" != "$(git rev-parse "$candidate^{tree}")" ] || return 0
        candidate=$(commit "$tree" -p "$candidate" -m "chore(delivery): integrate approved changes" -m "$trailers")
    else
        candidate=$(commit "$tree" -p "$candidate" -p "$head" -m "chore(delivery): integrate approved changes" -m "$trailers")
    fi
}
candidate=$target
step=0
while [ "$#" -gt 0 ]
do
    merge_source "$1" "$2" "$3" "$4" "$5" "$6"
    printf 'create %s/steps/%s %s\\ncreate %s/sources/%s %s\\n' "$ref" "$step" "$candidate" "$ref" "$step" "$next" >> "$tmp/steps"
    step=$((step + 1))
    shift 6
done

stage=INTEGRATION_TARGET_CAPTURE_FAILED
original_index=$(git write-tree)
modules=$(module_state)
original_work=$(git -c user.useConfigOnly=true stash create "$ref")
original_tree=$(git rev-parse "\${original_work:-$target}^{tree}")
if [ -z "$original_work" ]; then original_work=$target; fi
new_index=$(git rev-parse "$candidate^{tree}")
new_work=$new_index
if [ "$original_work" != "$target" ]; then
    original_index_commit=$(git rev-parse "$original_work^2")
    rc=0
    new_index=$(merge_tree "$candidate" "$original_index_commit") || rc=$?
    [ "$rc" -eq 0 ] || stop "$rc" INTEGRATION_STAGED_MERGE
    index_commit=$(commit "$new_index" -p "$candidate" -p "$original_index_commit" -m "chore(delivery): preserve staged changes")
    work_commit=$(commit "$original_tree" -p "$original_index_commit" -m "chore(delivery): preserve unstaged changes")
    rc=0
    new_work=$(merge_tree "$index_commit" "$work_commit") || rc=$?
    [ "$rc" -eq 0 ] || stop "$rc" INTEGRATION_UNSTAGED_MERGE
fi
stage=INTEGRATION_MODULE_CHECK_FAILED
trees=$(preserve_gitlinks) || stop 3 INTEGRATION_MODULE_REVIEW_REQUIRED
original_tree=$(printf '%s\\n' "$trees" | sed -n '1p')
new_work=$(printf '%s\\n' "$trees" | sed -n '2p')
GIT_INDEX_FILE="$tmp/index" git read-tree "$original_tree"
GIT_INDEX_FILE="$tmp/index" git update-index -q --refresh --ignore-submodules
rc=0
check_untracked || rc=$?
[ "$rc" -eq 0 ] || stop "$rc" INTEGRATION_UNTRACKED_COLLISION
GIT_INDEX_FILE="$tmp/index" git read-tree --no-recurse-submodules --dry-run -m -u "$original_tree" "$new_work" ||
    stop 3 INTEGRATION_WORKTREE_CONFLICT
[ "$(git symbolic-ref HEAD)" = "$branch" ] && [ "$(git rev-parse HEAD)" = "$target" ] &&
    [ "$(git write-tree)" = "$original_index" ] || stop 4 INTEGRATION_TARGET_CHANGED
current_work=$(git -c user.useConfigOnly=true stash create "$ref")
[ "$(git rev-parse "\${current_work:-$target}^{tree}")" = "$(git rev-parse "$original_work^{tree}")" ] || stop 4 INTEGRATION_TARGET_CHANGED
[ "$(module_state)" = "$modules" ] || stop 4 INTEGRATION_TARGET_CHANGED
stage=INTEGRATION_PUBLICATION_UNKNOWN
{
    printf 'start\\ncreate %s/original %s\\ncreate %s/original-index %s\\ncreate %s/original-work-tree %s\\ncreate %s/base %s\\ncreate %s/modules %s\\ncreate %s/candidate %s\\ncreate %s/index %s\\ncreate %s/work %s\\n' \\
        "$ref" "$original_work" "$ref" "$original_index" "$ref" "$original_tree" "$ref" "$target" "$ref" "$modules" "$ref" "$candidate" "$ref" "$new_index" "$ref" "$new_work"
    cat "$tmp/steps"
    printf 'prepare\\ncommit\\n'
} | git update-ref --stdin >/dev/null
publish_integration
`;
