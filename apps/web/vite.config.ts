import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // The front is a client of the public API like any other; in development it
  // proxies rather than hard-coding a host.
  server: { proxy: { '/api': 'http://localhost:8787' } },
  plugins: [react()],
})
