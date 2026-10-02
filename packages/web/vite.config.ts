import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev proxy: `npm run dev` (kernel on 8080) + `npm run dev -w @orch/web`.
    proxy: {
      '/health': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
  },
});
