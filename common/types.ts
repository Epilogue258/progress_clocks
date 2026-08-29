/**
 * progress_clocks 统一 JSON 契约（SchemaVersion 1）
 *
 * 本文件是三端（Web / server / 外部插件）共同遵守的契约：
 * - Web 端序列化与解析
 * - server 端校验与持久化
 * - 外部插件（如 QQ Bot）直接读写该格式的 JSON
 *
 * 扩展规则：
 * - 新增字段一律可选（或顶层新增 key），旧版本解析时忽略未知键，天然向后兼容
 * - 字段命名统一 camelCase（各端序列化时映射）
 * - id 创建时生成（时间戳+随机），永不变更；同步时 id 是唯一键，冲突会互相覆盖
 */

export const SCHEMA_VERSION = 1

/** 钟的格数边界（契约级）：服务端解析与前端输入共用同一组常量，避免两端各写一份后漂移 */
export const CLOCK_MIN_SEGMENTS = 2
export const CLOCK_MAX_SEGMENTS = 10

/** 钳制为 [lo, hi] 区间内的整数 */
export function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(value)))
}

/** 房间名白名单：任意非路径分隔符/控制字符/Windows 保留字符，1-32 字符。
 * 允许中文/@/空格等自然语言（如「龙与地下城@咖啡的房间」），
 * 防目录穿越的关键是排除 / \ 与 Windows 保留字符（<>:"|?*），另排除 . 与 .. */
const ROOM_NAME_RE = /^[^/\\<>:"|?*\x00-\x1f]{1,32}$/u

export function isValidRoomName(name: unknown): name is string {
  return typeof name === 'string' && name !== '.' && name !== '..' && ROOM_NAME_RE.test(name)
}

/** 单个进度钟 */
export interface ProgressClock {
  /** 唯一 id（时间戳+随机），创建时生成、永不变更 */
  id: string
  /** 钟名（如：内部巡逻） */
  name: string
  /** 总格数（规则内常见 4/6/8，允许 2-10 自定义） */
  max: number
  /** 已填充格数，解析时 clamp 到 [0, max] */
  fill: number
  /** 显示颜色（可选，默认按创建顺序取色板） */
  color?: string
  /** 连锁钟：填满后解锁的钟 id（可选）。指向不存在的 id 时忽略，当普通钟渲染 */
  linkTo?: string
  /** 备注（可选） */
  note?: string
}

/** 完整状态：一次跑团场景 = 一份状态 JSON */
export interface ClockState {
  schemaVersion: number
  /**
   * 状态版本号：每次服务器写入 +1，用于乐观锁冲突检测。
   * 客户端 POST 时把“自己当前看到的版本”放在这里；
   * 与服务器不一致时返回 409 并附带最新状态（旧数据缺省 0）。
   */
  version: number
  clocks: Record<string, ProgressClock>
}

export function createEmptyState(): ClockState {
  return { schemaVersion: SCHEMA_VERSION, version: 0, clocks: {} }
}

/** 生成全局唯一 id（时间戳 + 随机后缀） */
export function createClockId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 解析外部 JSON 为 ClockState：
 * - 忽略未知字段（向后兼容）
 * - 修复非法值（fill>max 时 clamp；max 限制在 2-10）
 * - 任意输入都不会抛错，返回合法的状态
 */
export function parseState(raw: unknown): ClockState {
  const state = createEmptyState()
  if (typeof raw !== 'object' || raw === null) return state
  const obj = raw as Record<string, unknown>
  if (typeof obj.schemaVersion === 'number') state.schemaVersion = obj.schemaVersion
  if (typeof obj.version === 'number') state.version = obj.version
  if (obj.clocks && typeof obj.clocks === 'object') {
    for (const [id, value] of Object.entries(obj.clocks as Record<string, unknown>)) {
      const c = value as Record<string, unknown>
      if (typeof c !== 'object' || c === null) continue
      const max =
        typeof c.max === 'number' ? clampInt(c.max, CLOCK_MIN_SEGMENTS, CLOCK_MAX_SEGMENTS) : 4
      const fill = typeof c.fill === 'number' ? clampInt(c.fill, 0, max) : 0
      state.clocks[id] = {
        id,
        name: typeof c.name === 'string' ? c.name : '',
        max,
        fill,
        color: typeof c.color === 'string' ? c.color : undefined,
        linkTo: typeof c.linkTo === 'string' ? c.linkTo : undefined,
        note: typeof c.note === 'string' ? c.note : undefined,
      }
    }
  }
  return state
}
