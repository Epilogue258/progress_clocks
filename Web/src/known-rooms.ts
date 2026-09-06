/**
 * 已知房间：加入过的房间连同服务器地址与密码记在本机，下次点一下就切过去，不用重敲密码。
 *
 * 密码是明文进 localStorage 的——和既有的 ROOM_GM_STORAGE 一个路子，
 * 威胁模型是「设备归本人所有」。真正在意就用侧边栏的 ✕ 忘掉它。
 */

export interface KnownRoom {
  /** 服务器基址（'' = 同源托管） */
  server: string
  /** 房间名 */
  room: string
  /** 加入密码（只读凭证，'' = 公开房间） */
  joinPwd: string
  /** GM 密码（写凭证），没有则 '' */
  gmPwd: string
  /** 最近进入时间，用于排序与淘汰 */
  lastAt: number
}

const KEY = 'progress-clocks:known-rooms'
const LIMIT = 12

export function loadKnownRooms(): KnownRoom[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is KnownRoom =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as KnownRoom).room === 'string' &&
        typeof (x as KnownRoom).server === 'string',
    )
  } catch {
    return []
  }
}

function save(list: KnownRoom[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // 存不下就算了：缓存丢了顶多是重新输一次密码
  }
}

/** 记住（或刷新）一个房间，排到最前；超出上限就淘汰最久没进的 */
export function rememberRoom(entry: Omit<KnownRoom, 'lastAt'>): void {
  const rest = loadKnownRooms().filter((r) => !(r.server === entry.server && r.room === entry.room))
  rest.unshift({ ...entry, lastAt: Date.now() })
  save(rest.slice(0, LIMIT))
}

/** 忘记一个房间：只清本机缓存，不动服务器上的房间 */
export function forgetRoom(server: string, room: string): void {
  save(loadKnownRooms().filter((r) => !(r.server === server && r.room === room)))
}
