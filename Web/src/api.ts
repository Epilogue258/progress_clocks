import type { ClockState } from '../../common/types'

/**
 * 服务端 API 客户端（契约见 server/README.md）：
 *
 * GET  /api/state        -> 完整状态 JSON（公开）
 * POST /api/state        -> 全量覆盖保存（需 GM 密钥；带 version 走乐观锁）
 * GET  /api/auth-check   -> 密钥验证（GM 登录）
 * GET  /api/export.png   -> 整张导出图 PNG（公开）
 *
 * 鉴权：写操作需 Authorization: Bearer <GM_KEY>（由服务器 GM_KEY 环境变量决定是否启用）
 * 冲突：POST 时 version 与服务器不一致 -> 409 + 最新状态（ApiError.latest）
 */

/** API 错误：带 HTTP 状态码；409 时附带服务器最新状态 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 409 冲突时服务器返回的最新状态 */
    public readonly latest?: ClockState,
  ) {
    super(message)
  }
}

function authHeaders(key?: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/** 拉取完整状态（公开接口） */
export async function fetchState(baseUrl: string): Promise<ClockState> {
  const res = await fetch(`${baseUrl}/api/state`)
  if (!res.ok) throw new ApiError(res.status, `获取状态失败: ${res.status}`)
  return (await res.json()) as ClockState
}

/** 全量保存（GM 端）：带密钥鉴权；state.version = 客户端当前看到的版本（乐观锁）
 *  返回服务器保存后的新版本号，调用方用于更新本地同步基线 */
export async function saveState(
  baseUrl: string,
  state: ClockState,
  key?: string,
): Promise<number> {
  const res = await fetch(`${baseUrl}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify(state),
  })
  if (res.status === 409) {
    const body = (await res.json()) as { state?: ClockState }
    throw new ApiError(409, '冲突：状态已在别处更新', body.state)
  }
  if (!res.ok) throw new ApiError(res.status, `保存失败: ${res.status}`)
  const body = (await res.json()) as { version?: number }
  return body.version ?? 0
}

/** 验证 GM 密钥是否有效（成功返回 true） */
export async function verifyKey(baseUrl: string, key: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/auth-check`, { headers: authHeaders(key) })
    return res.ok
  } catch {
    return false
  }
}

// ---------- 房间（GitHub 模型：一个 server 多房间，双密码：joinPwd 只读 / gmPwd 写） ----------

function roomHeaders(pwd: string): Record<string, string> {
  return { Authorization: `Bearer ${pwd}` }
}

/** 房间列表（公开） */
export async function listRooms(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/rooms`)
  if (!res.ok) throw new ApiError(res.status, `获取房间列表失败: ${res.status}`)
  const body = (await res.json()) as { rooms?: string[] }
  return body.rooms ?? []
}

/** 新建房间：joinPwd 玩家只读（可空 = 公开），gmPwd 写凭证（必填 ≥6 位） */
export async function createRoom(
  baseUrl: string,
  name: string,
  joinPwd: string,
  gmPwd: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, joinPwd, gmPwd }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? `创建房间失败: ${res.status}`)
  }
}

/** 拉取房间状态（需加入密码；空 = 公开只读房间） */
export async function fetchRoomState(baseUrl: string, room: string, joinPwd: string): Promise<ClockState> {
  const res = await fetch(`${baseUrl}/api/room/${encodeURIComponent(room)}/state`, {
    headers: joinPwd ? roomHeaders(joinPwd) : {},
  })
  if (!res.ok) throw new ApiError(res.status, `获取房间状态失败: ${res.status}`)
  return (await res.json()) as ClockState
}

/** 全量保存房间状态（需 GM 密码；state.version = 乐观锁基线） */
export async function saveRoomState(
  baseUrl: string,
  room: string,
  gmPwd: string,
  state: ClockState,
): Promise<number> {
  const res = await fetch(`${baseUrl}/api/room/${encodeURIComponent(room)}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...roomHeaders(gmPwd) },
    body: JSON.stringify(state),
  })
  if (res.status === 409) {
    const body = (await res.json()) as { state?: ClockState }
    throw new ApiError(409, '冲突：状态已在别处更新', body.state)
  }
  if (!res.ok) throw new ApiError(res.status, `保存房间状态失败: ${res.status}`)
  const body = (await res.json()) as { version?: number }
  return body.version ?? 0
}

/** 验证 GM 密码是否有效（密码正确 = 该房间 GM，可写） */
export async function verifyRoomKey(baseUrl: string, room: string, gmPwd: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/room/${encodeURIComponent(room)}/auth-check`, {
      headers: roomHeaders(gmPwd),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 玩家端轮询：低频变更（几分钟一次）场景下轮询比 WebSocket 更省事 */
export function pollState(
  baseUrl: string,
  onUpdate: (state: ClockState) => void,
  intervalMs: number = 5000,
  room?: string,
  pwd?: string,
): () => void {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      onUpdate(await (room ? fetchRoomState(baseUrl, room, pwd ?? '') : fetchState(baseUrl)))
    } catch {
      // 网络错误静默，下次轮询重试
    }
  }
  void tick()
  const timer = setInterval(tick, intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
