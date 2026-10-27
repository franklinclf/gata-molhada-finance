import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The API runs on :8080 (npm start). In development Vite proxies /api to it, so the session cookie stays same-origin.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [preact()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
