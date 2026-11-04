import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: { alias: [{ find: /^@nestos\/vfs-core$/, replacement: fileURLToPath(import.meta.resolve('@nestos/vfs-core')) }] },
    test: {
        globals: true,
        server: { deps: { inline: [/itookit/] } },
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
});
