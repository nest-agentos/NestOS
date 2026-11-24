import {defineConfig} from 'tsup';
import {copyFile} from 'node:fs/promises';
export default defineConfig({entry:['src/index.ts'],format:['esm','cjs'],dts:true,clean:true,sourcemap:true,
    onSuccess:async()=>{await copyFile('src/style.css','dist/style.css');}});
