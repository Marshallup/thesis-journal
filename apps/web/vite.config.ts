import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Префикс пустой: у переменной нет VITE_, иначе она уехала бы в бандл.
  // Каталог относительный, чтобы обойтись без process.cwd() и node-типов.
  const env = loadEnv(mode, '.', '')

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // Прокси, а не CORS: refresh живёт в httpOnly-cookie с SameSite=strict,
      // и на чужом origin браузер её просто не отправит.
      proxy: {
        // Дефолт — чтобы свежий клон поднимался без копирования шаблона.
        '/api': env.API_PROXY_TARGET || 'http://localhost:3000',
        // Сокет живого итога: без ws: true dev-сервер отвечает на рукопожатие
        // обычным запросом, и соединение не открывается вовсе.
        '/ws': {
          target: env.API_PROXY_TARGET || 'http://localhost:3000',
          ws: true,
        },
      },
    },
  }
})
