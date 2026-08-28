/**
 * progress_clocks server：Node 原生 http，零框架。
 *
 * API 一览：
 *   GET  /api/state        -> 200 JSON 完整状态（玩家轮询 / GM 拉取 / 外部插件读取）
 *   POST /api/state        -> 请求体为完整状态 JSON，校验后原子写入 data/state.json
 *   GET  /api/export.png   -> 200 PNG 整张导出图（QQ Bot 等外部插件调用）
 *   GET  /api/export.svg   -> 200 SVG 导出图（调试 / 自定义处理）
 *   GET  /*                 -> 静态托管 Web 构建产物（Web/dist）
 *
 * 配置（环境变量）：
 *   PORT  监听端口（默认 2333）
 *
 * 说明：
 * - 单写者模型（GM 端全量覆盖），无冲突处理，无需数据库
 * - 写鉴权未实现（信任环境 / 局域网）；如需公网暴露请自行加反向代理
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildExportSvg } from '../../common/export-svg.ts'
import { loadState, saveState } from './store.ts'
import { renderPng } from './render.ts'

const PORT = Number(process.env.PORT || 2333)
const DIST_DIR = join(fileURLToPath(new URL('..', import.meta.url)), '..', 'Web', 'dist')
const MAX_BODY = 1 * 1024 * 1024 // 请求体上限 1MB

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** 读取请求体（限制大小，防滥用） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/** 静态文件托管（防目录穿越） */
async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const isRoot = pathname === '/'
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  // 根路径或目录请求回退 index.html（SPA 惯例）
  // 注意：Windows 上 normalize('/') 会变成 '\'，因此不能直接比较 safePath
  const filePath = join(DIST_DIR, isRoot || safePath.endsWith('/') || safePath.endsWith('\\') ? 'index.html' : safePath)
  // 防目录穿越：解析后的路径必须仍在 dist 目录内
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  }
}

const server = createServer(async (req, res) => {
  // CORS：允许独立部署的 Web 端 / 外部插件跨域访问
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  try {
    // 获取状态
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, loadState())
      return
    }

    // 提交状态（全量覆盖）
    if (req.method === 'POST' && url.pathname === '/api/state') {
      const body = await readBody(req)
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        json(res, 400, { ok: false, error: 'JSON 解析失败' })
        return
      }
      saveState(parsed) // store 内部会二次校验 + 容错
      json(res, 200, { ok: true })
      return
    }

    // 导出图片（PNG / SVG）
    if (req.method === 'GET' && url.pathname === '/api/export.png') {
      const png = renderPng(loadState())
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      res.end(png)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/export.svg') {
      const svg = buildExportSvg(loadState())
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(svg)
      return
    }

    // 其余路径：静态托管
    await serveStatic(res, url.pathname)
  } catch (err) {
    console.error('[server] 处理请求出错:', err)
    json(res, 500, { ok: false, error: '服务器内部错误' })
  }
})

server.listen(PORT, () => {
  console.log(`进度钟 server 已启动: http://localhost:${PORT}`)
  console.log(`  状态 API:   GET/POST /api/state`)
  console.log(`  导出图片:   GET /api/export.png  |  /api/export.svg`)
  console.log(`  静态托管:   Web/dist（先执行 Web 目录下 npm run build）`)
})
