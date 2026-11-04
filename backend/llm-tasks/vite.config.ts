// @file: llm-runtime/vite.config.ts

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      rollupTypes: true
    })
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'LLMEngine',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`
    },
    rollupOptions: {
      external: [
        '@nestos/driver-llm',
        '@nestos/vfs'
      ],
      output: {
        globals: {
          '@nestos/driver-llm': 'LLMDriver',
          '@nestos/vfs': 'VFSCore'
        }
      }
    },
    sourcemap: true,
    minify: false
  }
});
