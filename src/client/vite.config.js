import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': { target: 'http://localhost:6789', changeOrigin: true },
      '/ws': { target: 'ws://localhost:6789', ws: true },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
})
