/**
 * 进度钟 Web 端入口
 * - GM 主控模式：输入 GM 密钥（Bearer 鉴权）后获得编辑权限
 * - 玩家查看模式：URL 带 ?readonly 时纯只读（连登录入口都隐藏）
 *
 * 数据流（本地优先 + server 同步）：
 * - 启动：localStorage 立即显示 -> 异步拉取 server 状态替换（server 为权威）
 * - 变更：本地立即生效 + 防抖 500ms 全量推送（带密钥 + 版本号乐观锁）
 * - 冲突：409 -> 自动拉取最新状态替换 + 提示（多 GM 同时操作的兜底）
 * - server 不可达：保持本地 localStorage 数据，离线可用
 */
import './styles.css'
import { Store } from './state'
import { applyTheme, render, type GmContext, type UiState } from './ui'
import type { ClockState } from '../../common/types'
import { createEmptyState } from '../../common/types'
import {
  ApiError,
  createRoom,
  deleteRoom,
  fetchRoomState,
  fetchState,
  listRooms,
  pollState,
  saveRoomState,
  saveState,
  verifyKey,
  verifyRoomKey,
} from './api'

// server 地址解析优先级：?server= URL 参数 > localStorage 记忆 > 同源（''）
// 分离模式：Web/dist 可脱离 server 单独打开（file:// 或任意静态托管），
// 通过 ?server=http://ip:2333 或 GM 弹窗填服务器地址连接任意后端；同源托管时留空
const API_BASE_STORAGE = 'pc-api-base'

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function resolveApiBase(): string {
  const fromUrl = new URLSearchParams(location.search).get('server')
  if (fromUrl) return normalizeBase(fromUrl)
  const saved = localStorage.getItem(API_BASE_STORAGE)
  return saved ? normalizeBase(saved) : ''
}

let API_BASE = resolveApiBase()

// 房间配置：?room= URL 参数 > localStorage 记忆（密码仅存 localStorage，不进 URL）
// 双密码：joinPwd = 玩家只读凭证（可空 = 公开房间），gmPwd = GM 写凭证（必填 ≥6 位）
const ROOM_STORAGE = 'pc-room-name'
const ROOM_JOIN_STORAGE = 'pc-room-join'
const ROOM_GM_STORAGE = 'pc-room-gm'
const GM_KEY_STORAGE = 'pc-gm-key'
const urlReadonly = new URLSearchParams(location.search).has('readonly')

let roomName = new URLSearchParams(location.search).get('room') ?? localStorage.getItem(ROOM_STORAGE) ?? ''
let roomJoinPwd = localStorage.getItem(ROOM_JOIN_STORAGE) ?? ''
/** 是否已填过加入密码（含空 = 公开房间），用于进入页判定 */
let roomJoinSet = localStorage.getItem(ROOM_JOIN_STORAGE) !== null

const root = document.getElementById('app')!
applyTheme()

const store = new Store()
// 演示模式：空状态时预置示例钟（也用于无头验证）
if (
  new URLSearchParams(location.search).has('demo') &&
  Object.keys(store.state.clocks).length === 0
) {
  store.createClock('宅邸警戒', 4)
  store.createClock('红绸党', 6)
  store.createClock('潜入斯特朗福德', 8)
}
const ui: UiState = {
  view: 'grid',
  settingsClockId: null,
  creating: false,
  gmDialog: false,
  roomDialog: false,
  roomPrefill: '',
  sidebarOpen: false,
}

// ---------- GM 鉴权状态 ----------

// 房间模式：gmKey = GM 密码（写凭证）；默认房间：GM_KEY
let gmKey: string | null = roomName ? localStorage.getItem(ROOM_GM_STORAGE) : localStorage.getItem(GM_KEY_STORAGE)
let gmAuthed = roomName ? !!gmKey : false
/** 本地是否有未同步到服务器的改动（推送成功才清零；切换服务器时用于丢弃提示） */
let dirty = false

// 启动时验证本地已存的密钥是否仍有效
if (!urlReadonly && gmKey) {
  const okPromise = roomName ? verifyRoomKey(API_BASE, roomName, gmKey) : verifyKey(API_BASE, gmKey)
  okPromise.then((ok) => {
    gmAuthed = ok
    if (!ok) {
      gmKey = null
      if (roomName) {
        localStorage.removeItem(ROOM_GM_STORAGE)
      } else {
        localStorage.removeItem(GM_KEY_STORAGE)
      }
    }
    rerender()
  })
}

