/**
 * 已知服务器：连接过的服务器地址记在本机，连接弹窗里点一下即可选中，不必重敲。
 *
 * 典型场景：玩家把 PWA 装到手机上，GM 在群里发来服务器地址——第一次填一遍，
 * 之后（包括安装版与浏览器版各自独立存储的第一次之后）打开弹窗点选即连。
 *
 * 地址是明文存的，与 known-rooms 一个路子：威胁模型是「设备归本人所有」。
 */

const KEY = 'progress-clocks:known-servers'
const LIMIT = 8

/** 读取已知服务器（最近使用的在前）；'' = 同源托管，不记——它是默认值，选不选无区别 */
export function loadKnownServers(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 记住（或刷新到最前）一个服务器地址；超出上限淘汰最久没用的 */
export function rememberServer(base: string): void {
  const trimmed = base.trim()
  if (!trimmed) return
  const rest = loadKnownServers().filter((s) => s !== trimmed)
  rest.unshift(trimmed)
  try {
    localStorage.setItem(KEY, JSON.stringify(rest.slice(0, LIMIT)))
  } catch {
    // 存不下就算了：缓存丢了顶多是重敲一次地址
  }
}
