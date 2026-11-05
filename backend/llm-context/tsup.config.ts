import { defineConfig } from 'tsup';
export default defineConfig({ entry: {index: 'src/index.ts', digest: 'src/contracts/digest.ts', prompt: 'src/contracts/prompt-markdown.ts'}, format: ['esm', 'cjs'], dts: true, clean: true });
