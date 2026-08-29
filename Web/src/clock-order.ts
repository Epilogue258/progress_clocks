/**
 * 钟的显示顺序（纯本地偏好，不参与同步）。
 *
 * 顺序是「视图偏好」而不是契约数据：服务器、导出图、QQ Bot 都不关心它，
 * 因此单独存一个 localStorage 键，不写进 ClockState——契约保持零改动。
 */

const ORDER_KEY = 'progress-clocks:order'

export function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
  } catch {
    // 存储失败（隐私模式等）静默：顺序退化为「本次会话内有效」
  }
}

/** 把 fromId 移到目标下标 to；to 以「移除自己之后」的序列为准 */
export function moveItem(ids: string[], fromId: string, to: number): string[] {
  const next = ids.filter((id) => id !== fromId)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, fromId)
  return next
}

/**
 * 以当前可见的钟为基准重整顺序：
 * 保留仍是有效 id 的旧顺序，把新出现的钟追加到末尾，丢弃已删除的钟。
 * 每次排序后都跑一遍，避免 order 随增删长期累积成垃圾。
 */
export function normalizeOrder(visibleIds: string[], order: string[]): string[] {
  const visible = new Set(visibleIds)
  const kept = order.filter((id) => visible.has(id))
  const seen = new Set(kept)
  return [...kept, ...visibleIds.filter((id) => !seen.has(id))]
}

/**
 * 按 order 排序。未出现在 order 里的（如刚从别处同步过来的新钟）排到末尾。
 *
 * 两者都不在 order 里时比较结果为 0，靠 Array.sort 的稳定性保持传入顺序——
 * 也就是 state.clocks 的插入顺序。这比「按 id 字符串排序」更贴近创建先后：
 * id 是「时间戳 + 随机后缀」，同一毫秒内创建的钟按 id 排出来的顺序是随机的。
 */
export function sortByOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return ra - rb
  })
}
