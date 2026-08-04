import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@engine': r('./src/engine'),
      '@characters': r('./src/characters'),
      '@render': r('./src/render'),
      '@anim': r('./src/anim'),
      '@scene': r('./src/scene'),
      '@ui': r('./src/ui'),
      '@game': r('./src/game'),
      '@perf': r('./src/perf'),
    },
  },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