const gm: GmContext = {
  urlReadonly,
  get authed() {
    return gmAuthed
  },
  /** 当前房间名（'' = 默认房间） */
  get roomName() {
    return roomName
  },
  /** 当前加入密码（'' = 公开房间） */
  get roomJoinPwd() {
    return roomJoinPwd
  },
  onSubmitKey: async (key) => {
    // 房间模式：验证 GM 密码（写权限）；默认房间：GM_KEY
    const ok = roomName
      ? await verifyRoomKey(API_BASE, roomName, key)
      : await verifyKey(API_BASE, key)
    if (ok) {
      gmKey = key
      gmAuthed = true
      if (roomName) {
        localStorage.setItem(ROOM_GM_STORAGE, key)
      } else {
        localStorage.setItem(GM_KEY_STORAGE, key)
      }
      rerender()
    }
    return ok
  },
  onLogout: () => {
    gmAuthed = false
    gmKey = null
    if (roomName) {
      localStorage.removeItem(ROOM_GM_STORAGE)
    } else {
      localStorage.removeItem(GM_KEY_STORAGE)
    }
    rerender()
  },
  /** 当前生效的服务器地址（'' = 同源） */
  get serverBase() {
    return API_BASE
  },
  /** 保存并切换服务器：更新配置、重拉当前上下文状态、重新验证 GM 凭证 */
  onServerChange: async (base: string) => {
    const next = normalizeBase(base)
    if (dirty && !confirm('本地有尚未同步到服务器的改动，切换服务器将丢弃这些改动。继续？')) {
      return false
    }
    API_BASE = next
    localStorage.setItem(API_BASE_STORAGE, next)
    try {
      const remote = await pullCurrent()
      store.replaceState(remote)
    } catch {
      // 连接失败：配置已保存，本地数据保持可用（离线兜底），下次刷新重试
      showToast('无法连接服务器，已保持本地数据')
    }
    if (gmKey) {
      const ok = roomName ? await verifyRoomKey(API_BASE, roomName, gmKey) : await verifyKey(API_BASE, gmKey)
      gmAuthed = ok
      if (!ok) {
        gmKey = null
        if (roomName) {
          localStorage.removeItem(ROOM_GM_STORAGE)
        } else {
          localStorage.removeItem(GM_KEY_STORAGE)
        }
      }
    }
    rerender()
    return true
  },
  /** 加入房间（GitHub 模型：pull 到本地；gmPwd 可空 = 只读玩家） */
  onJoinRoom: async (server: string, room: string, joinPwd: string, gmPwd: string) => {
    try {
      const remote = await fetchRoomState(normalizeBase(server), room, joinPwd)
      enterRoom(server, room, joinPwd)
      store.replaceState(remote)
      ui.sidebarOpen = false
      if (gmPwd) {
        const ok = await verifyRoomKey(API_BASE, room, gmPwd)
        if (ok) {
          gmKey = gmPwd
          gmAuthed = true
          localStorage.setItem(ROOM_GM_STORAGE, gmPwd)
        } else {
          showToast('GM 密码错误，已以只读身份进入')
        }
      }
      rerender()
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
  },
  /** 新建房间（GitHub 模型：新开仓库并 push 本地状态） */
  onCreateRoom: async (server: string, room: string, joinPwd: string, gmPwd: string) => {
    try {
      await createRoom(normalizeBase(server), room, joinPwd, gmPwd)
      enterRoom(server, room, joinPwd)
      ui.sidebarOpen = false
      gmKey = gmPwd
      gmAuthed = true
      localStorage.setItem(ROOM_GM_STORAGE, gmPwd)
      // 新房间初始 version=0：push 本地状态必须带 0，否则携带本地旧版本会触发 409 假冲突
      const version = await saveRoomState(API_BASE, room, gmPwd, { ...store.syncState, version: 0 })
      store.markSynced(version)
      rerender()
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
  },
  /** 拉取房间列表（公开；失败静默返回空） */
  onListRooms: async () => {
    try {
      return await listRooms(API_BASE)
    } catch {
      return []
    }
  },
  /** 删除房间（GM 密码已在登录态；删除后退出房间回到默认状态） */
  onDeleteRoom: async (room: string) => {
    try {
      await deleteRoom(API_BASE, room, gmKey ?? '')
      roomName = ''
      roomJoinPwd = ''
      roomJoinSet = false
      gmKey = null
      gmAuthed = false
      localStorage.removeItem(ROOM_STORAGE)
      localStorage.removeItem(ROOM_JOIN_STORAGE)
      localStorage.removeItem(ROOM_GM_STORAGE)
      store.replaceState(createEmptyState())
      const params = new URLSearchParams(location.search)
      params.delete('room')
      const qs = params.toString()
      history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`)
      rerender()
      showToast(`房间「${room}」已删除`)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
  },
}

const rerender = () =>
  render(root, store, ui, urlReadonly || !gmAuthed, rerender, gm)

// ---------- 房间进入 / 同步上下文 ----------

/** 保存房间配置并进入：更新 server/room/加入密码记忆 + URL 同步（密码不进 URL） */
function enterRoom(server: string, room: string, joinPwd: string): void {
  API_BASE = normalizeBase(server)
  localStorage.setItem(API_BASE_STORAGE, API_BASE)
  roomName = room
  roomJoinPwd = joinPwd
  roomJoinSet = true
  localStorage.setItem(ROOM_STORAGE, room)
  localStorage.setItem(ROOM_JOIN_STORAGE, joinPwd)
  const params = new URLSearchParams(location.search)
  if (API_BASE) params.set('server', API_BASE)
  params.set('room', room)
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`)
}

/** 拉取当前上下文状态（房间模式用加入密码拉取，否则默认房间） */
async function pullCurrent(): Promise<ClockState> {
  return roomName ? fetchRoomState(API_BASE, roomName, roomJoinPwd) : fetchState(API_BASE)
}

/** 推送当前状态（房间模式用 GM 密码，否则默认房间 + GM 密钥） */
async function pushCurrent(): Promise<number> {
  return roomName
    ? saveRoomState(API_BASE, roomName, gmKey ?? '', store.syncState)
    : saveState(API_BASE, store.syncState, gmKey ?? undefined)
}

rerender()

// 进入页判定：分离模式选了 server 但没进房间，或进了房间但没填过加入密码（含玩家首次加入）
if ((API_BASE !== '' && !roomName) || (roomName && !roomJoinSet)) {
  ui.roomDialog = true
  rerender()
}

// ---------- 同步层 ----------

/** 顶部短暂提示（冲突 / 密钥失效等） */
function showToast(msg: string): void {
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = msg
  document.body.append(toast)
  setTimeout(() => toast.remove(), 3500)
}

// 变更防抖推送到 server（单写者全量覆盖；失败静默，下次变更重试）
let pushTimer: number | undefined
store.subscribe(() => {
  if (urlReadonly || !gmAuthed) return
  dirty = true
  window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(async () => {
    try {
      const version = await pushCurrent()
      // 推送成功：更新同步基线，避免下次操作（含撤销）携带旧版本触发假冲突
      store.markSynced(version)
      dirty = false
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 多写冲突：采用服务器最新状态（丢包重做模式，桌游场景足够）
        try {
          const remote = e.latest ?? (await pullCurrent())
          store.replaceState(remote)
          showToast('状态已在别处更新，已同步最新')
          rerender()
        } catch {
          // 拉取失败静默
        }
      } else if (e instanceof ApiError && e.status === 401) {
        // GM 密码失效：清除写权限并提示重新输入（加入密码错误则轮询静默，不影响只读）
        gmAuthed = false
        gmKey = null
        if (roomName) {
          localStorage.removeItem(ROOM_GM_STORAGE)
        } else {
          localStorage.removeItem(GM_KEY_STORAGE)
        }
        showToast(roomName ? 'GM 密码失效，请重新登录' : 'GM 密钥失效，请重新登录')
        rerender()
      }
      // 其他错误（网络等）静默
    }
  }, 500)
})

// 启动：拉取 server 状态（server 为权威；失败保持本地数据，离线可用）
pullCurrent()
  .then((remote) => {
    store.replaceState(remote)
    rerender()
  })
  .catch(() => {
    // 离线模式，仅本地 localStorage
  })

// 玩家只读模式：轮询 server（GM 端不轮询，靠推送）
if (urlReadonly) {
  pollState(
    API_BASE,
    (remote) => {
      store.replaceState(remote)
      rerender()
    },
    5000,
    roomName,
    roomJoinPwd,
  )
}

// ---------- 快捷键 ----------

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase()
    if (key === 'z') {
      e.preventDefault()
      e.shiftKey ? store.redo() : store.undo()
      rerender()
    } else if (key === 'y') {
      e.preventDefault()
      store.redo()
      rerender()
    } else if (key === 'n') {
      e.preventDefault()
      const clock = store.createClock()
      ui.settingsClockId = clock.id
      rerender()
    }
    return
  }

  if (urlReadonly || !gmAuthed) return

  if (e.key === 'Escape') {
    if (ui.roomDialog) {
      ui.roomDialog = false
      rerender()
    } else if (ui.creating) {
      ui.creating = false
      rerender()
    } else if (ui.gmDialog) {
      ui.gmDialog = false
      rerender()
    } else if (ui.settingsClockId) {
      ui.settingsClockId = null
      rerender()
    }
  } else if (e.key >= '1' && e.key <= '3' && store.currentClockId) {
    // 数字键：对最近交互的钟批量填充
    store.increment(store.currentClockId, Number(e.key))
    rerender()
  }
})

// 系统深浅偏好变化时跟随（仅 auto 模式生效）
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => {
    applyTheme()
    rerender()
  })
