import type { ClockState } from './types'

/**
 * 服务端 API 契约（后端为 Node 单文件，见 server/README.md）
 *
 * GET  /api/state            -> 完整状态 JSON（玩家轮询、GM 拉取）
 * POST /api/state            -> 覆盖保存（GM 端调用，全量推送；请求体为完整状态）
 * POST /api/state?token=xxx  -> 写操作带 token 鉴权（可选，见 server 设计）
 *
 * 说明：数据量几 KB、单写者（GM），全量覆盖即可，无需增量/版本/冲突处理。
 * 本地优先：Web 端可加 localStorage 缓存做离线兜底（设计阶段确认）。
 */

const DEFAULT_POLL_INTERVAL_MS = 5000

/** 拉取完整状态 */
export async function fetchState(baseUrl: string): Promise<ClockState> {
  const res = await fetch(`${baseUrl}/api/state`)
  if (!res.ok) throw new Error(`fetchState failed: ${res.status}`)
  return (await res.json()) as ClockState
}

/** 全量保存（GM 端） */
export async function saveState(baseUrl: string, state: ClockState): Promise<void> {
  const res = await fetch(`${baseUrl}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!res.ok) throw new Error(`saveState failed: ${res.status}`)
}

/** 玩家端轮询：低频变更（几分钟一次）场景下轮询比 WebSocket 更省事 */
export function pollState(
  baseUrl: string,
  onUpdate: (state: ClockState) => void,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): () => void {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      onUpdate(await fetchState(baseUrl))
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
