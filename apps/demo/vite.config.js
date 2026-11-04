import { defineConfig, searchForWorkspaceRoot } from 'vite';
import path from 'path';

export default defineConfig({
  base: './',

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),

      // ========== CSS 别名 ==========
      '@nestos/llm-ui-adapter/style.css': path.resolve(__dirname, '../../ui/llm-ui-adapter/src/styles/index.css'),
      '@nestos/app-settings/style.css': path.resolve(__dirname, '../../ui/app-settings/src/styles/styles.css'),

      // ========== 包别名（指向源码）==========
      '@nestos/common': path.resolve(__dirname, '../../shared/common/src/index.ts'),
      '@nestos/vfs': path.resolve(__dirname, '../../packages/vfs/src/index.ts'),
      '@nestos/llm-ui-adapter': path.resolve(__dirname, '../../ui/llm-ui-adapter/src/index.ts'),
      '@nestos/app-settings': path.resolve(__dirname, '../../ui/app-settings/src/index.ts'),
    },
    dedupe: ['react', 'react-dom', 'dexie', 'mermaid', '@codemirror/state', '@codemirror/view']
  },

  server: {
    port: 3000,
    open: true,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd())]
    }
  },

  optimizeDeps: {
    // 排除 workspace 包，让 Vite 直接处理源码
    exclude: [
      '@nestos/common',
      '@nestos/vfs',
      '@nestos/llm-ui-adapter',
      '@nestos/app-settings'
    ],
    // 预构建第三方依赖
    include: ['mermaid', 'dexie', 'marked', 'immer']
  },

  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) return 'vendor';
        }
      }
    }
  }
});
