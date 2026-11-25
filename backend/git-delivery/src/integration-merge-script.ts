/** Resolve only explicitly selected Git stages from the frozen conflict plan. */
export const approvedMerge = `
approved_merge() {
    python3 - "$1" "$2" "$choices" "$tmp" "\${3:-[]}" <<'PYTHON'
import json
import os
import re
import subprocess
import sys
import tempfile

target, source, raw_choices, root, raw_modules = sys.argv[1:]
choices = json.loads(raw_choices)
modules = dict(json.loads(raw_modules))

def merge_module(path, stages):
    values = [stages.get(i) for i in (1, 2, 3)]
    if any(not row or row[0] != b'160000' for row in values):
        sys.exit(3)
    base, left, right = [row[1] for row in values]
    if base.decode('ascii') != modules[path] or os.path.realpath(path) != os.path.join(os.getcwd(), path):
        sys.exit(3)
    def git(*args):
        return subprocess.check_output(['git', '-C', path, *args], stderr=subprocess.DEVNULL).strip()
    if os.fsdecode(git('rev-parse', '--show-toplevel')) != os.path.realpath(path):
        sys.exit(3)
    try:
        tree = git('merge-tree', '--write-tree', left, right)
    except subprocess.CalledProcessError:
        sys.exit(3)
    if not re.fullmatch(rb'[a-f0-9]{40}(?:[a-f0-9]{24})?', tree):
        sys.exit(3)
    date = os.fsdecode(git('show', '-s', '--format=%aI', base))
    identity = {**os.environ, 'GIT_AUTHOR_NAME': 'NestOS Delivery', 'GIT_AUTHOR_EMAIL': 'delivery@nestos.invalid',
                'GIT_COMMITTER_NAME': 'NestOS Delivery', 'GIT_COMMITTER_EMAIL': 'delivery@nestos.invalid',
                'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date}
    oid = subprocess.check_output(['git', '-C', path, '-c', 'commit.gpgSign=false', 'commit-tree', tree,
        '-p', left, '-p', right, '-m', 'chore(delivery): integrate approved module histories'], env=identity).strip()
    git('update-ref', b'refs/nestos/module-delivery/' + oid, oid)
    return b'160000', oid
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
    entries.setdefault(path, {})[int(stage)] = (mode, oid)
if not entries or any(os.fsdecode(path) not in choices and os.fsdecode(path) not in modules for path in entries):
    sys.exit(5)
with tempfile.TemporaryDirectory(dir=root) as isolated:
    env = {**os.environ, 'GIT_INDEX_FILE': os.path.join(isolated, 'index')}
    subprocess.run(['git', 'read-tree', tree], env=env, check=True)
    for path in entries:
        subprocess.run(['git', 'update-index', '--force-remove', '--', path], env=env, check=True)
    for path, stages in entries.items():
        name = os.fsdecode(path)
        choice = choices.get(name)
        if any(mode == b'160000' for mode, _ in stages.values()):
            if name not in modules:
                sys.exit(3)
            content = merge_module(name, stages)
        elif choice is None:
            sys.exit(5)
        elif isinstance(choice, dict):
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
approved_merge "$1" "$2" "$4"
`;
