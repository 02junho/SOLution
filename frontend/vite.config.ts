import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 화면은 Spring(/api)만 부른다. FastAPI는 화면에서 직접 부르지 않는다.
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL ?? 'http://localhost:8080',
        // 화면을 5174·127.0.0.1처럼 다른 주소로 열면 브라우저가 붙인 Origin이 Spring 허용 주소(5173)와 달라
        // 저장 요청(POST)이 403으로 막힌다. 같은 출처인 개발 프록시에서는 Origin을 떼고 넘긴다.
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => request.removeHeader('origin'))
        },
      },
    },
  },
})

