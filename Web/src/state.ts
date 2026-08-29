import type { ClockState, ProgressClock } from '../../common/types'
import {
  CLOCK_MAX_SEGMENTS,
  CLOCK_MIN_SEGMENTS,
  SCHEMA_VERSION,
  clampInt,
  createClockId,
  createEmptyState,
  parseState,
} from '../../common/types'

const STORAGE_KEY = 'progress-clocks:state'
const UNDO_LIMIT = 100

/** 粗野风格色板：按创建顺序分配，可在设置面板修改 */
export const PALETTE = [
  '#e53935', '#1e88e5', '#43a047', '#fb8c00',
  '#8e24aa', '#fdd835', '#00acc1', '#d81b60',
]

function load(): ClockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createEmptyState()
    return parseState(JSON.parse(raw))
  } catch {
    return createEmptyState()
  }
}

export class Store {
  state: ClockState
  /** 最近交互的钟：数字键 1/2/3 批量填充的目标 */
  currentClockId: string | null = null

  /**
   * 与服务器同步的基线版本（乐观锁基准）。
   * 本地操作（含撤销/重做）不改变它；仅 replaceState 与推送成功后更新——
   * 否则撤销恢复旧快照会携带过期版本，触发 409 假冲突。
   */
  private syncedVersion: number

  private undoStack: ClockState[] = []
  private redoStack: ClockState[] = []
  private listeners = new Set<() => void>()

  constructor() {
    this.state = load()
    this.syncedVersion = this.state.version
    // 给旧数据补默认颜色（按创建顺序）
    let i = 0
    for (const clock of Object.values(this.state.clocks)) {
      if (!clock.color) clock.color = PALETTE[i++ % PALETTE.length]
    }
  }

  /** 推送用的状态快照：version 恒为同步基线（避免撤销等携带旧版本） */
  get syncState(): ClockState {
    return { ...this.state, version: this.syncedVersion }
  }

  /** 推送成功回调：更新同步基线（服务器返回的新版本） */
  markSynced(version: number): void {
    this.syncedVersion = version
    this.state.version = version
    this.persist()
  }

  /** 用外部状态整体替换（server 拉取 / 数据导入）；清空撤销历史 */
  replaceState(next: ClockState): void {
    this.state = parseState(next)
    this.syncedVersion = this.state.version
    this.undoStack = []
    this.redoStack = []
    this.currentClockId = null
    this.persist()
    this.notify()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    for (const fn of this.listeners) fn()
  }

  /**
   * 统一变更入口：压入「变更前」快照 -> 执行变更 -> 落盘 -> 通知。
   *
   * 快照必须在 fn() **之前**压栈，不能在之后：
   * 变更后压栈会让栈顶恒等于当前状态，撤销时弹出的是现状自己，
   * 表现为「第一次撤销没反应、重做错乱」。
   */
  private mutate(fn: () => void): void {
    this.undoStack.push(structuredClone(this.state))
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()
    this.redoStack = []
    fn()
    this.persist()
    this.notify()
  }

  undo(): boolean {
    const prev = this.undoStack.pop()
    if (!prev) return false
    this.redoStack.push(structuredClone(this.state))
    this.state = prev
    this.persist()
    this.notify()
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push(structuredClone(this.state))
    this.state = next
    this.persist()
    this.notify()
    return true
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      // 同上
    }
  }

  // ---- 操作 ----

  createClock(name = '新钟', max = 4): ProgressClock {
    const clock: ProgressClock = {
      id: createClockId(),
      name,
      max: clampInt(max, CLOCK_MIN_SEGMENTS, CLOCK_MAX_SEGMENTS),
      fill: 0,
      color: PALETTE[Object.keys(this.state.clocks).length % PALETTE.length],
    }
    this.mutate(() => {
      this.state.clocks[clock.id] = clock
      this.currentClockId = clock.id
    })
    return clock
  }

  updateClock(id: string, patch: Partial<Omit<ProgressClock, 'id'>>): void {
    if (!this.state.clocks[id]) return
    this.mutate(() => {
      const clock = this.state.clocks[id]
      Object.assign(clock, patch)
      // 先钳 max 再钳 fill：fill 的上界就是 max。
      // 边界常量取自契约（common/types），以前这里写的是 [1,10]，
      // 与服务端 parseState 的 [2,10] 不一致——本地设 1 格推送后会被改成 2 格，刷新跳变。
      clock.max = clampInt(clock.max, CLOCK_MIN_SEGMENTS, CLOCK_MAX_SEGMENTS)
      clock.fill = clampInt(clock.fill, 0, clock.max)
    })
  }

  deleteClock(id: string): void {
    if (!this.state.clocks[id]) return
    this.mutate(() => {
      delete this.state.clocks[id]
      if (this.currentClockId === id) this.currentClockId = null
    })
  }

  /** 填充（正数）或清除（负数），默认 +1；数字键 1/2/3 走这里 */
  increment(id: string, delta = 1): void {
    if (!this.state.clocks[id]) return
    this.mutate(() => {
      const clock = this.state.clocks[id]
      clock.fill = clampInt(clock.fill + delta, 0, clock.max)
      this.currentClockId = id
    })
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
}

export { SCHEMA_VERSION }
