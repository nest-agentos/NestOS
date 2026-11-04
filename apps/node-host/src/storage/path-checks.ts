import path from 'node:path';
import type {Stats} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {FSError} from '@nestos/vfs-core';

export type PathProbes = Map<string, Promise<Stats>>;
/** Share only concurrent probes, or explicitly bounded batch results; never retain a path verdict. */
export class PathChecks {
    private readonly pending: PathProbes = new Map();
    constructor(private readonly inspect: (value: string) => Promise<Stats> = lstat) {}
    probe(value: string, batch?: PathProbes): Promise<Stats> {
        const probes = batch ?? this.pending;
        let result = probes.get(value);
        if (!result) {
            result = this.inspect(value); probes.set(value, result);
            if (!batch) void result.finally(() => {if (probes.get(value) === result) probes.delete(value);}).catch(() => {});
        }
        return result;
    }
    async check(root: string, target: string, batch?: PathProbes): Promise<Stats | null> {
        let current = root, info: Stats | undefined;
        for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                info = await this.probe(current, batch);
                if (info.isSymbolicLink()) throw new FSError('EACCES', 'Storage links are unavailable');
            } catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
        }
        return info ?? this.probe(root, batch);
    }
}
