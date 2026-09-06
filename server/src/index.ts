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
 *   PORT   监听端口（默认 2333）
 *   GM_KEY 写鉴权密钥（设置后 POST /api/state 需带 Authorization: Bearer <GM_KEY>；
 *          不设置 = 不鉴权，仅限开发/局域网信任环境）
 *
 * 多写冲突：POST 请求体带 version（= 客户端当前看到的版本），与服务器不一致时
 * 返回 409 + 最新状态，客户端拉取合并后重试。不带 version = 强制覆盖。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildExportSvg } from '../../common/export-svg.ts'
import { createRoom, deleteRoom, listRooms, loadRoomMeta, loadState, renameRoom, saveState, updateRoomMeta } from './store.ts'
import { renderPng } from './render.ts'

// 加载 .env（可选）：存在则读取，不存在则用系统环境变量（生产部署可直接删掉 .env）
try {
  process.loadEnvFile()
} catch {
  // .env 不存在：静默，依赖系统环境变量
}

const PORT = Number(process.env.PORT || 2333)
const GM_KEY = process.env.GM_KEY
const DIST_DIR = join(fileURLToPath(new URL('..', import.meta.url)), '..', 'Web', 'dist')
const MAX_BODY = 1 * 1024 * 1024 // 请求体上限 1MB

/** 写鉴权：请求需带 Authorization: Bearer <GM_KEY>（或 ?key= 查询参数） */
function checkAuth(req: IncomingMessage): boolean {
  if (!GM_KEY) return true // 未设置密钥 = 不鉴权
  const header = req.headers['authorization']
  if (header === `Bearer ${GM_KEY}`) return true
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key')
  return query === GM_KEY
}

/** 房间路由解析：/api/room/<name>/<action>（action 可省略 = 删除），非法路径或非法编码返回 null */
function parseRoomPath(
  pathname: string,
): { room: string; action: 'state' | 'export.png' | 'export.svg' | 'auth-check' | 'rename' | 'delete' } | null {
  const m = /^\/api\/room\/([^/]+)(?:\/(state|export\.png|export\.svg|auth-check|rename))?$/.exec(pathname)
  if (!m) return null
  let room: string
  try {
    room = decodeURIComponent(m[1])
  } catch {
    // 非法 UTF-8 编码：直接拒绝（落到静态托管 404，不抛 500）
    return null
  }
  return { room, action: (m[2] ?? 'delete') as 'state' | 'export.png' | 'export.svg' | 'auth-check' | 'rename' | 'delete' }
}

/** 解析并保存状态（默认房间或命名房间）：JSON 解析 + 乐观锁 + 冲突响应 */
async function handleSaveState(req: IncomingMessage, res: ServerResponse, room?: string): Promise<void> {
  const body = await readBody(req)
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    json(res, 400, { ok: false, error: 'JSON 解析失败' })
    return
  }
  // 直接从原始请求体读取 version：省略 = 强制覆盖（兼容旧客户端 / 简化 Bot 调用）
  const rawVersion = (parsed as Record<string, unknown>)?.version
  const expected = typeof rawVersion === 'number' ? rawVersion : undefined
  const result = saveState(parsed, expected, room)
  if (result.ok) {
    json(res, 200, { ok: true, version: result.state.version })
  } else {
    // 冲突：返回最新状态，客户端拉取合并
    json(res, 409, { ok: false, error: '冲突：状态已在别处更新', state: result.current })
  }
}

/** 导出图（默认房间或命名房间，PNG / SVG） */
function sendExport(res: ServerResponse, room: string | undefined, format: 'png' | 'svg'): void {
  const state = loadState(room)
  if (format === 'png') {
    const png = renderPng(state)
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(png)
  } else {
    const svg = buildExportSvg(state)
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(svg)
  }
}

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

/** 请求体超限。单独一个类型，好和内部错误区分开——回 413 而不是 500 */
class BodyTooLargeError extends Error {}

