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
import { Store, STORAGE_KEY } from './state'
import { applyTheme, emptyRoomDraft, openRoomDialog, render, type GmContext, type UiState } from './ui'
import { createEmptyState, type ClockState } from '../../common/types'
import {
  ApiError,
  changeRoomPwd,
  createRoom,
  deleteRoom,
  fetchRoomState,
  listRooms,
  pollState,
  saveRoomState,
  verifyKey,
  verifyRoomKey,
  type VerifyResult,
} from './api'
import { forgetRoom, loadKnownRooms, rememberRoom, type KnownRoom } from './known-rooms'
import {
  clearLocalState,
  forgetLocalRoom,
  listLocalRooms,
  localSlotKey,
  nextLocalName,
  rememberLocalRoom,
} from './local-rooms'

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
const ROOM_TYPE_STORAGE = 'pc-room-type'
const urlReadonly = new URLSearchParams(location.search).has('readonly')

// ?room= 是分享链接，指向的一定是远端房间；本地房间只按记忆恢复（不分享）
const roomFromUrl = new URLSearchParams(location.search).get('room')
let roomName = roomFromUrl ?? localStorage.getItem(ROOM_STORAGE) ?? ''
let roomLocal = !roomFromUrl && localStorage.getItem(ROOM_TYPE_STORAGE) === 'local'
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
  sidebarRemoteOpen: true,
  sidebarLocalOpen: true,
  manageRoomDialog: false,
  manageError: '',
  changePwdOpen: false,
  changePwdDraft: { joinPwd: '', gmPwd: '' },
  localRoomDialog: false,
  localRoomDraft: '',
  localRoomError: '',
}

// ---------- GM 鉴权状态 ----------

// 房间模式：gmKey = GM 密码（写凭证）；默认房间：GM_KEY
let gmKey: string | null = roomName ? localStorage.getItem(ROOM_GM_STORAGE) : localStorage.getItem(GM_KEY_STORAGE)
let gmAuthed = roomName ? !!gmKey : false
/** 本地是否有未同步到服务器的改动（推送成功才清零；切换服务器时用于丢弃提示） */
let dirty = false

/**
 * 能否编辑眼前这份数据：本地房间 / 空白工作区永远可编辑；远端房间需 GM 凭证。
 * 与 canPush 是两个独立的问题——「能不能改」不该由「能不能同步」决定。
 */
const canEdit = (): boolean => !urlReadonly && (roomName === '' || roomLocal || gmAuthed)
/** 能否推送：只有远端房间且持有写凭证才会同步；本地与空白工作区不联网 */
const canPush = (): boolean => roomName !== '' && !roomLocal && gmAuthed && !urlReadonly

/** 记住 GM 凭证：房间模式存房间 GM 密码，默认房间存 GM_KEY */
function persistGmKey(key: string): void {
  localStorage.setItem(roomName ? ROOM_GM_STORAGE : GM_KEY_STORAGE, key)
}

/** 丢弃 GM 凭证 */
function dropGmKey(): void {
  localStorage.removeItem(roomName ? ROOM_GM_STORAGE : GM_KEY_STORAGE)
}

