import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts','src/startup.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: true,
  external: []  // Common has no runtime package dependencies.
});
