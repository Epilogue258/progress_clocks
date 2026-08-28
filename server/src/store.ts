/**
 * 状态存储：JSON 文件持久化。
 * - 数据文件：data/state.json（运行时生成，已 gitignore）
 * - 原子写入：先写临时文件再 rename，避免写一半崩溃损坏数据
 * - 单进程，同步读写足够，无需数据库
 * - 乐观锁：saveState 接收期望版本，不一致时拒绝并返回最新状态（多写冲突检测）
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClockState } from '../../common/types.ts'
import { createEmptyState, parseState } from '../../common/types.ts'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const DATA_FILE = join(DATA_DIR, 'state.json')

/** 读取当前状态；文件不存在或损坏时返回空状态 */
export function loadState(): ClockState {
  try {
    const raw = readFileSync(DATA_FILE, 'utf-8')
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
 */
export function saveState(state: ClockState, expectedVersion?: number): SaveResult {
  const parsed = parseState(state)
  const current = loadState()
  if (expectedVersion !== undefined && (current.version ?? 0) !== expectedVersion) {
    return { ok: false, current }
  }
  parsed.version = (current.version ?? 0) + 1
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DATA_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf-8')
  renameSync(tmp, DATA_FILE)
  return { ok: true, state: parsed }
}
