/** Capture declared module edits as deterministic child commits without moving refs or real indexes. */
export const captureIntegrationModules = `
capture_module_tree() {
    python3 - "$1" "$2" "$3" "$4" "$5" "$6" "\${7:-}" "\${8:-}" <<'PYTHON'
import json
import os
import subprocess
import sys
import tempfile

source, head, modules, scratch, destination, expected_tree, raw_choices, trailers = sys.argv[1:]
choices = json.loads(raw_choices) if raw_choices else {}
def git(root, *args, env=None, input=None):
    return subprocess.check_output(['git', '-C', root, *args], env=env, input=input).strip()

def index_environment(index):
    return {**os.environ, 'GIT_INDEX_FILE': index}

def capture(root, base, index):
    env = index_environment(index)
    git(root, 'read-tree', base, env=env)
    git(root, 'add', '-A', '--', '.', env=env)
    return git(root, 'write-tree', env=env)

def module_root(root, name):
    path = os.path.join(root, name)
    if os.path.realpath(path) != os.path.join(os.path.realpath(root), name):
        raise ValueError('Module path resolves outside its registered location')
    if os.fsdecode(git(path, 'rev-parse', '--show-toplevel')) != os.path.realpath(path):
        raise ValueError('Module is not initialized')
    return path

def snapshot_module(root, base, scratch):
    if git(root, 'rev-parse', 'HEAD') != base.encode():
        raise ValueError('Module head changed')
    tree = capture(root, base, os.path.join(scratch, 'module-index'))
    delta = git(root, 'diff-tree', '-r', '--raw', '--no-renames', base, tree)
    if any(b'160000' in line.split(b'\\t', 1)[0].split()[:2] or line.startswith(b':160000')
           for line in delta.splitlines()):
        raise ValueError('Nested gitlink changes require a separately prepared snapshot')
    date = os.fsdecode(git(root, 'show', '-s', '--format=%aI', base))
    identity = {**os.environ, 'GIT_AUTHOR_NAME': 'NestOS Delivery', 'GIT_AUTHOR_EMAIL': 'delivery@nestos.invalid',
                'GIT_COMMITTER_NAME': 'NestOS Delivery', 'GIT_COMMITTER_EMAIL': 'delivery@nestos.invalid',
                'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date}
    footer = ['-m', trailers] if trailers else []
    return git(root, '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', base,
               '-m', 'chore(delivery): snapshot approved module changes', *footer, env=identity)

def import_approved_blobs(root, target, name):
    for path, choice in choices.items():
        if not path.startswith(name + '/') or not isinstance(choice, dict) or 'oid' not in choice:
            continue
        oid = choice['oid'].encode('ascii')
        kind = subprocess.run(['git', '-C', root, 'cat-file', '-t', oid], capture_output=True)
        if kind.stdout.strip() != b'blob':
            continue
        with tempfile.TemporaryFile() as blob:
            subprocess.run(['git', '-C', root, 'cat-file', 'blob', oid], stdout=blob, check=True)
            blob.seek(0)
            actual = subprocess.check_output(['git', '-C', target, 'hash-object', '-w', '--stdin'], stdin=blob).strip()
        if actual != oid:
            raise ValueError('Approved blob identity changed during import')

def import_module(root, target, commit, base, scratch, name):
    git(target, 'cat-file', '-e', base + '^{commit}')
    packfile = os.path.join(scratch, 'module.pack')
    with open(packfile, 'w+b') as pack:
        subprocess.run(['git', '-C', root, 'pack-objects', '--stdout', '--revs'],
                       input=commit + b'\\n^' + base.encode() + b'\\n', stdout=pack, check=True)
        pack.seek(0)
        subprocess.run(['git', '-C', target, 'unpack-objects'], stdin=pack, check=True)
    git(target, 'cat-file', '-e', commit + b'^{commit}')
    import_approved_blobs(root, target, name)
    git(target, 'update-ref', b'refs/nestos/module-delivery/' + commit, commit)

with tempfile.TemporaryDirectory(dir=scratch) as temp:
    root_index = os.path.join(temp, 'root-index')
    capture(source, head, root_index)
    imports = []
    for index, (name, base) in enumerate(json.loads(modules)):
        entry = git(source, 'ls-tree', head, '--', ':(literal)' + name)
        if entry != b'160000 commit ' + base.encode() + b'\\t' + os.fsencode(name):
            raise ValueError('Approved module does not match its parent gitlink')
        module = module_root(source, name)
        child_scratch = os.path.join(temp, str(index))
        os.mkdir(child_scratch)
        commit = snapshot_module(module, base, child_scratch)
        if destination:
            target = module_root(destination, name)
            imports.append((module, target, commit, base, child_scratch, name))
        git(source, 'update-index', '--cacheinfo', b'160000,' + commit + b',' + os.fsencode(name),
            env=index_environment(root_index))
    tree = git(source, 'write-tree', env=index_environment(root_index)).decode()
    if expected_tree and tree != expected_tree:
        sys.exit(4)
    for item in imports:
        import_module(*item)
    print(tree)
PYTHON
}
verify_module_links() {
    [ "$4" != '[]' ] || return 0
    python3 - "$1" "$2" "$3" "$4" <<'PYTHON'
import json
import subprocess
import sys

source, target, previous, modules = sys.argv[1:]
def entry(tree, path):
    return subprocess.check_output(['git', 'ls-tree', tree, '--', ':(literal)' + path])
for path, _ in json.loads(modules):
    incoming = entry(source, path)
    baseline = entry(previous, path)
    merged = entry(target, path)
    if not all(row.startswith(b'160000 commit ') for row in (incoming, baseline, merged)):
        sys.exit(3)
    old = baseline.split()[2]
    new = incoming.split()[2]
    result = merged.split()[2]
    if any(subprocess.run(['git', '-C', path, 'merge-base', '--is-ancestor', parent, result]).returncode for parent in (old, new)):
        sys.exit(3)
PYTHON
}
`;
