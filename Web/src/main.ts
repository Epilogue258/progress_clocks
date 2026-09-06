/**
 * 进度钟 Web 端入口——编排层。
 * - GM 主控模式：输入 GM 密钥（Bearer 鉴权）后获得编辑权限
 * - 玩家查看模式：URL 带 ?readonly 时纯只读（连登录入口都隐藏）
 *
 * 职责划分：会话状态（服务器/房间/凭证）在 core/session.ts，
 * 同步状态机（推送/轮询/断线退避）在 core/sync.ts，渲染与手势在 ui.ts。
 * 本文件只剩三件事：把模块接起来、实现 GmContext 的各房间操作、全局快捷键。
 *
 * 数据流（本地优先 + server 同步）：
 * - 启动：localStorage 立即显示 -> 异步拉取 server 状态替换（server 为权威）
 * - 变更：本地立即生效 + 防抖 500ms 全量推送（推送不带 version = force push）
 * - 冲突：409 -> 自动拉取最新状态替换 + 提示（多 GM 同时操作的兜底）
 * - server 不可达：保持本地 localStorage 数据，离线可用
 */
import './styles.css'
import { createEmptyState, isValidRoomName } from '../../common/types'
import {
  ApiError,
  changeRoomPwd,
  createRoom,
  deleteRoom,
  fetchRoomState,
  listRooms,
  renameRoom,
  saveRoomState,
  saveRoomStateForce,
  type VerifyResult,
  verifyKey,
  verifyRoomKey,
} from './api'
import { normalizeBase, Session } from './core/session'
import { SyncEngine } from './core/sync'
import { forgetRoom, type KnownRoom, loadKnownRooms, rememberRoom } from './known-rooms'
import { loadKnownServers, rememberServer } from './known-servers'
import {
  clearLocalState,
  forgetLocalRoom,
  getLocalOrigin,
  listLocalRooms,
  loadLocalState,
  localSlotKey,
  nextLocalName,
  rememberLocalRoom,
} from './local-rooms'
import { STORAGE_KEY, Store } from './state'
import { applyTheme, type GmContext, openRoomDialog, render, type UiState } from './ui'

const urlReadonly = new URLSearchParams(location.search).has('readonly')
// ?room= 是分享链接，指向的一定是远端房间；本地房间只按记忆恢复（不分享）
const roomFromUrl = new URLSearchParams(location.search).get('room')
// 分离模式：Web/dist 可脱离 server 单独打开（file:// 或任意静态托管），
// 通过 ?server=http://ip:2333 或 GM 弹窗填服务器地址连接任意后端
const serverFromUrl = new URLSearchParams(location.search).get('server')

const root = document.getElementById('app')
if (!root) throw new Error('找不到 #app 挂载点')
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
  sidebarRemoteOpen: true,
  sidebarLocalOpen: true,
  manageRoomDialog: false,
  manageError: '',
  localRoomDialog: false,
  localRoomError: '',
  pushLocalDialog: false,
  pushLocalSource: '',
  pushLocalQuery: '',
  pushLocalTarget: '',
  pushLocalError: '',
  pushLocalRooms: [],
  pushLocalLoading: false,
}

// ---------- 会话（服务器 / 房间 / 凭证，见 core/session.ts） ----------

const session = new Session({
  urlReadonly,
  urlServer: serverFromUrl ?? undefined,
  urlRoom: roomFromUrl ?? undefined,
})
// 分享链接里的 ?server= 是「GM 告诉玩家服务器在哪」的主要渠道：记进已知服务器，
// 下次打开（或装了 PWA 后从图标启动，URL 不带参数）不必再依赖链接
if (serverFromUrl) rememberServer(normalizeBase(serverFromUrl))

// ---------- 同步引擎（推送 / 轮询 / 断线退避，见 core/sync.ts） ----------

