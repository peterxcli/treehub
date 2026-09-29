// Builds the extension pages (dashboard) and the background service worker into tmp/app, which
// scripts/build.js copies into every browser folder next to the content script.
import {fileURLToPath} from 'node:url';
import vue from '@vitejs/plugin-vue';
import {defineConfig} from 'vite';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: path('.'),
  // Extension pages are loaded from chrome-extension://<id>/, so assets use relative URLs
  base: './',
  publicDir: false,
  plugins: [vue()],
  build: {
    outDir: path('../tmp/app'),
    emptyOutDir: true,
    target: 'chrome114',
    // Readable output: extension stores review the code
    minify: false,
    rolldownOptions: {
      input: {
        dashboard: path('dashboard.html'),
        background: path('src/background.ts')
      },
      output: {
        // The manifest refers to background.js by name
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
