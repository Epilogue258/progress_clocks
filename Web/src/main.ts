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
import { applyTheme, emptyRoomDraft, openRoomDialog, render, type GmContext, type UiState } from './ui'
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
  type VerifyResult,
} from './api'
import { forgetRoom, loadKnownRooms, rememberRoom, type KnownRoom } from './known-rooms'

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
  moreMenuOpen: false,
  shortcuts: false,
  sidebarQuery: '',
  gmError: '',
  roomError: '',
  roomDraft: emptyRoomDraft(),
}

// ---------- GM 鉴权状态 ----------

// 房间模式：gmKey = GM 密码（写凭证）；默认房间：GM_KEY
let gmKey: string | null = roomName ? localStorage.getItem(ROOM_GM_STORAGE) : localStorage.getItem(GM_KEY_STORAGE)
let gmAuthed = roomName ? !!gmKey : false
/** 本地是否有未同步到服务器的改动（推送成功才清零；切换服务器时用于丢弃提示） */
let dirty = false

/** 记住 GM 凭证：房间模式存房间 GM 密码，默认房间存 GM_KEY */
function persistGmKey(key: string): void {
  localStorage.setItem(roomName ? ROOM_GM_STORAGE : GM_KEY_STORAGE, key)
}

/** 丢弃 GM 凭证 */
function dropGmKey(): void {
  localStorage.removeItem(roomName ? ROOM_GM_STORAGE : GM_KEY_STORAGE)
}

/** 对着当前服务器校验凭证：房间模式验 GM 密码，默认房间验 GM_KEY */
function checkGmKey(key: string): Promise<VerifyResult> {
  return roomName ? verifyRoomKey(API_BASE, roomName, key) : verifyKey(API_BASE, key)
}