/** 对着当前服务器校验凭证：远端房间验 GM 密码，空白工作区验 GM_KEY，本地房间无需凭证 */
function checkGmKey(key: string): Promise<VerifyResult> {
  if (session.roomLocal) return Promise.resolve('ok' as VerifyResult)
  return session.room
    ? verifyRoomKey(session.serverBase, session.room, key)
    : verifyKey(session.serverBase, key)
}

/** GM 密码失效（推送 401）：清登录态 + 一条可见提示；加入密码错误则轮询侧静默，不经过这里 */
function rejectCredentialWithToast(): void {
  session.invalidateCredential()
  showToast(session.room ? 'GM 密码失效，请重新登录' : 'GM 密钥失效，请重新登录')
}

const sync = new SyncEngine(
  {
    get room() {
      return session.room
    },
    get joinPwd() {
      return session.joinPwd
    },
    canPush: () => session.canPush(),
    shouldPoll: () => session.room !== '' && !session.roomLocal && !session.authed,
    pull: () => fetchRoomState(session.serverBase, session.room, session.joinPwd),
    push: () =>
      saveRoomState(session.serverBase, session.room, session.gmKey ?? '', store.pushState),
    schedule: (fn, ms) => {
      const id = window.setTimeout(fn, ms)
      return () => window.clearTimeout(id)
    },
    toast: showToast,
    render: () => rerender(),
    promptRejoin: () => openRoomDialog(ui),
    onCredentialRejected: rejectCredentialWithToast,
  },
  store,
)

// 会话任何变更（进房 / 退房 / 换服务器 / 凭证增删）都自动重建轮询。
// 此前靠各操作尾部记得手动 syncPolling——漏调一个就是「改名后轮询还在打旧名字」这类陈旧上下文 bug
session.subscribe(() => sync.reconfigure())

// ---------- GmContext：ui.ts 只负责展示与收集输入，操作实现在这里 ----------

/**
 * 能否编辑眼前这份数据：本地房间 / 空白工作区永远可编辑；远端房间需 GM 凭证且在线。
 * 断线时（有凭证但连不上服务器）写操作一并置灰——push 不出去，改了也只是改本地暂存。
 * 与 canPush（session.canPush）是两个独立的问题——「能不能改」不该由「能不能同步」决定。
 */
const canEdit = (): boolean =>
  !urlReadonly &&
  (session.room === '' || session.roomLocal || (session.authed && sync.connState === 'reachable'))

