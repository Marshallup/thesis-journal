import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Прокси, а не CORS: refresh живёт в httpOnly-cookie с SameSite=strict,
    // и на чужом origin браузер её просто не отправит.
    proxy: {
      '/auth': 'http://localhost:3000',
      '/trades': 'http://localhost:3000',
      '/decisions': 'http://localhost:3000',
      '/instruments': 'http://localhost:3000',
    },
  },
})
