/** Replay the same parent relationships as publication using a disposable object directory. */
export const simulateIntegration = String.raw`
import json
import os
import subprocess
import sys
import tempfile

def git(*args, allowed=(0,), env=None):
    result = subprocess.run(['git', *args], capture_output=True, env=env)
    if result.returncode not in allowed:
        sys.exit(2)
    return result

def conflict_result(paths, checked):
    names, size = [], 0
    for path in paths[:100]:
        if len(path) > 4096:
            continue
        try:
            name = path.decode('utf-8')
        except UnicodeDecodeError:
            continue
        size += len(json.dumps(name))
        if size > 8192:
            break
        names.append(name)
    return dict(state='conflicts', checkedSources=checked, paths=names, truncated=len(names) < len(paths))

def replay(target, sources, env):
    def ancestor(left, right):
        return git('merge-base', '--is-ancestor', left, right, allowed=(0, 1), env=env).returncode == 0

    def commit(tree, *parents):
        args = [arg for parent in parents for arg in ('-p', parent)]
        return git('-c', 'commit.gpgSign=false', 'commit-tree', tree, *args, '-m', 'Kanban integration preview', env=env).stdout.strip().decode('ascii')

    for index, (head, frozen_tree) in enumerate(sources):
        source = commit(frozen_tree, head) if frozen_tree else head
        if ancestor(source, target):
            continue
        result = git('merge-tree', '--write-tree', '--name-only', '-z', target, source, allowed=(0, 1), env=env)
        tree, _, entries = result.stdout.partition(b'\0')
        if result.returncode == 1:
            paths = entries.split(b'\0\0', 1)[0].split(b'\0')
            if not paths or not all(paths):
                sys.exit(2)
            return conflict_result(paths, index + 1)
        tree = tree.decode('ascii')
        if frozen_tree and ancestor(head, target):
            if tree != git('rev-parse', target + '^{tree}', env=env).stdout.strip().decode('ascii'):
                target = commit(tree, target)
        else:
            target = commit(tree, target, head)
    return dict(state='clean', checkedSources=len(sources))

if git('config', '--get-regexp', r'^merge\..*\.driver$', allowed=(0, 1)).returncode == 0:
    print(json.dumps(dict(state='unavailable', code='INTEGRATION_PREVIEW_CUSTOM_MERGE_DRIVER')))
    sys.exit(0)

objects = os.fsdecode(git('rev-parse', '--path-format=absolute', '--git-path', 'objects').stdout.rstrip(b'\n'))
with tempfile.TemporaryDirectory(prefix='nestos-preview-') as isolated:
    alternates = [json.dumps(objects, ensure_ascii=False), os.environ.get('GIT_ALTERNATE_OBJECT_DIRECTORIES')]
    env = {**os.environ, 'GIT_OBJECT_DIRECTORY': isolated, 'GIT_NO_LAZY_FETCH': '1',
           'GIT_ALTERNATE_OBJECT_DIRECTORIES': os.pathsep.join(filter(None, alternates)),
           'GIT_AUTHOR_NAME': 'NestOS Delivery', 'GIT_AUTHOR_EMAIL': 'delivery@nestos.invalid',
           'GIT_COMMITTER_NAME': 'NestOS Delivery', 'GIT_COMMITTER_EMAIL': 'delivery@nestos.invalid'}
    print(json.dumps(replay(sys.argv[1], json.loads(sys.argv[2]), env)))
`;
