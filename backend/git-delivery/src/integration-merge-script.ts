/** Resolve only explicitly selected Git stages from the frozen conflict plan. */
export const approvedMerge = `
approved_merge() {
    python3 - "$1" "$2" "$choices" "$tmp" <<'PYTHON'
import json
import os
import re
import subprocess
import sys
import tempfile

target, source, raw_choices, root = sys.argv[1:]
choices = json.loads(raw_choices)
result = subprocess.run(['git', 'merge-tree', '--write-tree', '-z', target, source],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
rows = result.stdout.split(b"\\0")
tree = rows[0]
if not re.fullmatch(rb'[0-9a-f]{40}(?:[0-9a-f]{24})?', tree):
    sys.exit(4)
if result.returncode == 0:
    print(tree.decode('ascii'))
    sys.exit(0)
if result.returncode != 1:
    sys.exit(4)
entries = {}
for row in rows[1:]:
    if not row:
        break
    match = re.fullmatch(rb'([0-9]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([123])\\t(.+)', row, re.S)
    if not match:
        sys.exit(3)
    mode, oid, stage, path = match.groups()
    if mode == b'160000':
        sys.exit(3)
    entries.setdefault(path, {})[int(stage)] = (mode, oid)
if not entries or any(os.fsdecode(path) not in choices for path in entries):
    sys.exit(3)
with tempfile.TemporaryDirectory(dir=root) as isolated:
    env = {**os.environ, 'GIT_INDEX_FILE': os.path.join(isolated, 'index')}
    subprocess.run(['git', 'read-tree', tree], env=env, check=True)
    for path in entries:
        subprocess.run(['git', 'update-index', '--force-remove', '--', path], env=env, check=True)
    for path, stages in entries.items():
        choice = choices[os.fsdecode(path)]
        if isinstance(choice, dict):
            if choice['mode'] == 'delete':
                continue
            oid = choice['oid'].encode('ascii')
            if subprocess.check_output(['git', 'cat-file', '-t', oid]).strip() != b'blob':
                sys.exit(3)
            content = (choice['mode'].encode('ascii'), oid)
        else:
            content = stages.get(3 if choice == 'source' else 2)
        if content:
            mode, oid = content
            subprocess.run(['git', 'update-index', '--add', '--cacheinfo', b','.join((mode, oid, path))],
                env=env, check=True)
    print(subprocess.check_output(['git', 'write-tree'], env=env).decode('ascii').strip())
PYTHON
}
`;

export const inspectApprovedMergeScript = `
set -eu
choices=$3
tmp=$(mktemp -d "$(git rev-parse --absolute-git-dir)/nestos-merge-proof.XXXXXXXX")
trap 'rmdir "$tmp"' EXIT
${approvedMerge}
approved_merge "$1" "$2"
`;
