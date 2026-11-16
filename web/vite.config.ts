import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Dev ports are overridable so several developers can run side by side:
//   WEB_PORT=5173 API_PORT=5555 npm run dev
const API_PORT = Number(process.env.API_PORT || process.env.PORT || 5555);
const WEB_PORT = Number(process.env.WEB_PORT || 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@shared': path.resolve(import.meta.dirname, '../shared'),
    },
  },
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${API_PORT}` },
    fs: { allow: ['..'] },
  },
  build: {
    chunkSizeWarningLimit: 6000,
  },
});
