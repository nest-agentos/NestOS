import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true,
    external: ['@nestos/mdxeditor', '@nestos/common', '@nestos/ui-common-adapter', '@nestos/vfs-core'], sourcemap: true });
