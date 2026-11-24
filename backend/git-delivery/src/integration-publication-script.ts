/** Shared publication steps. The caller holds the target's host integration lock. */
export const integrationPublication = `
ref_value() { git rev-parse --verify --quiet "$ref/$1"; }
target_matches() {
    [ "$(git symbolic-ref HEAD)" = "$branch" ] && [ "$(git rev-parse HEAD)" = "$target" ]
}
target_idle() {
    for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-apply rebase-merge sequencer; do
        [ ! -e "$(git rev-parse --git-path "$state")" ] || return 1
    done
    [ -z "$(git ls-files --unmerged)" ] &&
        [ "$(git config --bool core.sparseCheckout || true)" != true ] &&
        ! git ls-files -v | grep -q '^[a-zS] ' &&
        [ "$(git diff --cached --ita-visible-in-index --name-only)" = "$(git diff --cached --ita-invisible-in-index --name-only)" ]
}
integration_lock() {
    exec 9>"$(git rev-parse --git-path nestos-integration.lock)"
    flock -n 9 || stop 5 INTEGRATION_TARGET_BUSY
}
module_state() {
    git submodule foreach --quiet --recursive 'git rev-parse HEAD && git write-tree && git status --porcelain=v1 -z --untracked-files=all && git diff --binary --no-ext-diff HEAD --' > "$tmp/modules"
    git hash-object -w "$tmp/modules"
}
match_work() {
    expected=$1 alternate=$2
    GIT_INDEX_FILE="$tmp/probe" git read-tree "$expected" || return 1
    GIT_INDEX_FILE="$tmp/probe" git add -u -- . || return 1
    observed=$(GIT_INDEX_FILE="$tmp/probe" git write-tree) || return 1
    GIT_INDEX_FILE="$tmp/probe" python3 - "$expected" "$alternate" "$observed" "$tmp" <<'PYTHON'
import filecmp
import os
import subprocess
import sys
import tempfile

expected, alternate, observed, temp = sys.argv[1:]
missing = subprocess.check_output(['git', 'diff-tree', '-r', '--no-commit-id',
    '--name-only', '--no-renames', '--diff-filter=A', '-z', expected, alternate]).split(b"\\0")
changed = subprocess.check_output(['git', 'diff-tree', '-r', '--no-commit-id',
    '--name-only', '--no-renames', '-z', expected, observed]).split(b"\\0")
collisions = set(path for path in missing if path and os.path.lexists(path)) | set(filter(None, changed))
if not collisions:
    selected = subprocess.check_output(['git', 'diff-tree', '-r', '--no-commit-id',
        '--name-only', '--no-renames', '--diff-filter=AMT', '-z', alternate, expected])
    if selected:
        with tempfile.TemporaryDirectory(dir=temp) as raw:
            subprocess.run(['git', 'checkout-index', '--stdin', '-z', '--prefix=' + raw + '/'],
                input=selected, check=True)
            for path in filter(None, selected.split(b"\\0")):
                copy = os.path.join(os.fsencode(raw), path)
                if os.path.islink(copy):
                    matches = os.path.islink(path) and os.readlink(copy) == os.readlink(path)
                else:
                    matches = not os.path.islink(path) and filecmp.cmp(path, copy, shallow=False)
                if not matches:
                    collisions.add(path)
collisions = sorted(collisions)
for path in collisions[:16]:
    print("INTEGRATION_PATH " + os.fsdecode(path).encode("unicode_escape").decode("ascii")[:512])
sys.exit(1 if collisions else 0)
PYTHON
}
index_changed() {
    git diff-tree -r --no-commit-id --no-renames --name-only "$1" "$2" |
        sed -n '1,16s/^/INTEGRATION_PATH /p'
    stop 5 INTEGRATION_RECOVERY_INDEX_CHANGED
}
publish_integration() {
    stage=INTEGRATION_PUBLICATION_UNKNOWN
    target_matches || stop 5 INTEGRATION_RECOVERY_TARGET_CHANGED
    target_idle || stop 5 INTEGRATION_TARGET_BUSY
    [ "$(module_state)" = "$modules" ] || stop 5 INTEGRATION_RECOVERY_SUBMODULE_CHANGED
    index_tree=$(git write-tree)
    if [ "$index_tree" != "$original_index" ] && [ "$index_tree" != "$new_index" ]; then
        index_changed "$original_index" "$index_tree"
    fi
    if ! match_work "$new_work" "$original_tree" > "$tmp/candidate-paths"; then
        if [ "$index_tree" != "$original_index" ] || ! match_work "$original_tree" "$new_work" > "$tmp/original-paths"; then
            cat "$tmp/candidate-paths" "$tmp/original-paths" 2>/dev/null || :
            stop 5 INTEGRATION_RECOVERY_WORKTREE_CHANGED
        fi
        GIT_INDEX_FILE="$tmp/index" git read-tree "$original_tree"
        GIT_INDEX_FILE="$tmp/index" git update-index -q --refresh --ignore-submodules
        GIT_INDEX_FILE="$tmp/index" git read-tree --no-recurse-submodules -m -u "$original_tree" "$new_work"
    fi
    match_work "$new_work" "$original_tree" || stop 5 INTEGRATION_RECOVERY_WORKTREE_CHANGED
    target_matches || stop 5 INTEGRATION_RECOVERY_TARGET_CHANGED
    case "$(git write-tree)" in
        "$new_index") ;;
        "$original_index") git read-tree -i -m "$original_index" "$new_index" ;;
        *) index_changed "$original_index" "$(git write-tree)" ;;
    esac
    [ "$(git write-tree)" = "$new_index" ] || stop 5 INTEGRATION_RECOVERY_INDEX_CHANGED
    match_work "$new_work" "$original_tree" || stop 5 INTEGRATION_RECOVERY_WORKTREE_CHANGED
    [ "$(module_state)" = "$modules" ] || stop 5 INTEGRATION_RECOVERY_SUBMODULE_CHANGED
    target_matches || stop 5 INTEGRATION_RECOVERY_TARGET_CHANGED
    target_idle || stop 5 INTEGRATION_TARGET_BUSY
    {
        printf 'start\\nupdate %s %s %s\\ncreate %s/done %s\\nprepare\\ncommit\\n' \\
            "$branch" "$candidate" "$target" "$ref" "$candidate"
    } | git update-ref --stdin >/dev/null
    printf '%s\\n' INTEGRATION_APPLIED
}
`;

