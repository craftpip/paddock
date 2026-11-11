import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { buildStamp } from './build-stamp.js'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss(), buildStamp(here)],
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
