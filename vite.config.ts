import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' },
  plugins: [{
    name: 'include-third-party-license',
    generateBundle() {
      this.emitFile({
        type: 'asset', fileName: 'licenses/mediabunny-MPL-2.0.txt',
        source: readFileSync(new URL('./node_modules/mediabunny/LICENSE', import.meta.url), 'utf8'),
      });
    },
  }],
});
