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
import { loadOrder, moveItem, normalizeOrder, saveOrder, sortByOrder } from './clock-order'

const STORAGE_KEY = 'progress-clocks:state'
const UNDO_LIMIT = 100

/**
 * 变更类型。
 * - data：契约数据变了，需要同步到服务器
 * - order：仅本地显示顺序变了，不推送（顺序是本机的视图偏好）
 */
export type ChangeKind = 'data' | 'order'

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

  /** 本地显示顺序（钟 id 的排列），仅本机有效，不参与同步 */
  order: string[]

  private undoStack: ClockState[] = []
  private redoStack: ClockState[] = []
  private listeners = new Set<(kind: ChangeKind) => void>()

  constructor() {
    this.state = load()
    this.order = normalizeOrder(Object.keys(this.state.clocks), loadOrder())
    // 给旧数据补默认颜色（按创建顺序）
    let i = 0
    for (const clock of Object.values(this.state.clocks)) {
      if (!clock.color) clock.color = PALETTE[i++ % PALETTE.length]
    }
  }

  /** 按本地顺序排列的钟（渲染用） */
  get visibleClocks(): ProgressClock[] {
    return sortByOrder(Object.values(this.state.clocks), this.order)
  }

  /**
   * 拖动排序：把 fromId 移到第 toIndex 位。
   * 只改本地顺序——不进撤销栈（排序不是数据变更），也不触发同步。
   */
  reorderClock(fromId: string, toIndex: number): void {
    const ids = this.visibleClocks.map((c) => c.id)
    this.order = normalizeOrder(ids, moveItem(ids, fromId, toIndex))
    saveOrder(this.order)
    this.notify('order')
  }

  /**
   * 把「当前钟」切到相邻的一个（按显示顺序，首尾相接）。
   * 只改选中态，不碰数据——所以不进撤销栈、不通知，由调用方 rerender。
   */
  moveCurrent(delta: number): boolean {
    const ids = this.visibleClocks.map((c) => c.id)
    if (ids.length === 0) return false
    const at = this.currentClockId ? ids.indexOf(this.currentClockId) : -1
    if (at === -1) {
      this.currentClockId = delta > 0 ? ids[0] : ids[ids.length - 1]
    } else {
      this.currentClockId = ids[(at + delta + ids.length) % ids.length]
    }
    return true
  }

  /**
   * 推送用的状态快照：不带 version。
   *
   * 推送是主动操作（用户改了钟 / 点了保存），按「多个客户端、一个作者」的假设
   * 应当最后写入者胜——带上 version，会让刚在别处（Bot / 手机）动过同一房间的
   * GM 反而撞上 409。服务端对 version 非数字的写入走强制覆盖路径。
   * 409 分支保留给仍然带 version 的客户端（QQ Bot）。
   */
  get pushState(): ClockState {
    const { version: _dropped, ...rest } = this.state
    return rest as ClockState
  }

  /**
   * 推送成功回调：记下服务端返回的新版本。
   * 不再用于乐观锁，但仍必须记——轮询靠比对 version 决定要不要 replaceState，
   * 本地版本落后服务端时会被判为「远端有更新」而替换，白白清掉撤销栈与选中态。
   */
  markSynced(version: number): void {
    this.state.version = version
    this.persist()
  }

  /** 用外部状态整体替换（server 拉取 / 数据导入）；清空撤销历史 */
  replaceState(next: ClockState): void {
    this.state = parseState(next)
    this.undoStack = []
    this.redoStack = []
    this.currentClockId = null
    // 服务器数据可能增删了钟：顺手把顺序里的失效 id 剔掉、新 id 补到末尾
    this.order = normalizeOrder(Object.keys(this.state.clocks), this.order)
    this.persist()
    this.notify()
  }

  subscribe(fn: (kind: ChangeKind) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(kind: ChangeKind = 'data') {
    for (const fn of this.listeners) fn(kind)
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
    // 删除后把选中态落到相邻的一个，而不是清空：
    // 连续按 Delete、或删完继续用方向键时，焦点不会莫名其妙丢掉。
    // 取值必须在 mutate 之前——那时钟还没被移除。
    const ids = this.visibleClocks.map((c) => c.id)
    const at = ids.indexOf(id)
    const fallback = ids[at + 1] ?? ids[at - 1] ?? null
    this.mutate(() => {
      delete this.state.clocks[id]
      if (this.currentClockId === id) this.currentClockId = fallback
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