/** 对着当前服务器校验凭证：远端房间验 GM 密码，空白工作区验 GM_KEY，本地房间无需凭证 */
function checkGmKey(key: string): Promise<VerifyResult> {
  if (roomLocal) return Promise.resolve('ok' as VerifyResult)
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
      // 本地已被远端整体替换，此刻与服务端同版本——dirty 必须归零。
      // 漏掉这一句，轮询会被 if (dirty) return 永久挡死，刚进的房间从此是个静止快照
      dirty = false
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
      // 不带 version，直接覆盖新房间的空状态；本地旧版本也不会再撞 409 假冲突
      const version = await saveRoomState(API_BASE, room, gmPwd, store.pushState)
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
      // 同加入房间：本地已被远端整体替换，dirty 归零，否则轮询永久停摆
      dirty = false
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
  /** 删除房间（GM 密码已在登录态；删除后自动退回空白工作区） */
  onDeleteRoom: async (room: string) => {
    try {
      await deleteRoom(API_BASE, room, gmKey ?? '')
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
    // 服务器上的房间没了，本机缓存里的这条也一并清掉
    forgetRoom(API_BASE, room)
    leaveRoom()
    showToast(`房间「${room}」已删除`)
    return { ok: true as const }
  },
  /** 退出当前房间，回到本地空白工作区（远端房间保留在服务器上） */
  onLeaveRoom: async () => {
    if (dirty && !confirm('本地有尚未同步到服务器的改动，退出房间将丢弃这些改动。继续？')) {
      return { ok: false as const, error: '已取消' }
    }
    leaveRoom()
    return { ok: true as const }
  },
  /** 当前是否在本地房间（本地房间永远可编辑、永不联网） */
  get roomLocal() {
    return roomLocal
  },
  /** 本机已建的本地房间列表 */
  get localRooms() {
    return listLocalRooms()
  },
  /** 新建本地房间：重名自动顺延 (2)；创建后直接进入 */
  onCreateLocalRoom: (name: string) => {
    enterLocalRoom(nextLocalName(name.trim() || '未命名房间'))
    rerender()
    return { ok: true as const }
  },
  /** 删除本地房间：清注册表与状态槽；删的是当前房间则退回空白工作区 */
  onDeleteLocalRoom: (name: string) => {
    forgetLocalRoom(name)
    clearLocalState(name)
    if (roomName === name && roomLocal) {
      leaveRoom()
    } else {
      rerender()
    }
    return { ok: true as const }
  },
  /** 进入已有的本地房间（读它的状态槽，不联网） */
  onEnterLocalRoom: (name: string) => {
    enterLocalRoom(name)
    rerender()
    return { ok: true as const }
  },
  /**
   * 修改房间密码（PATCH）：只改填了的字段；改完同步本机缓存——
   * GM 密码变了本地得跟着换，否则下一次 push 直接 401。
   */
  onChangePwd: async (joinPwd: string, gmPwd: string) => {
    const patch: { joinPwd?: string; gmPwd?: string } = {}
    if (joinPwd) patch.joinPwd = joinPwd
    if (gmPwd) patch.gmPwd = gmPwd
    if (!patch.joinPwd && !patch.gmPwd) return { ok: false as const, error: '没有要修改的密码' }
    try {
      await changeRoomPwd(API_BASE, roomName, gmKey ?? '', patch)
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
    if (patch.gmPwd) {
      gmKey = patch.gmPwd
      localStorage.setItem(ROOM_GM_STORAGE, patch.gmPwd)
    }
    if (patch.joinPwd) {
      roomJoinPwd = patch.joinPwd
      localStorage.setItem(ROOM_JOIN_STORAGE, patch.joinPwd)
    }
    // known-rooms 缓存里该条也刷新（只动存在的那条，别改排序）
    const entry = loadKnownRooms().find((r) => r.server === API_BASE && r.room === roomName)
    if (entry) {
      rememberRoom({
        server: entry.server,
        room: entry.room,
        joinPwd: patch.joinPwd ?? entry.joinPwd,
        gmPwd: patch.gmPwd ?? entry.gmPwd,
      })
    }
    showToast('密码已更新')
    return { ok: true as const }
  },
}

const rerender = () => render(root, store, ui, !canEdit(), rerender, gm)

// ---------- 房间进入 / 同步上下文 ----------

/**
 * 保存房间配置并进入：更新 room/加入密码记忆 + URL 同步（密码不进 URL）。
 * 刻意不动 API_BASE：服务器地址只由「连接与登录」改，进房间不该顺带换服务器——
 * 房间是另一台服务器上的另一个仓库，悄悄把地址也换了只会让人困惑
 */
function enterRoom(room: string, joinPwd: string): void {
  roomName = room
  roomLocal = false
  roomJoinPwd = joinPwd
  localStorage.setItem(ROOM_STORAGE, room)
  localStorage.setItem(ROOM_JOIN_STORAGE, joinPwd)
  localStorage.setItem(ROOM_TYPE_STORAGE, 'remote')
  // 承接远端数据的槽位是全局槽：从本地房间切过来要先复位，否则远端状态会被写进本地房间的槽
  store.attachSlot(STORAGE_KEY)
  const params = new URLSearchParams(location.search)
  if (API_BASE) params.set('server', API_BASE)
  params.set('room', room)
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`)
}

/** 进入本地房间：换到该房间的状态槽，不联网、永远可编辑 */
function enterLocalRoom(name: string): void {
  roomName = name
  roomLocal = true
  roomJoinPwd = ''
  localStorage.setItem(ROOM_STORAGE, name)
  localStorage.removeItem(ROOM_JOIN_STORAGE)
  localStorage.setItem(ROOM_TYPE_STORAGE, 'local')
  // 本地房间不写 ?room=（它是本地概念，分享无意义）
  const params = new URLSearchParams(location.search)
  params.delete('room')
  const qs = params.toString()
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`)

  gmKey = null
  gmAuthed = true
  dirty = false
  store.attachSlot(localSlotKey(name))
  rememberLocalRoom(name)
  syncPolling()
}

/**
 * 退出当前房间、回到本地空白工作区（与 enterRoom / enterLocalRoom 对偶）。
 * 空白工作区是纯本地的：不联网、不拉默认房间，点侧边栏「本地 +」可新建本地房间继续干活。
 * 写凭证一并清掉——远端房间的 GM 密码与空白工作区无关。
 */
function leaveRoom(): void {
  roomName = ''
  roomLocal = false
  roomJoinPwd = ''
  localStorage.removeItem(ROOM_STORAGE)
  localStorage.removeItem(ROOM_JOIN_STORAGE)
  localStorage.removeItem(ROOM_GM_STORAGE)
  localStorage.removeItem(ROOM_TYPE_STORAGE)
  const params = new URLSearchParams(location.search)
  params.delete('room')
  const qs = params.toString()
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`)

  gmKey = null
  gmAuthed = false
  dirty = false
  // 空白工作区是干净起步：先切回全局槽，再置空（不留上一个远端房间的缓存）
  store.attachSlot(STORAGE_KEY)
  store.replaceState(createEmptyState())
  rerender()
  syncPolling()
}

/** 拉取当前远端房间状态（仅在远端房间时调用；本地/空白工作区不联网） */
async function pullCurrent(): Promise<ClockState> {
  return fetchRoomState(API_BASE, roomName, roomJoinPwd)
}

/**
 * 推送当前远端房间状态（用 GM 密码）。
 * pushState 不带 version，服务端走强制覆盖：push 是主动操作，默认覆盖乐观锁。
 * 只有远端房间会推送——本地房间与空白工作区的改动是终点，不存在「待推送」。
 */
async function pushCurrent(): Promise<number> {
  return saveRoomState(API_BASE, roomName, gmKey ?? '', store.pushState)
}

rerender()

// 启动即本地工作区（目标架构：不强制进远端房间）：
// - 本地房间：切到该房间的状态槽，不联网
// - 远端房间：拉服务器状态（server 权威）
// - 空白工作区：干净起步，不拉任何东西
if (roomLocal) {
  store.attachSlot(localSlotKey(roomName))
  rerender()
} else if (roomName) {
  void bootstrapPull()
} else {
  store.replaceState(createEmptyState())
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

// 变更防抖推送到 server（push 默认覆盖；网络失败按退避重试，不静默丢掉改动）
let pushTimer: number | undefined
let retryTimer: number | undefined
let retryDelay = 5000

/** 排一次推送重试；已在等待中就不再排（避免每次改动叠一个定时器） */
function scheduleRetryPush(): void {
  if (retryTimer !== undefined) return
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    void pushNow()
  }, retryDelay)
  // 退避：服务器已下线时固定 5s 打下去只是空转
  retryDelay = Math.min(retryDelay * 2, 60000)
}

/** 推送一次。成功清掉 dirty 并把退避重置回起点 */
async function pushNow(): Promise<void> {
  // dirty 已被清掉（退出房间等）就别推了，否则会把空状态推上去覆盖服务端
  if (!dirty) return
  try {
    const version = await pushCurrent()
    // 推送成功：更新同步基线（同一次轮询据此判断远端是否领先）
    store.markSynced(version)
    dirty = false
    retryDelay = 5000
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      // 多写冲突：采用服务器最新状态（丢包重做模式，桌游场景足够）
      // Web 端推送已不带 version（见 store.pushState），走强制覆盖，自己撞不到这一支；
      // 保留给仍带 version 的客户端（QQ Bot），以及将来恢复乐观锁的情形
      try {
        const remote = e.latest ?? (await pullCurrent())
        store.replaceState(remote)
        // 采用远端后本地与服务端同版本，算已同步；
        // 不置 false 的话 dirty 会一直为真，轮询从此被 if (dirty) return 挡死
        dirty = false
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
    } else {
      // 网络错误 / 服务器不可达：dirty 保持为真，排一次重试。
      // 此前这里完全静默，于是这次改动唯一的第二次机会是「用户再改一次」——
      // 而 GM 端是不轮询的（syncPolling 只给非 GM 起轮询），没有别的路径能把它推出去。
      // 关掉页面更糟：本地数据还在，下次启动 bootstrapPull 会用服务端状态覆盖掉。
      scheduleRetryPush()
    }
  }
}

store.subscribe((kind) => {
  // 显示顺序是本机的视图偏好，不是契约数据，不参与同步
  if (kind === 'order') return
  // 只有远端房间且持有写凭证才推送；本地房间 / 空白工作区的改动由 Store 就地落盘，是终点
  if (!canPush()) return
  dirty = true
  window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(() => void pushNow(), 500)
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
      // 版本没变就整个跳过：replaceState() 会清空撤销栈并把当前钟选中态置空，
      // 无条件每 5s 替换一次，等于每 5 秒把只读端刚点选中的钟取消掉（TODO-71af8dd5）。
      // version 由服务端每次写入自增，因此「版本相同」即可认为内容相同。
      if (remote.version === store.state.version) return
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

/** 按当前上下文重建轮询：本地 / 空白工作区不联网；远端房间 GM 靠推送停轮询、玩家轮询 */
function syncPolling(): void {
  if (roomName === '' || roomLocal || gmAuthed) stopPolling()
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
    else if (ui.localRoomDialog) ui.localRoomDialog = false
    else if (ui.manageRoomDialog) {
      ui.manageRoomDialog = false
      ui.manageError = ''
      ui.changePwdOpen = false
    } else if (ui.roomDialog) ui.roomDialog = false
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
