import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts', contracts: 'src/contracts.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: [
        '@nestos/llm-context',
        '@nestos/durable-kernel',
        '@nestos/llm-tasks',
    ],
});
