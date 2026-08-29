/**
 * 状态存储：JSON 文件持久化（GitHub 模型：每个房间 = 一个独立「仓库」）。
 * - 默认房间（无 room 参数）：data/state.json（向后兼容，读公开 + GM_KEY 写鉴权）
 * - 命名房间：data/rooms/<name>/state.json + meta.json（密码），读写都需房间密码
 * - 原子写入：先写临时文件再 rename，避免写一半崩溃损坏数据
 * - 单进程，同步读写足够，无需数据库
 * - 乐观锁：saveState 接收期望版本，不一致时拒绝并返回最新状态（多写冲突检测）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClockState } from '../../common/types.ts'
import { createEmptyState, isValidRoomName, parseState } from '../../common/types.ts'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const DEFAULT_DATA_FILE = join(DATA_DIR, 'state.json')
const ROOMS_DIR = join(DATA_DIR, 'rooms')

/** 房间元数据：双密码模型
 * - joinPwd：加入密码（玩家只读），可空 = 公开只读
 * - gmPwd：GM 密码（写凭证），必填 ≥6 位 */
export interface RoomMeta {
  name: string
  joinPwd: string
  gmPwd: string
  createdAt: number
}

function roomStateFile(room: string): string {
  return join(ROOMS_DIR, room, 'state.json')
}

function roomMetaFile(room: string): string {
  return join(ROOMS_DIR, room, 'meta.json')
}

/** 读取状态；文件不存在或损坏时返回空状态。room 省略 = 默认房间 */
export function loadState(room?: string): ClockState {
  if (room && !isValidRoomName(room)) return createEmptyState()
  const file = room ? roomStateFile(room) : DEFAULT_DATA_FILE
  try {
    const raw = readFileSync(file, 'utf-8')
    return parseState(JSON.parse(raw))
  } catch {
    return createEmptyState()
  }
}

export type SaveResult =
  | { ok: true; state: ClockState }
  | { ok: false; current: ClockState }

/**
 * 保存状态（原子写入 + 二次校验）。
 * expectedVersion 省略 = 强制覆盖（兼容旧客户端 / 简化 Bot 调用）；
 * 提供且与当前版本不符 = 冲突，返回最新状态由客户端决定合并。
 * room 省略 = 默认房间。
 */
export function saveState(state: ClockState, expectedVersion?: number, room?: string): SaveResult {
  const parsed = parseState(state)
  const current = loadState(room)
  if (expectedVersion !== undefined && (current.version ?? 0) !== expectedVersion) {
    return { ok: false, current }
  }
  parsed.version = (current.version ?? 0) + 1
  const file = room ? roomStateFile(room) : DEFAULT_DATA_FILE
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf-8')
  renameSync(tmp, file)
  return { ok: true, state: parsed }
}

export type CreateRoomResult =
  | { ok: true; room: RoomMeta }
  | { ok: false; reason: 'invalid-name' | 'exists' | 'weak-gm-pwd' }

/** 新建房间：创建独立状态仓库 + 双密码元数据；重名/非法名/弱 GM 密码拒绝 */
export function createRoom(name: string, joinPwd: string, gmPwd: string): CreateRoomResult {
  if (!isValidRoomName(name)) return { ok: false, reason: 'invalid-name' }
  if (gmPwd.length < 6) return { ok: false, reason: 'weak-gm-pwd' }
  const dir = join(ROOMS_DIR, name)
  if (existsSync(dir)) return { ok: false, reason: 'exists' }
  mkdirSync(dir, { recursive: true })
  const meta: RoomMeta = { name, joinPwd, gmPwd, createdAt: Date.now() }
  writeFileSync(roomMetaFile(name), JSON.stringify(meta, null, 2), 'utf-8')
  writeFileSync(roomStateFile(name), JSON.stringify(createEmptyState(), null, 2), 'utf-8')
  return { ok: true, room: meta }
}

/** 读取房间元数据（含密码）；不存在或非法名返回 null */
export function loadRoomMeta(name: string): RoomMeta | null {
  if (!isValidRoomName(name)) return null
  try {
    return JSON.parse(readFileSync(roomMetaFile(name), 'utf-8')) as RoomMeta
  } catch {
    return null
  }
}

/** 房间名列表（公开：只暴露名字，不泄露状态与密码） */
export function listRooms(): string[] {
  try {
    return readdirSync(ROOMS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidRoomName(d.name))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}
