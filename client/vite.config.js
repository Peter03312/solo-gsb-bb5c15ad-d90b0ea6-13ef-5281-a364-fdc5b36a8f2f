import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发环境把 /api 代理到本机后端；构建产物直接由后端托管
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
