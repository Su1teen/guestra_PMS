import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Local API by default; DASHBOARD_API_TARGET points the dev server at another environment.
const apiTarget = process.env.DASHBOARD_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/socket.io': {
        target: apiTarget,
        ws: true,
      },
    },
  },
});
