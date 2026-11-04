import { defineConfig } from 'vite';
import { createLibConfig } from '../../scripts/vite-lib.config';

export default defineConfig(
  createLibConfig({
    name: 'AppSettings',
    fileName: 'app-settings',
    rootDir: __dirname,
    external: [
      '@nestos/mdx-adapter',
      '@nestos/common',
      '@nestos/vfs',
      '@nestos/llm-ui-adapter'
    ],
    globals: {
      '@nestos/mdx-adapter': 'MDxAdapter',
      '@nestos/common': 'ItookitCommon',
      '@nestos/vfs': 'VFSCore',
      '@nestos/llm-ui-adapter': 'LLMUI'
    }
  })
);