const gm: GmContext = {
  urlReadonly,
  get authed() {
    return session.authed
  },
  /** 当前房间名（'' = 空白工作区） */
  get roomName() {
    return session.room
  },
  /** 当前加入密码（'' = 公开房间） */
  get roomJoinPwd() {
    return session.joinPwd
  },
  /**
   * 一次应用「服务器地址 + 凭证」。
   * 刻意不在这里 rerender：连接是异步的，中途重渲染会把用户正在填的弹窗整个换掉，
   * 等 await 回来时手上的节点已经是孤儿，错误提示写了也看不见。
   * 统一由调用方在结束后 rerender，提示文案走 ui.gmError 跟着状态一起重画。
   */
  onConnect: async (base, key) => {
    const next = normalizeBase(base)
    const serverChanged = next !== session.serverBase

    // 换服务器会丢掉本地尚未同步的改动，先确认
    if (
      serverChanged &&
      sync.dirty &&
      !confirm('本地有尚未同步到服务器的改动，切换服务器将丢弃这些改动。继续？')
    ) {
      return { ok: false, cancelled: true }
    }

    if (serverChanged) session.setServer(next)

    // 凭证：填了就验新的；没填但换了服务器，旧凭证要对着新服务器复验一次
    let error: string | null = null
    if (key) {
      const result = await checkGmKey(key)
      if (result === 'ok') {
        session.setCredential(key)
        // 已加入的远端房间里登录 GM：把写凭证记进 known-rooms，
        // 之后「提交本地房间」到它直接复用，不用再以 GM 身份进一次
        if (session.room && !session.roomLocal) {
          const entry = loadKnownRooms().find(
            (r) => r.server === session.serverBase && r.room === session.room,
          )
          rememberRoom({
            server: session.serverBase,
            room: session.room,
            joinPwd: entry?.joinPwd ?? session.joinPwd,
            gmPwd: key,
          })
        }
      } else if (result === 'unauthorized') {
        error = session.room ? 'GM 密码无效，请重试' : 'GM 密钥无效，请重试'
      } else {
        // 连不上时要说清楚是「没验成」，而不是指控用户的密钥不对
        error = '无法连接服务器，凭证未验证'
      }
    } else if (serverChanged && session.gmKey) {
      const result = await checkGmKey(session.gmKey)
      session.setAuthed(result === 'ok')
      if (result === 'unauthorized') session.invalidateCredential()
    }

    // 换了服务器才重拉；拉到就把 dirty 归零——本地已与服务端一致
    if (serverChanged) {
      try {
        store.replaceState(await fetchRoomState(session.serverBase, session.room, session.joinPwd))
        sync.resetDirty()
      } catch {
        // 连接失败：配置已保存，本地数据保持可用（离线兜底），下次刷新重试
        showToast('无法连接服务器，已保持本地数据')
      }
    }

    return error ? { ok: false, error } : { ok: true }
  },
  onLogout: () => {
    session.invalidateCredential()
    rerender()
  },
  /** 当前生效的服务器地址（'' = 同源） */
  get serverBase() {
    return session.serverBase
  },
  /** 加入房间（GitHub 模型：pull 到本地；gmPwd 可空 = 只读玩家） */
  onJoinRoom: async (room: string, joinPwd: string, gmPwd: string) => {
    // 加入会用房间状态整体覆盖本地，与切换房间/服务器一样先确认
    if (sync.dirty && !confirm('本地有尚未同步到服务器的改动，加入房间将丢弃这些改动。继续？')) {
      return { ok: false as const, error: '已取消' }
    }
    try {
      const remote = await fetchRoomState(session.serverBase, room, joinPwd)
      enterRoom(room, joinPwd)
      store.replaceState(remote)
      // 本地已被远端整体替换，此刻与服务端同版本——dirty 必须归零。
      // 漏掉这一句，轮询会被 if (dirty) return 永久挡死，刚进的房间从此是个静止快照
      sync.resetDirty()
      ui.sidebarOpen = false
      // 只有验证通过的 GM 密码才值得缓存；否则下次切换会被无声地当成玩家
      let effectiveGmPwd = ''
      if (gmPwd) {
        const result = await verifyRoomKey(session.serverBase, room, gmPwd)
        if (result === 'ok') {
          session.setCredential(gmPwd)
          effectiveGmPwd = gmPwd
        } else {
          showToast(
            result === 'unauthorized'
              ? 'GM 密码错误，已以只读身份进入'
              : '未能验证 GM 密码，已以只读身份进入',
          )
        }
      }
      rememberRoom({ server: session.serverBase, room, joinPwd, gmPwd: effectiveGmPwd })
      rerender()
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
  },
  /** 新建远端房间（从空开始，不继承当前画布；内容靠手动 push / 提交上传） */
  onCreateRoom: async (room: string, joinPwd: string, gmPwd: string) => {
    try {
      await createRoom(session.serverBase, room, joinPwd, gmPwd)
      enterRoom(room, joinPwd)
      ui.sidebarOpen = false
      session.setCredential(gmPwd)
      // 新房间从空开始：服务端建仓即空状态（version 0），本地画布也置空，两边对齐。
      // 不再像旧版那样把当前画布一起 push 进新房间——想把已有内容搬进来，
      // 走「提交本地房间」（选一份本地房间）或直接在空房里重做再保存。
      store.replaceState(createEmptyState())
      sync.resetDirty()
      rememberRoom({ server: session.serverBase, room, joinPwd, gmPwd })
      rerender()
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
  },
  /** 拉取房间列表（公开；失败静默返回空） */
  onListRooms: async () => {
    try {
      return await listRooms(session.serverBase)
    } catch {
      return []
    }
  },
  /** 本机缓存的已知房间（含密码），供侧边栏一键切换 */
  get knownRooms() {
    return loadKnownRooms()
  },
  /** 本机记住的服务器地址（最近使用的在前），连接弹窗里点选即填 */
  get knownServers() {
    return loadKnownServers()
  },
  /** 切换到已知房间：直接用缓存的密码进，不必重输 */
  onSwitchRoom: async (entry: KnownRoom) => {
    if (entry.room === session.room && entry.server === session.serverBase) {
      return { ok: true as const }
    }
    // 切房间会整体覆盖本地状态，有未同步改动时先确认（与切换服务器一致）
    if (sync.dirty && !confirm('本地有尚未同步到服务器的改动，切换房间将丢弃这些改动。继续？')) {
      return { ok: false as const, error: '已取消' }
    }
    try {
      const remote = await fetchRoomState(entry.server, entry.room, entry.joinPwd)
      // 已知房间自带服务器地址：切过去时连地址一起换（这就是「一键切换」的意义）
      session.setServer(entry.server)
      enterRoom(entry.room, entry.joinPwd)
      store.replaceState(remote)
      // 同加入房间：本地已被远端整体替换，dirty 归零，否则轮询永久停摆
      sync.resetDirty()
      ui.sidebarOpen = false
      if (entry.gmPwd) {
        const result = await verifyRoomKey(session.serverBase, entry.room, entry.gmPwd)
        // 先记后验：没问出结果（连不上 / 服务端出错）时保留缓存的密码，下次切换还能再试；
        // 只有服务器明确说不对才丢——known-rooms 里的写凭证一并抹掉，
        // 否则「可编辑」标签继续挂着失效密码，下次切换照样无声失败（决策：只缓存验证通过的 GM 密码）
        session.setCredentialUnverified(entry.gmPwd)
        session.setAuthed(result === 'ok')
        if (result === 'ok') session.persistCredential()
        else if (result === 'unauthorized') {
          session.invalidateCredential()
          forgetRoom(entry.server, entry.room)
          rememberRoom({
            server: entry.server,
            room: entry.room,
            joinPwd: entry.joinPwd,
            gmPwd: '',
          })
        }
      } else {
        session.invalidateCredential()
      }
      // 刷新 lastAt，让它排到缓存列表最前
      rememberRoom({
        server: entry.server,
        room: entry.room,
        joinPwd: entry.joinPwd,
        gmPwd: entry.gmPwd,
      })
      rerender()
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
      await deleteRoom(session.serverBase, room, session.gmKey ?? '')
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
    // 服务器上的房间没了，本机缓存里的这条也一并清掉
    forgetRoom(session.serverBase, room)
    leaveRoom()
    showToast(`房间「${room}」已删除`)
    return { ok: true as const }
  },
  /** 退出当前房间，回到本地空白工作区（远端房间保留在服务器上） */
  onLeaveRoom: async () => {
    if (sync.dirty && !confirm('本地有尚未同步到服务器的改动，退出房间将丢弃这些改动。继续？')) {
      return { ok: false as const, error: '已取消' }
    }
    leaveRoom()
    return { ok: true as const }
  },
  /** 当前是否在本地房间（本地房间永远可编辑、永不联网） */
  get roomLocal() {
    return session.roomLocal
  },
  /** 本机已建的本地房间列表 */
  get localRooms() {
    return listLocalRooms()
  },
  /** 本地房间的来源远端（另存为本地 / 提交成功时记录），提交时优先一键回推 */
  getLocalOrigin: (name: string) => getLocalOrigin(name),
  /** 新建本地房间：重名自动顺延 (2)；创建后直接进入（顺带收起侧边栏——手机抽屉选中即关） */
  onCreateLocalRoom: (name: string) => {
    enterLocalRoom(nextLocalName(name.trim() || '未命名房间'))
    ui.sidebarOpen = false
    rerender()
    return { ok: true as const }
  },
  /** 删除本地房间：清注册表与状态槽；删的是当前房间则退回空白工作区 */
  onDeleteLocalRoom: (name: string) => {
    forgetLocalRoom(name)
    clearLocalState(name)
    if (session.room === name && session.roomLocal) {
      leaveRoom()
    } else {
      rerender()
    }
    return { ok: true as const }
  },
  /** 进入已有的本地房间（读它的状态槽，不联网；收起侧边栏——手机抽屉选中即关） */
  onEnterLocalRoom: (name: string) => {
    enterLocalRoom(name)
    ui.sidebarOpen = false
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
      await changeRoomPwd(session.serverBase, session.room, session.gmKey ?? '', patch)
    } catch (e) {
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
    if (patch.gmPwd) session.setCredential(patch.gmPwd)
    if (patch.joinPwd) session.setJoinPwd(patch.joinPwd)
    // known-rooms 缓存里该条也刷新（只动存在的那条，别改排序）
    const entry = loadKnownRooms().find(
      (r) => r.server === session.serverBase && r.room === session.room,
    )
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
  /**
   * 提交本地房间 → 远端（GitHub 模型的 force push）：把一份本地房间整体覆盖到目标已有远端房间。
   * 新建远端房间走侧边栏「+」，这里只推已有目标——写凭证用缓存/当前登录的 GM 密码，弹窗不再手输。
   * 401 视为凭证失效：清掉缓存，让用户重新以 GM 身份进入该房间获取新密码后再试。
   * 成功后记住远端来源，下次提交默认选中一键回推。
   */
  onPushLocalRoom: async (name: string, target: string) => {
    const room = target.trim()
    if (!room) return { ok: false as const, error: '请点选一个目标远端房间' }
    const state = loadLocalState(name)
    // 已有房间的写凭证：本机缓存过 GM 密码就用它，否则退回当前登录凭证
    const cached = loadKnownRooms().find((r) => r.server === session.serverBase && r.room === room)
    const pwd = cached?.gmPwd || session.gmKey || ''
    if (!pwd) {
      return { ok: false as const, error: `没有「${room}」的 GM 密码，请先以 GM 身份进入该房间` }
    }
    try {
      // force push：整体覆盖目标已有房间（内容是本次提交的本地草稿）
      await saveRoomStateForce(session.serverBase, room, pwd, state)
      showToast(`本地房间「${name}」已提交，覆盖了「${room}」`)
      // 记住远端来源：下次提交直接默认选中回推目标
      rememberRoom({ server: session.serverBase, room, joinPwd: '', gmPwd: pwd })
      rememberLocalRoom(name, { server: session.serverBase, room })
      return { ok: true as const }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // GM 密码失效：本机缓存不可信，清掉这条房间的写凭证；若当前正以它登录，一并登出
        forgetRoom(session.serverBase, room)
        if (session.room === room && !session.roomLocal) session.invalidateCredential()
        return {
          ok: false as const,
          error: `「${room}」的 GM 密码无效，请重新以 GM 身份进入后再试`,
        }
      }
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
  },
  /**
   * 重命名当前房间（保留全部内容与密码）：远端走服务端原子改名，旧名立即 404——
   * 玩家若缓存旧分享链接会失效，需要换新仓库；本地房间在本地复制状态槽改名，不联网。
   */
  onRenameRoom: async (newName: string) => {
    const next = newName.trim()
    if (!next || next === session.room) return { ok: false as const, error: '房间名未变化' }
    if (!isValidRoomName(next)) {
      return { ok: false as const, error: '房间名不合法（1-32 位，不能用 / \\ < > : " | ? *）' }
    }
    if (session.roomLocal) {
      // 本地房间：本地改名——把状态槽与注册表（含来源记录）迁到新名字，再切过去
      try {
        localStorage.setItem(localSlotKey(next), JSON.stringify(loadLocalState(session.room)))
      } catch {
        return { ok: false as const, error: '本机存储空间不足' }
      }
      const origin = getLocalOrigin(session.room)
      rememberLocalRoom(next, origin)
      forgetLocalRoom(session.room)
      clearLocalState(session.room)
      enterLocalRoom(next)
      rerender()
      showToast(`本地房间已改名「${next}」`)
      return { ok: true as const }
    }
    // 远端房间：服务端原子改名（内容与密码原样保留）
    try {
      await renameRoom(session.serverBase, session.room, session.gmKey ?? '', next)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        session.invalidateCredential()
        return { ok: false as const, error: 'GM 密码无效，请重新登录后再改名' }
      }
      return { ok: false as const, error: e instanceof ApiError ? e.message : '无法连接服务器' }
    }
    // 改名后本机各处引用同步到新名字：known-rooms 缓存、当前会话与 URL、本地副本的来源记录
    const oldName = session.room
    const entry = loadKnownRooms().find(
      (r) => r.server === session.serverBase && r.room === oldName,
    )
    if (entry) {
      forgetRoom(session.serverBase, oldName)
      rememberRoom({
        server: entry.server,
        room: next,
        joinPwd: entry.joinPwd,
        gmPwd: entry.gmPwd,
      })
    }
    // 指向旧名的本地副本（另存为本地）来源记录跟着改成新名，回推目标不失效
    for (const local of listLocalRooms()) {
      const o = getLocalOrigin(local)
      if (o && o.server === session.serverBase && o.room === oldName) {
        rememberLocalRoom(local, { server: o.server, room: next })
      }
    }
    // 当前会话切到新名字：内容本就在全局槽没动，enterRoom 只是换名字与 URL
    enterRoom(next, session.joinPwd)
    rerender()
    showToast(`房间已改名「${next}」，旧名「${oldName}」已失效`)
    return { ok: true as const }
  },
  /**
   * 另存为本地：把当前远端房间整体复制成一个本地房间（快照）。
   * 断网后远端会失去写权限，或房间不是自己的却想借鉴时，都靠这份离线副本兜底。
   * 复制不打断当前会话：仍留在远端房间，本地副本走侧边栏进。
   */
  onSaveAsLocal: () => {
    if (!session.room || session.roomLocal) return { ok: false as const, error: '当前不是远端房间' }
    const name = nextLocalName(session.room)
    try {
      // 与 Store.persist 同格式：JSON 原样落进新本地房间的状态槽
      localStorage.setItem(localSlotKey(name), JSON.stringify(store.state))
    } catch {
      return { ok: false as const, error: '本机存储空间不足' }
    }
    // 记住来源远端：之后「提交本地房间」可直接一键回推
    rememberLocalRoom(name, { server: session.serverBase, room: session.room })
    showToast(`已另存为本地「${name}」`)
    rerender()
    return { ok: true as const }
  },
  /** 连接状态（reachable / 重试中 / 离线），由轮询结果推导；本地房间与空白工作区恒 reachable */
  get connState() {
    return sync.connState
  },
  /** 手动「重试」：立刻发一次轮询请求并把退避重置回起点（断线横幅上的按钮） */
  get onRetryNow() {
    return () => sync.retryNow()
  },
}

const rerender = () => render(root, store, ui, !canEdit(), rerender, gm)

// ---------- 房间进入 / 退出（会话记忆在 session；URL 与状态槽归这里） ----------

/**
 * 保存房间配置并进入：更新 room/加入密码记忆 + URL 同步（密码不进 URL）。
 * 刻意不动服务器地址：它只由「连接与登录」改，进房间不该顺带换服务器——
 * 房间是另一台服务器上的另一个仓库，悄悄把地址也换了只会让人困惑
 */
function enterRoom(room: string, joinPwd: string): void {
  session.enterRemoteRoom(room, joinPwd)
  // 承接远端数据的槽位是全局槽：从本地房间切过来要先复位，否则远端状态会被写进本地房间的槽
  store.attachSlot(STORAGE_KEY)
  const params = new URLSearchParams(location.search)
  if (session.serverBase) params.set('server', session.serverBase)
  params.set('room', room)
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`)
}

/** 进入本地房间：换到该房间的状态槽，不联网、永远可编辑 */
function enterLocalRoom(name: string): void {
  session.enterLocalRoom(name)
  // 本地房间不写 ?room=（它是本地概念，分享无意义）
  const params = new URLSearchParams(location.search)
  params.delete('room')
  const qs = params.toString()
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`)
  sync.resetDirty()
  store.attachSlot(localSlotKey(name))
  rememberLocalRoom(name)
}

/**
 * 退出当前房间、回到本地空白工作区（与 enterRoom / enterLocalRoom 对偶）。
 * 空白工作区是纯本地的：不联网、不拉默认房间，点侧边栏「本地 +」可新建本地房间继续干活。
 */
function leaveRoom(): void {
  // session.leave() 内部先清凭证再清房间名（顺序错了会删错本机键）
  session.leave()
  const params = new URLSearchParams(location.search)
  params.delete('room')
  const qs = params.toString()
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`)
  sync.resetDirty()
  // 空白工作区是干净起步：先切回全局槽，再置空（不留上一个远端房间的缓存）
  store.attachSlot(STORAGE_KEY)
  store.replaceState(createEmptyState())
  rerender()
}

// ---------- 启动 ----------

/** 顶部短暂提示（冲突 / 密钥失效等） */
function showToast(msg: string): void {
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = msg
  document.body.append(toast)
  setTimeout(() => toast.remove(), 3500)
}

// 启动时验证本地已存的密钥是否仍有效
if (!urlReadonly && session.gmKey) {
  void checkGmKey(session.gmKey).then((result) => {
    session.setAuthed(result === 'ok')
    // 只有服务器明确说「凭证不对」才丢弃。连不上时保留：
    // 离线打开远端房间必然校验失败，若据此清空，联网后还得重新输一遍密码
    if (result === 'unauthorized') session.invalidateCredential()
    rerender()
  })
}

rerender()

// 启动即本地工作区（目标架构：不强制进远端房间）：
// - 本地房间：切到该房间的状态槽，不联网
// - 远端房间：拉服务器状态（server 权威；失败进断线状态机，5s 后重试）
// - 空白工作区：干净起步，构造器已从全局槽恢复上次内容，这里只渲染、不拉任何东西。
//   绝不能 replaceState 置空——那会丢掉工作区里没进房间的钟，刷新/重开即失忆（?demo 也因此失效过）
if (session.roomLocal) {
  store.attachSlot(localSlotKey(session.room))
  rerender()
} else if (session.room) {
  sync.bootstrap()
} else {
  rerender()
}

// 启动即按「是否已持有写凭证」决定轮询；GM 密钥验证通过后 reconfigure 会停掉它
sync.reconfigure()

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
    else if (ui.pushLocalDialog) {
      ui.pushLocalDialog = false
      ui.pushLocalError = ''
    } else if (ui.localRoomDialog) ui.localRoomDialog = false
    else if (ui.manageRoomDialog) {
      ui.manageRoomDialog = false
      ui.manageError = ''
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
  if (urlReadonly || !session.authed) return

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
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyTheme()
  rerender()
})

// ---------- PWA ----------

// 仅安全上下文注册（https 或 localhost）：http 局域网直连下 Service Worker 不可用，
// register 会直接拒绝——静默忽略，网页行为不受任何影响。
// './' 相对路径：base './' 的构建产物部署在任意子路径下，scope 都自动跟随所在目录
if ('serviceWorker' in navigator && window.isSecureContext) {
  void navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const next = reg.installing
        next?.addEventListener('statechange', () => {
          // 首次安装（尚无 controller）不算「更新」；有等待中的新版本才提示
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('已更新到新版本，下次打开生效')
          }
        })
      })
    })
    .catch(() => {})
}
