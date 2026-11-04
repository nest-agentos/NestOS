import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', contracts: 'src/contracts.ts' },
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      rootDir: '..',
      paths: { '@nestos/kernel-adapters/contracts': ['../kernel-adapters/src/contracts.ts'] },
    },
  },
  // Inline configuration contracts without publishing an adapter runtime dependency.
  noExternal: ['@nestos/kernel-adapters/contracts'],
  clean: true,
  sourcemap: true,
  external: [
    '@nestos/driver-llm', '@nestos/tools', '@nestos/llm-context',
    '@nestos/durable-kernel',
    '@nestos/llm-tasks',
    '@nestos/llm-flow',
    '@nestos/vfs-core',
    'yaml',
  ],
});
