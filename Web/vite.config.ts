import { defineConfig } from 'vite'

// base './'：构建产物可部署到任意路径（云服务器子目录、IP:端口直连均可）
export default defineConfig({
  base: './',
  server: {
    host: true, // 局域网可访问，便于本地验证
  },
})
