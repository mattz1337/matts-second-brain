import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Scan application imports rather than retained HTML in the private data directory.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/.data/**',
        '**/.secrets/**',
        '**/build/**',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/*-nas-spike.tar',
        '**/.tmp-*-nas-spike.tar*',
      ],
    },
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: { manualChunks: { graph: ['three'], react: ['react', 'react-dom'] } },
    },
  },
});
