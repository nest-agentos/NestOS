import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync} from 'node:fs';
import path from 'node:path';

/** Enumerate source inputs without following ignored output or symbolic links. */
export function gitSourceFiles(root, prefix = '', include = () => true) {
    const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {cwd: root, maxBuffer: 32 * 1024 * 1024}).toString().split('\0').filter(Boolean);
    return [...new Set(names)].sort().flatMap(name => {
        const file = path.join(root, name), relative = path.join(prefix, name);
        if (!include(relative)) return [];
        if (!existsSync(file)) return [];
        if (lstatSync(file).isDirectory())
            return existsSync(path.join(file, '.git')) ? gitSourceFiles(file, relative, include) : [];
        return [relative];
    });
}
