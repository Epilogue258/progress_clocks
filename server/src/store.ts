/**
 * 状态存储：JSON 文件持久化。
 * - 数据文件：data/state.json（运行时生成，已 gitignore）
 * - 原子写入：先写临时文件再 rename，避免写一半崩溃损坏数据
 * - 单进程单写者（GM 端），同步读写足够，无需数据库
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

/** 保存状态（原子写入 + 校验） */
export function saveState(state: ClockState): void {
  const parsed = parseState(state) // 二次校验，拒绝非法结构
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DATA_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf-8')
  renameSync(tmp, DATA_FILE)
}
