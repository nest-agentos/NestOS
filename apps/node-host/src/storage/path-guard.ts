import path from 'node:path';
import {PathChecks} from './path-checks';
import { FSError } from '@nestos/vfs-core';

export class PathGuard {
    private readonly checks = new PathChecks();
    constructor(private readonly root: string, private readonly strictPathChecks = true) {}
    visible(value: string): boolean {
        return !['/_meta', '/__vfs_namespace_journal__'].some(root => value === root || value.startsWith(`${root}/`));
    }
    async check(value: unknown): Promise<string> {
        if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\\]/.test(value)
            || !this.visible(value)
            || value.split('/').slice(1).some(part => part === '..' || part === '.' || (!part && value !== '/'))) {
            throw new FSError('EINVAL', 'Expected a canonical VFS path');
        }
        if (this.strictPathChecks) await this.checks.check(this.root, path.join(this.root, value));
        return value;
    }
}
