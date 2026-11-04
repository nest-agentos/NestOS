import { defineConfig } from 'vite';
import { createLibConfig } from '../../scripts/vite-lib.config';

export default defineConfig(
  createLibConfig({
    name: 'LLMUI',
    fileName: 'llm-ui',
    rootDir: __dirname,
    external: [
      '@nestos/mdx-adapter',
      '@nestos/common',
      '@nestos/vfs-core',
      '@nestos/llm-session',
      '@nestos/mdxeditor',
      'marked',
      'js-yaml'
    ],
    globals: {
      '@nestos/mdx-adapter': 'MDxAdapter',
      '@nestos/common': 'ItookitCommon',
      '@nestos/vfs-core': 'ItookitStdio',
      '@nestos/llm-session': 'LLMConversation',
      '@nestos/mdxeditor': 'MDxEditor',
      'marked': 'marked',
      'js-yaml': 'jsyaml'
    }
  })
);