export const integrationRecoveryScript = `
set -eu
ref=$1 target=$2 branch=$3
stop() { stage=$2; exit "$1"; }
stage=INTEGRATION_PUBLICATION_UNKNOWN
trap 'result=$?; if [ "$result" -ne 0 ]; then printf "%s\\n" "$stage"; fi' EXIT
${integrationPublication}
integration_lock
if ref_value done >/dev/null; then printf '%s\\n' INTEGRATION_APPLIED; exit 0; fi
if ! original=$(ref_value original); then stop 5 INTEGRATION_CHECKPOINT_MISSING; fi
candidate=$(ref_value candidate)
original_index=$(ref_value original-index) || stop 5 INTEGRATION_CHECKPOINT_INCOMPLETE
modules=$(ref_value modules) || stop 5 INTEGRATION_CHECKPOINT_INCOMPLETE
new_index=$(ref_value index)
new_work=$(ref_value work)
original_tree=$(ref_value original-work-tree) || stop 5 INTEGRATION_CHECKPOINT_INCOMPLETE
[ "$(ref_value base)" = "$target" ] || stop 5 INTEGRATION_CHECKPOINT_INCOMPLETE
tmp=$(mktemp -d "$(git rev-parse --absolute-git-dir)/nestos-integrate.XXXXXXXX")
trap 'result=$?; rm -f "$tmp/index" "$tmp/probe" "$tmp/modules" "$tmp/candidate-paths" "$tmp/original-paths"; rmdir "$tmp"; if [ "$result" -ne 0 ]; then printf "%s\\n" "$stage"; fi' EXIT
publish_integration
`;
