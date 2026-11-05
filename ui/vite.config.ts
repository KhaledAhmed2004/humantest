import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The HumanTest UI. `npm run dev -w ui` serves it with hot reload and sends API calls
// to the HumanTest server (npm run ui, port 4800); `npm run build -w ui` writes ui/dist,
// which the server hands out at http://localhost:4800.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4800',
      '/files': 'http://localhost:4800',
    },
  },
})
