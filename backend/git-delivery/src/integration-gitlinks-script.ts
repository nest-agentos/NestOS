/** Preserve initialized submodule checkouts when only their parent pointers change. */
export const preserveIntegrationGitlinks = `
preserve_gitlinks() {
    python3 - "$target" "$candidate" "$original_tree" "$new_work" "$tmp" <<'PYTHON'
import os
import subprocess
import sys
import tempfile

target, candidate, original, incoming, root = sys.argv[1:]
def git(*args, **kwargs):
    return subprocess.check_output(['git', *args], **kwargs).strip()

diff = subprocess.check_output(['git', 'diff-tree', '-r', '--raw', '--no-renames', '-z',
    '--no-commit-id', target, candidate]).split(b"\\0")
patches = []
for spec, path in zip(diff[::2], diff[1::2]):
    old_mode, new_mode, _, new_oid, _ = spec[1:].split()
    if b'160000' not in (old_mode, new_mode):
        continue
    if old_mode != new_mode or os.path.islink(path) or not os.path.exists(os.path.join(path,b'.git')):
        print("INTEGRATION_PATH " + os.fsdecode(path).encode("unicode_escape").decode("ascii")[:512])
        sys.exit(3)
    if git('-C', path, 'cat-file', '-t', new_oid) != b'commit':
        sys.exit(3)
    patches.append((path, git('-C', path, 'rev-parse', '--verify', 'HEAD')))
with tempfile.TemporaryDirectory(dir=root) as isolated:
    for tree in (original, incoming):
        if not patches:
            print(tree)
            continue
        env = {**os.environ, 'GIT_INDEX_FILE': os.path.join(isolated, 'index')}
        git('read-tree', tree, env=env)
        for path, oid in patches:
            git('update-index', '--add', '--cacheinfo', b','.join((b'160000', oid, path)), env=env)
        print(git('write-tree', env=env).decode('ascii'))
PYTHON
}
`;
