import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { cwd, env } from 'node:process'

export default defineConfig(({ mode }) => {
  const configuration = loadEnv(mode, cwd(), '')
  const apiPort = env.PORT || configuration.PORT || '4000'

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
    server: {
      port: 5173,
      strictPort: true,
      allowedHosts: ['.localhost'],
      proxy: { '/api': { target: env.DRYKRAFT_API_ORIGIN || `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
    },
    build: { outDir: 'dist' },
  }
})
