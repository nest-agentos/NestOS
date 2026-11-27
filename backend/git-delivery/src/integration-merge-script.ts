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
    prefix = path + '/'
    module_choices = {name[len(prefix):]: value for name, value in choices.items() if name.startswith(prefix)}
    tree = merge_tree(path, left, right, module_choices, {})
    date = os.fsdecode(git('show', '-s', '--format=%aI', base))
    identity = {**os.environ, 'GIT_AUTHOR_NAME': 'NestOS Delivery', 'GIT_AUTHOR_EMAIL': 'delivery@nestos.invalid',
                'GIT_COMMITTER_NAME': 'NestOS Delivery', 'GIT_COMMITTER_EMAIL': 'delivery@nestos.invalid',
                'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date}
    oid = subprocess.check_output(['git', '-C', path, '-c', 'commit.gpgSign=false', 'commit-tree', tree,
        '-p', left, '-p', right, '-m', 'chore(delivery): integrate approved module histories'], env=identity).strip()
    git('update-ref', b'refs/nestos/module-delivery/' + oid, oid)
    return b'160000', oid
def conflict_entries(rows):
    entries = {}
    for row in rows:
        if not row:
            break
        match = re.fullmatch(rb'([0-9]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([123])\\t(.+)', row, re.S)
        if not match:
            sys.exit(3)
        mode, oid, stage, path = match.groups()
        entries.setdefault(path, {})[int(stage)] = (mode, oid)
    return entries

def resolve_entries(repo, tree, entries, selected, allowed_modules, index):
    env = {**os.environ, 'GIT_INDEX_FILE': index}
    git = ['git', '-C', repo]
    subprocess.run(git + ['read-tree', tree], env=env, check=True)
    for path in entries:
        subprocess.run(git + ['update-index', '--force-remove', '--', path], env=env, check=True)
    for path, stages in entries.items():
        name = os.fsdecode(path)
        choice = selected.get(name)
        if any(mode == b'160000' for mode, _ in stages.values()):
            if name not in allowed_modules:
                sys.exit(3)
            content = merge_module(name, stages)
        elif choice is None:
            sys.exit(5)
        elif isinstance(choice, dict):
            if choice['mode'] == 'delete':
                continue
            oid = choice['oid'].encode('ascii')
            if subprocess.run(git + ['cat-file', '-t', oid], capture_output=True).stdout.strip() != b'blob':
                sys.exit(6)
            content = (choice['mode'].encode('ascii'), oid)
        else:
            content = stages.get(3 if choice == 'source' else 2)
        if content:
            mode, oid = content
            subprocess.run(git + ['update-index', '--add', '--cacheinfo', b','.join((mode, oid, path))],
                env=env, check=True)
    return subprocess.check_output(git + ['write-tree'], env=env).strip()

def retain_target_entry(git, left, path, env):
    row = subprocess.check_output(git + ['ls-tree', '-z', left, '--', ':(literal)' + path])
    match = re.fullmatch(rb'(100644|100755) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\\t(.+)\\0', row, re.S)
    if not match or match[3] != os.fsencode(path):
        sys.exit(7)
    subprocess.run(git + ['update-index', '--add', '--cacheinfo', b','.join(match.groups())], env=env, check=True)

def retain_target_files(repo, left, tree, selected):
    paths = [path for path, choice in selected.items() if choice == 'retain-target']
    if not paths:
        return tree
    git = ['git', '-C', repo]
    with tempfile.TemporaryDirectory(dir=root) as isolated:
        env = {**os.environ, 'GIT_INDEX_FILE': os.path.join(isolated, 'index')}
        subprocess.run(git + ['read-tree', tree], env=env, check=True)
        for path in paths:
            retain_target_entry(git, left, path, env)
        return subprocess.check_output(git + ['write-tree'], env=env).strip()

def merge_tree(repo, left, right, selected, allowed_modules):
    result = subprocess.run(['git', '-C', repo, 'merge-tree', '--write-tree', '-z', left, right],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    tree, *rows = result.stdout.split(b"\\0")
    if not re.fullmatch(rb'[0-9a-f]{40}(?:[0-9a-f]{24})?', tree) or result.returncode not in (0, 1):
        sys.exit(4)
    if result.returncode == 1:
        entries = conflict_entries(rows)
        if not entries or any(os.fsdecode(path) not in selected and os.fsdecode(path) not in allowed_modules for path in entries):
            sys.exit(5)
        with tempfile.TemporaryDirectory(dir=root) as isolated:
            tree = resolve_entries(repo, tree, entries, selected, allowed_modules, os.path.join(isolated, 'index'))
    return retain_target_files(repo, left, tree, selected)

print(merge_tree('.', target, source, choices, modules).decode('ascii'))
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
