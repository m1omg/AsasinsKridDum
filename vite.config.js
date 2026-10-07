import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The production build is one self-contained HTML file (code + textures inlined),
// so dist/index.html can be opened straight from disk with a double click.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  // generated character meshes (assets/models/*.bin) are inlined as data URLs
  assetsInclude: ['**/*.bin'],
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 20_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  server: { host: true },
});
