/**
 * 本地房间：只活在本机、永远可编辑、永不联网。
 *
 * 与远端房间（GitHub 模型）完全隔离——本地改动对 local 房间而言就是终点，
 * 不存在「待推送」这回事；想上云就手动「提交本地房间」（见 main.ts）。
 *
 * 本模块只存「名字 + 来源」这份注册表；状态本体按房间分槽存 localStorage，
 * 由 Store.attachSlot 读写（见 state.ts）。拆开是为了让 Store 的撤销栈、
 * 显示顺序天然按房间隔离，不用在这里维护第二份状态副本。
 */

import type { ClockState } from '../../common/types'
import { parseState } from '../../common/types'

const KEY = 'progress-clocks:local-rooms'

export interface LocalRoomMeta {
  name: string
  /** 来源远端（另存为本地时记录），提交本地房间时优先一键回推 */
  origin?: { server: string; room: string }
}

function load(): Record<string, LocalRoomMeta> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, LocalRoomMeta> = {}
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
      const o = v as Partial<LocalRoomMeta>
      if (typeof o !== 'object' || o === null) continue
      const meta: LocalRoomMeta = { name }
      if (o.origin && typeof o.origin.server === 'string' && typeof o.origin.room === 'string') {
        meta.origin = { server: o.origin.server, room: o.origin.room }
      }
      out[name] = meta
    }
    return out
  } catch {
    return {}
  }
}

function save(rooms: Record<string, LocalRoomMeta>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rooms))
  } catch {
    // 存不下就算了：本地房间丢了顶多是重建
  }
}

export function listLocalRooms(): string[] {
  return Object.keys(load()).sort()
}

export function getLocalOrigin(name: string): { server: string; room: string } | undefined {
  return load()[name]?.origin
}

/** 记住一个本地房间（含可选的来源远端）；重复记忆会覆盖 */
export function rememberLocalRoom(name: string, origin?: { server: string; room: string }): void {
  const rooms = load()
  rooms[name] = { name, ...(origin ? { origin } : {}) }
  save(rooms)
}

/** 忘记一个本地房间：只清注册表，状态槽由调用方负责清理 */
export function forgetLocalRoom(name: string): void {
  const rooms = load()
  delete rooms[name]
  save(rooms)
}

/** 本地房间的状态存储槽键：注册表与状态本体分离，各管各的 */
export function localSlotKey(name: string): string {
  return `progress-clocks:local:${name}`
}

/** 解析一个本地房间槽位里的状态（不存在返回空状态） */
export function loadLocalState(name: string): ClockState {
  try {
    const raw = localStorage.getItem(localSlotKey(name))
    return raw ? parseState(JSON.parse(raw)) : { schemaVersion: 1, version: 0, clocks: {} }
  } catch {
    return { schemaVersion: 1, version: 0, clocks: {} }
  }
}

/** 删除本地房间的状态槽 */
export function clearLocalState(name: string): void {
  try {
    localStorage.removeItem(localSlotKey(name))
  } catch {
    // 忽略
  }
}

/**
 * 重名顺延：取第一个空位 `name(2)`、`name(3)`…（不是无脑 +1）。
 * 与「另存为本地」同一套命名规则，保证两边行为一致。
 */
export function nextLocalName(base: string): string {
  const existing = new Set(listLocalRooms())
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}(${n})`)) n++
  return `${base}(${n})`
}