/** 读取请求体（限制大小，防滥用）。
 *  超限时不能立刻回 413：请求体还没消费完就 end 响应，Node 会强制关掉连接，
 *  客户端只看到 Empty reply / RemoteDisconnected，拿不到「请求体过大」这个明确原因。
 *  正确姿势是继续把剩余数据读完（丢弃），等 end 再 reject——连接自然走完，413 才能送达。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return // 已超限：继续消费但丢弃，好让连接走完、413 能送出去
      size += chunk.length
      if (size > MAX_BODY) {
        tooLarge = true
        chunks.length = 0 // 数据不全，别再给调用方半截内容
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) reject(new BodyTooLargeError('请求体过大'))
      else resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => reject(err))
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
    // html 不缓存：index.html 引用带 hash 的资源，入口页始终检查最新，避免浏览器缓存旧构建
    // sw.js 同样不缓存：浏览器靠它感知 Service Worker 更新，被缓存住会卡住整版升级
    const isHtml = extname(filePath) === '.html'
    const noCache = isHtml || filePath.endsWith('sw.js')
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      ...(noCache ? { 'Cache-Control': 'no-cache' } : {}),
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  }
}

const server = createServer(async (req, res) => {
  // CORS：允许独立部署的 Web 端 / 外部插件跨域访问
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  // 注意：跨域（分离模式 file:// 或异源托管）时带 Authorization 头必须 preflight 放行
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  try {
    // ---- 房间（GitHub 模型：一个 server 多房间，密码 = 读写鉴权） ----

    // 房间列表（公开）
    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      json(res, 200, { rooms: listRooms() })
      return
    }

    // 新建房间（双密码模型：joinPwd 玩家只读可空，gmPwd 写凭证必填 ≥6 位）
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readBody(req)
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        json(res, 400, { ok: false, error: 'JSON 解析失败' })
        return
      }
      const obj = parsed as Record<string, unknown>
      const name = typeof obj?.name === 'string' ? obj.name.trim() : ''
      const joinPwd = typeof obj?.joinPwd === 'string' ? obj.joinPwd : ''
      const gmPwd = typeof obj?.gmPwd === 'string' ? obj.gmPwd : ''
      if (gmPwd.length < 6) {
        json(res, 400, { ok: false, error: 'GM 密码至少 6 位' })
        return
      }
      const result = createRoom(name, joinPwd, gmPwd)
      if (result.ok) {
        json(res, 200, { ok: true, room: result.room.name })
      } else if (result.reason === 'exists') {
        json(res, 409, { ok: false, error: '房间已存在' })
      } else if (result.reason === 'weak-gm-pwd') {
        json(res, 400, { ok: false, error: 'GM 密码至少 6 位' })
      } else {
        json(res, 400, { ok: false, error: '非法房间名：不能含 / \ 或 Windows 保留字符，1-32 字符' })
      }
      return
    }

    // 房间状态 / 导出图 / 密钥验证（双密码：读用 joinPwd 可空=公开，写用 gmPwd）
    const roomPath = parseRoomPath(url.pathname)
    if (roomPath) {
      const { room, action } = roomPath
      const meta = loadRoomMeta(room)
      if (!meta) {
        json(res, 404, { ok: false, error: '房间不存在' })
        return
      }
      const bearer = req.headers['authorization']
      // 修改房间密码：需 GM 密码；只改请求体里传了的字段（joinPwd / gmPwd）。
      // 对外 API（同导出图）：Bot 等外部插件也能调用，前端与插件共用同一契约
      if (req.method === 'PATCH') {
        if (bearer !== `Bearer ${meta.gmPwd}`) {
          json(res, 401, { ok: false, error: '未授权：需要 GM 密码' })
          return
        }
        const body = await readBody(req)
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          json(res, 400, { ok: false, error: 'JSON 解析失败' })
          return
        }
        const obj = parsed as Record<string, unknown>
        const joinPwd = typeof obj?.joinPwd === 'string' ? obj.joinPwd : undefined
        const gmPwd = typeof obj?.gmPwd === 'string' ? obj.gmPwd : undefined
        if (joinPwd === undefined && gmPwd === undefined) {
          json(res, 400, { ok: false, error: '没有要修改的字段（joinPwd / gmPwd）' })
          return
        }
        const result = updateRoomMeta(room, { joinPwd, gmPwd })
        if (!result.ok) {
          if (result.reason === 'weak-gm-pwd') {
            json(res, 400, { ok: false, error: 'GM 密码至少 6 位' })
          } else {
            json(res, 404, { ok: false, error: '房间不存在' })
          }
          return
        }
        json(res, 200, { ok: true, room: result.room })
        return
      }
      // 删除房间：需 GM 密码（不可恢复，调用方必须确认）
      if (req.method === 'DELETE') {
        if (bearer !== `Bearer ${meta.gmPwd}`) {
          json(res, 401, { ok: false, error: '未授权：需要 GM 密码' })
          return
        }
        deleteRoom(room)
        json(res, 200, { ok: true })
        return
      }
      // 重命名房间：需 GM 密码；新名字冲突 409；改名后旧名字立即 404（玩家需换新仓库）
      if (action === 'rename') {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        if (bearer !== `Bearer ${meta.gmPwd}`) {
          json(res, 401, { ok: false, error: '未授权：需要 GM 密码' })
          return
        }
        const body = await readBody(req)
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          json(res, 400, { ok: false, error: 'JSON 解析失败' })
          return
        }
        const newName = ((parsed as Record<string, unknown>)?.name as string | undefined)?.trim() ?? ''
        if (!newName) {
          json(res, 400, { ok: false, error: '缺少新房间名（name）' })
          return
        }
        const result = renameRoom(room, newName)
        if (!result.ok) {
          if (result.reason === 'exists') {
            json(res, 409, { ok: false, error: '新房间名已存在' })
          } else if (result.reason === 'invalid-name') {
            json(res, 400, { ok: false, error: '非法房间名：不能含 / \ 或 Windows 保留字符，1-32 字符' })
          } else {
            json(res, 404, { ok: false, error: '房间不存在' })
          }
          return
        }
        json(res, 200, { ok: true, room: result.room })
        return
      }
      // GM 密码验证（写权限确认，GM 登录用）
      if (action === 'auth-check') {
        if (bearer === `Bearer ${meta.gmPwd}`) {
          json(res, 200, { ok: true, gm: true })
        } else {
          json(res, 401, { ok: false, error: '未授权：GM 密码错误' })
        }
        return
      }
      // 写：需 GM 密码
      if (action === 'state' && req.method === 'POST') {
        if (bearer !== `Bearer ${meta.gmPwd}`) {
          json(res, 401, { ok: false, error: '未授权：需要 GM 密码' })
          return
        }
        await handleSaveState(req, res, room)
        return
      }
      // 读 / 导出：需加入密码（空 = 公开只读）
      if (meta.joinPwd !== '' && bearer !== `Bearer ${meta.joinPwd}`) {
        json(res, 401, { ok: false, error: '未授权：加入密码错误' })
        return
      }
      if (action === 'state') {
        if (req.method === 'GET') {
          json(res, 200, loadState(room))
          return
        }
        json(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      if (action === 'export.png' || action === 'export.svg') {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        sendExport(res, room, action === 'export.png' ? 'png' : 'svg')
        return
      }
      json(res, 404, { ok: false, error: '未找到' })
      return
    }

    // 获取状态（默认房间，读公开）
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, loadState())
      return
    }

    // 密钥验证（GM 登录时确认自己能写）
    if (req.method === 'GET' && url.pathname === '/api/auth-check') {
      if (checkAuth(req)) {
        json(res, 200, { ok: true, gm: true })
      } else {
        json(res, 401, { ok: false, error: '未授权：GM 密钥无效' })
      }
      return
    }

    // 提交状态（全量覆盖 + 乐观锁）
    if (req.method === 'POST' && url.pathname === '/api/state') {
      if (!checkAuth(req)) {
        json(res, 401, { ok: false, error: '未授权：需要 GM 密钥' })
        return
      }
      await handleSaveState(req, res)
      return
    }

    // 导出图片（PNG / SVG）
    if (req.method === 'GET' && url.pathname === '/api/export.png') {
      sendExport(res, undefined, 'png')
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/export.svg') {
      sendExport(res, undefined, 'svg')
      return
    }

    // 其余路径：静态托管
    await serveStatic(res, url.pathname)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { ok: false, error: `请求体过大（上限 ${MAX_BODY / 1024 / 1024}MB）` })
      return
    }
    console.error('[server] 处理请求出错:', err)
    json(res, 500, { ok: false, error: '服务器内部错误' })
  }
})

server.listen(PORT, () => {
  console.log(`进度钟 server 已启动: http://localhost:${PORT}`)
  console.log(`  状态 API:   GET/POST /api/state（POST 需鉴权）`)
  console.log(`  鉴权验证:   GET /api/auth-check`)
  console.log(`  导出图片:   GET /api/export.png  |  /api/export.svg`)
  console.log(`  房间:       GET/POST /api/rooms | GET/POST /api/room/<name>/state | PATCH/DELETE /api/room/<name>（密码=读写鉴权）`)
  console.log(`  静态托管:   Web/dist（先执行 Web 目录下 npm run build）`)
  if (GM_KEY) {
    console.log(`  写鉴权:     已启用（GM_KEY 已设置；请求带 Authorization: Bearer <GM_KEY>）`)
  } else {
    console.log(`  写鉴权:     未启用（未设置 GM_KEY；公网暴露请务必设置）`)
  }
})