// 启动时验证本地已存的密钥是否仍有效
if (!urlReadonly && gmKey) {
  const verifyPromise = checkGmKey(gmKey)
  verifyPromise.then((result) => {
    gmAuthed = result === 'ok'
    // 只有服务器明确说「凭证不对」才丢弃。连不上时保留：
    // 离线打开远端房间必然校验失败，若据此清空，联网后还得重新输一遍密码
    if (result === 'unauthorized') {
      gmKey = null
      dropGmKey()
    }
    rerender()
    syncPolling()
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
  /**
   * 一次应用「服务器地址 + 凭证」。
   * 刻意不在这里 rerender：连接是异步的，中途重渲染会把用户正在填的弹窗整个换掉，
   * 等 await 回来时手上的节点已经是孤儿，错误提示写了也看不见。
   * 统一由调用方在结束后 rerender，提示文案走 ui.gmError 跟着状态一起重画。
   */
  onConnect: async (base, key) => {
    const next = normalizeBase(base)
    const serverChanged = next !== API_BASE

    // 换服务器会丢掉本地尚未同步的改动，先确认
    if (
      serverChanged &&
      dirty &&
      !confirm('本地有尚未同步到服务器的改动，切换服务器将丢弃这些改动。继续？')
    ) {
      return { ok: false, cancelled: true }
    }

    if (serverChanged) {
      API_BASE = next
      localStorage.setItem(API_BASE_STORAGE, next)
    }

    // 凭证：填了就验新的；没填但换了服务器，旧凭证要对着新服务器复验一次
    let error: string | null = null
    if (key) {
      const result = await checkGmKey(key)
      if (result === 'ok') {
        gmKey = key
        gmAuthed = true
        persistGmKey(key)
      } else if (result === 'unauthorized') {
        error = roomName ? 'GM 密码无效，请重试' : 'GM 密钥无效，请重试'
      } else {
        // 连不上时要说清楚是「没验成」，而不是指控用户的密钥不对
        error = '无法连接服务器，凭证未验证'
      }
    } else if (serverChanged && gmKey) {
      const result = await checkGmKey(gmKey)
      gmAuthed = result === 'ok'
      if (result === 'unauthorized') {
        gmKey = null
        dropGmKey()
      }
    }

    // 换了服务器才重拉；拉到就把 dirty 归零——本地已与服务端一致
    if (serverChanged) {
      try {
        store.replaceState(await pullCurrent())
        dirty = false
      } catch {
        // 连接失败：配置已保存，本地数据保持可用（离线兜底），下次刷新重试
        showToast('无法连接服务器，已保持本地数据')
      }
    }

    syncPolling()
    return error ? { ok: false, error } : { ok: true }
  },
  onLogout: () => {
    gmAuthed = false
    gmKey = null
    dropGmKey()
    rerender()
    syncPolling()
  },
  /** 当前生效的服务器地址（'' = 同源） */
  get serverBase() {
    return API_BASE
  },
  /** 加入房间（GitHub 模型：pull 到本地；gmPwd 可空 = 只读玩家） */
  onJoinRoom: async (room: string, joinPwd: string, gmPwd: string) => {
    // 加入会用房间状态整体覆盖本地，与切换房间/服务器一样先确认
    if (dirty && !confirm('本地有尚未同步到服务器的改动，加入房间将丢弃这些改动。继续？')) {
      return { ok: false as const, error: '已取消' }
    }
    try {
      const remote = await fetchRoomState(API_BASE, room, joinPwd)
      enterRoom(room, joinPwd)
      store.replaceState(remote)
      ui.sidebarOpen = false
      // 只有验证通过的 GM 密码才值得缓存；否则下次切换会被无声地当成玩家
      let effectiveGmPwd = ''
      if (gmPwd) {
        const result = await verifyRoomKey(API_BASE, room, gmPwd)
        if (result === 'ok') {
          gmKey = gmPwd
          gmAuthed = true
          effectiveGmPwd = gmPwd
          localStorage.setItem(ROOM_GM_STORAGE, gmPwd)
        } else {
          showToast(result === 'unauthorized' ? 'GM 密码错误，已以只读身份进入' : '未能验证 GM 密码，已以只读身份进入')
        }
      }
      rememberRoom({ server: API_BASE, room, joinPwd, gmPwd: effectiveGmPwd })
      rerender()
      syncPolling()
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
  },
  /** 新建房间（GitHub 模型：新开仓库并 push 本地状态） */
  onCreateRoom: async (room: string, joinPwd: string, gmPwd: string) => {
    // 不确认 dirty：本地状态会被 push 进新房间，不丢东西
    try {
      await createRoom(API_BASE, room, joinPwd, gmPwd)
      enterRoom(room, joinPwd)
      ui.sidebarOpen = false
      gmKey = gmPwd
      gmAuthed = true
      localStorage.setItem(ROOM_GM_STORAGE, gmPwd)
      // 新房间初始 version=0：push 本地状态必须带 0，否则携带本地旧版本会触发 409 假冲突
      const version = await saveRoomState(API_BASE, room, gmPwd, { ...store.syncState, version: 0 })
      store.markSynced(version)
      rememberRoom({ server: API_BASE, room, joinPwd, gmPwd })
      rerender()
      syncPolling()
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
  /** 本机缓存的已知房间（含密码），供侧边栏一键切换 */
  get knownRooms() {
    return loadKnownRooms()
  },
  /** 切换到已知房间：直接用缓存的密码进，不必重输 */
  onSwitchRoom: async (entry: KnownRoom) => {
    if (entry.room === roomName && entry.server === API_BASE) return { ok: true as const }
    // 切房间会整体覆盖本地状态，有未同步改动时先确认（与切换服务器一致）
    if (dirty && !confirm('本地有尚未同步到服务器的改动，切换房间将丢弃这些改动。继续？')) {
      return { ok: false as const, error: '已取消' }
    }
    try {
      const remote = await fetchRoomState(entry.server, entry.room, entry.joinPwd)
      // 已知房间自带服务器地址：切过去时连地址一起换（这就是「一键切换」的意义）
      API_BASE = normalizeBase(entry.server)
      localStorage.setItem(API_BASE_STORAGE, API_BASE)
      enterRoom(entry.room, entry.joinPwd)
      store.replaceState(remote)
      ui.sidebarOpen = false
      if (entry.gmPwd) {
        const result = await verifyRoomKey(API_BASE, entry.room, entry.gmPwd)
        gmKey = entry.gmPwd
        gmAuthed = result === 'ok'
        if (result === 'ok') localStorage.setItem(ROOM_GM_STORAGE, entry.gmPwd)
        // 没问出结果（连不上 / 服务端出错）时保留缓存的密码，下次切换还能再试；
        // 只有服务器明确说不对才抹掉，免得一次抖动就丢掉凭证
        else if (result === 'unauthorized') localStorage.removeItem(ROOM_GM_STORAGE)
      } else {
        gmKey = null
        gmAuthed = false
        localStorage.removeItem(ROOM_GM_STORAGE)
      }
      // 刷新 lastAt，让它排到缓存列表最前
      rememberRoom({
        server: entry.server,
        room: entry.room,
        joinPwd: entry.joinPwd,
        gmPwd: entry.gmPwd,
      })
      rerender()
      syncPolling()
      return { ok: true as const }
    } catch (e) {
      const error = e instanceof ApiError ? e.message : '无法连接该房间'
      showToast(error)
      return { ok: false as const, error }
    }
  },
  /** 忘记某个已知房间：只清本机缓存，不动服务器上的房间 */
  onForgetRoom: (entry: KnownRoom) => {
    forgetRoom(entry.server, entry.room)
    rerender()
  },
  /** 删除房间（GM 密码已在登录态；删除后自动退回默认房间） */
  onDeleteRoom: async (room: string) => {
    try {
      await deleteRoom(API_BASE, room, gmKey ?? '')
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
    // 服务器上的房间没了，本机缓存里的这条也一并清掉
    forgetRoom(API_BASE, room)
    await leaveRoom()
    rerender()
    syncPolling()
    showToast(`房间「${room}」已删除`)
    return { ok: true as const }
  },
  /** 退出房间回到默认房间（服务器上的房间保留；未同步改动会丢，先确认） */
  onLeaveRoom: async () => {
    if (dirty && !confirm('本地有尚未同步到服务器的改动，退出房间将丢弃这些改动。继续？')) {
      return { ok: false as const, error: '已取消' }
    }
    await leaveRoom()
    dirty = false
    rerender()
    syncPolling()
    return { ok: true as const }
  },
}

const rerender = () =>
  render(root, store, ui, urlReadonly || !gmAuthed, rerender, gm)

// ---------- 房间进入 / 同步上下文 ----------

/**
 * 保存房间配置并进入：更新 room/加入密码记忆 + URL 同步（密码不进 URL）。
 * 刻意不动 API_BASE：服务器地址只由「连接与登录」改，进房间不该顺带换服务器——
 * 房间是另一台服务器上的另一个仓库，悄悄把地址也换了只会让人困惑
 */
function enterRoom(room: string, joinPwd: string): void {
  roomName = room
  roomJoinPwd = joinPwd
  localStorage.setItem(ROOM_STORAGE, room)
  localStorage.setItem(ROOM_JOIN_STORAGE, joinPwd)
  const params = new URLSearchParams(location.search)
  if (API_BASE) params.set('server', API_BASE)
  params.set('room', room)
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`)
}

/**
 * 退出当前房间、回到默认房间（与 enterRoom 对偶）。
 * 加入房间是「pull 房间状态覆盖本地」，退出就是「pull 默认房间状态覆盖本地」——
 * 对称才不会留下半房间半默认的混合状态。
 *
 * 写凭证也要换手：房间的 GM 密码与默认房间的 GM_KEY（server 环境变量）不是一把锁，
 * 退出后得重新拿后者去验一遍，验不过就老实退回只读。
 * 拉不到默认房间时给空状态而不是卡住——退出不该被网络问题挡住。
 */
async function leaveRoom(): Promise<void> {
  roomName = ''
  roomJoinPwd = ''
  localStorage.removeItem(ROOM_STORAGE)
  localStorage.removeItem(ROOM_JOIN_STORAGE)
  localStorage.removeItem(ROOM_GM_STORAGE)
  const params = new URLSearchParams(location.search)
  params.delete('room')
  const qs = params.toString()
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`)

  gmKey = localStorage.getItem(GM_KEY_STORAGE)
  try {
    store.replaceState(await pullCurrent())
    // 同上：只有服务器明确说不对才丢凭证。走到这里说明默认房间拉得到，
    // 连不上会先被下面的 catch 接走
    const result = gmKey ? await checkGmKey(gmKey) : ('unknown' as VerifyResult)
    gmAuthed = result === 'ok'
    if (result === 'unauthorized') {
      gmKey = null
      dropGmKey()
    }
  } catch {
    store.replaceState(createEmptyState())
    gmAuthed = false
    gmKey = null
    showToast('无法连接服务器，已回到空的默认房间')
  }
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

// 进入页判定：仅分离模式（配了 server）且还没进房间时弹窗选择/新建
// 有 ?room= 时直接进入（公开房间免密；私有房间拉取 401 后由 bootstrapPull 弹窗）
if (API_BASE !== '' && !roomName) {
  openRoomDialog(ui)
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
store.subscribe((kind) => {
  // 显示顺序是本机的视图偏好，不是契约数据，不参与同步
  if (kind === 'order') return
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
        syncPolling()
      }
      // 其他错误（网络等）静默
    }
  }, 500)
})

// 启动：拉取 server 状态（server 为权威；失败保持本地数据并定时重试，server 重启后自动恢复）
async function bootstrapPull(): Promise<void> {
  try {
    const remote = await pullCurrent()
    store.replaceState(remote)
    rerender()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && roomName) {
      // 私有房间 / 加入密码记忆失效：弹连接弹窗重新输入
      // 停轮询：密码不对时每 5s 的失败请求无意义，等用户重新输入后再起
      stopPolling()
      openRoomDialog(ui)
      rerender()
    } else {
      // 离线 / server 刚重启：5s 后重试；成功前本地数据可用
      setTimeout(() => void bootstrapPull(), 5000)
    }
  }
}
void bootstrapPull()

// ---------- 只读端轮询 ----------
// 是否轮询由「是否持有写凭证」决定，而不是 URL 参数：
// 分享给玩家的 ?room=xxx 通常不带 readonly，此前因此既不轮询也不推送，全程静态快照。
// GM 端自身靠推送，不轮询；登录态或房间/服务器变化时重建，避免沿用旧的 room 与密码。
let pollingStop: (() => void) | null = null

function startPolling(): void {
  pollingStop?.()
  pollingStop = pollState(
    API_BASE,
    (remote) => {
      // 本地有未推送成功的改动时不覆盖，防丢改动。
      // 只看 dirty，不看 gmAuthed：推送撞 401 时 gmAuthed 会被置 false 并重启轮询，
      // 而那一刻恰恰是本地改动最需要保护的时候——带上 gmAuthed 反而撤掉了保护
      if (dirty) return
      store.replaceState(remote)
      rerender()
    },
    5000,
    roomName,
    roomJoinPwd,
  )
}

function stopPolling(): void {
  pollingStop?.()
  pollingStop = null
}

/** 按当前登录态重建轮询：GM 停，非 GM 起 */
function syncPolling(): void {
  if (gmAuthed) stopPolling()
  else startPolling()
}

// 启动即按「是否已持有写凭证」决定轮询；GM 密钥验证通过后 syncPolling 会停掉它
syncPolling()

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

  // Esc 逐层关最上层的浮层。放在权限判断之前——只读玩家也要能关弹窗
  if (e.key === 'Escape') {
    if (ui.moreMenuOpen) ui.moreMenuOpen = false
    else if (ui.shortcuts) ui.shortcuts = false
    else if (ui.roomDialog) ui.roomDialog = false
    else if (ui.creating) ui.creating = false
    else if (ui.gmDialog) {
      ui.gmDialog = false
      ui.gmError = ''
    } else if (ui.settingsClockId) ui.settingsClockId = null
    else return
    rerender()
    return
  }

  // ? 查看快捷键（任何模式可用）
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault()
    ui.shortcuts = !ui.shortcuts
    rerender()
    return
  }

  // 以下都是写操作：只读模式或未登录 GM 时不响应
  if (urlReadonly || !gmAuthed) return

  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault()
      if (store.moveCurrent(-1)) rerender()
      break
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault()
      if (store.moveCurrent(1)) rerender()
      break
    case 'Enter':
      if (store.currentClockId && !ui.settingsClockId) {
        e.preventDefault()
        ui.settingsClockId = store.currentClockId
        rerender()
      }
      break
    case 'Delete':
      // 有撤销栈兜底，不必弹确认；Backspace 不绑，误触风险太高
      if (store.currentClockId) {
        e.preventDefault()
        store.deleteClock(store.currentClockId)
        rerender()
      }
      break
    case '0':
      if (store.currentClockId) {
        e.preventDefault()
        store.updateClock(store.currentClockId, { fill: 0 })
        rerender()
      }
      break
    case '+':
    case '=':
      if (store.currentClockId) {
        e.preventDefault()
        store.increment(store.currentClockId, 1)
        rerender()
      }
      break
    case '-':
    case '_':
      if (store.currentClockId) {
        e.preventDefault()
        store.increment(store.currentClockId, -1)
        rerender()
      }
      break
    default:
      if (e.key >= '1' && e.key <= '3' && store.currentClockId) {
        // 数字键：对当前钟增量填充 1~3 格
        e.preventDefault()
        store.increment(store.currentClockId, Number(e.key))
        rerender()
      }
  }
})

// 系统深浅偏好变化时跟随（仅 auto 模式生效）
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => {
    applyTheme()
    rerender()
  })
