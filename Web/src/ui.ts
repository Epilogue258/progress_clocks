import type { ProgressClock } from '../../common/types'
import { CLOCK_MAX_SEGMENTS, CLOCK_MIN_SEGMENTS, clampInt } from '../../common/types'
import { PALETTE, Store } from './state'
import { svgClock } from './clock-svg'
import { exportStateAsPng } from './export'
import { bindDragHandle } from './drag-sort'
import type { KnownRoom } from './known-rooms'

/**
 * 连接弹窗在 `⋯` 菜单里的名字。
 * 抽成常量是因为房间弹窗的提示要按名字给用户指路——
 * 两处各写一份字面量的话，改了一边就会指到不存在的菜单项上。
 */
export const CONNECT_MENU_LABEL = '连接与登录'

export type ViewMode = 'grid' | 'list'

export interface UiState {
  view: ViewMode
  settingsClockId: string | null
  /** 新建弹窗开关 */
  creating: boolean
  /** GM 登录弹窗开关 */
  gmDialog: boolean
  /**
   * GM 弹窗里的提示文案（连接中 / 密钥无效 / 已取消）。
   * 之所以放进 UiState 而不是直接写 DOM：连接是异步的，
   * 中途任何一次 rerender 都会重建弹窗、丢掉手写的提示节点——
   * 提示是状态，就该跟状态一起重渲染。
   */
  gmError: string
  /** 房间连接弹窗开关 */
  roomDialog: boolean
  /** 侧边栏点击预填的房间名（只在弹窗没被填过时生效） */
  roomPrefill: string
  /**
   * 房间弹窗里用户正在填的内容（区别于 roomPrefill 的预填值）。
   * 存进状态是因为连接失败后要整体重渲染来显示错误，
   * 草稿不落状态的话，一次报错就会把三个框清空。
   */
  roomDraft: { name: string; joinPwd: string; gmPwd: string }
  /** 侧边栏展开开关（汉堡菜单） */
  sidebarOpen: boolean
  /** 顶栏「更多」菜单展开（低频操作收在这里，顶栏才不会挤成一排） */
  moreMenuOpen: boolean
  /** 快捷键说明弹窗 */
  shortcuts: boolean
  /** 侧边栏的房间搜索词（存这里，重渲染时不丢） */
  sidebarQuery: string
  /** 房间弹窗的提示文案（连接中 / 密码错误 / 重名等）。同 gmError，异步结果不写 DOM */
  roomError: string
  /** 侧边栏「远程房间」折叠组是否展开（默认展开） */
  sidebarRemoteOpen: boolean
  /** 侧边栏「本地房间」折叠组是否展开（默认展开） */
  sidebarLocalOpen: boolean
  /** 已连接时的房间管理弹窗（保存更改=改密码 / 删除房间 / 退出） */
  manageRoomDialog: boolean
  /** 房间管理弹窗的提示文案 */
  manageError: string
  /** 房间管理弹窗里「保存更改（改密码）」表单是否展开 */
  changePwdOpen: boolean
  /** 改密码表单草稿（报错重渲染时不丢） */
  changePwdDraft: { joinPwd: string; gmPwd: string }
  /** 新建本地房间弹窗 */
  localRoomDialog: boolean
  /** 新建本地房间弹窗的草稿名 */
  localRoomDraft: string
  /** 新建本地房间弹窗的提示文案 */
  localRoomError: string
  /** 「提交本地房间」（本地 → 远端 force push）弹窗 */
  pushLocalDialog: boolean
  /** 提交弹窗「远端目标」的搜索词（存这里，重渲染/过滤时不丢） */
  pushLocalQuery: string
  /** 提交弹窗「本地来源」的搜索词（同上，两个选择器各自独立） */
  pushLocalSourceQuery: string
  /** 提交弹窗选中的本地来源（本地房间里默认是当前房间，可换成别的本地房间） */
  pushLocalSource: string
  /** 提交弹窗的提示文案 */
  pushLocalError: string
  /** 提交弹窗里的远端房间列表（供搜索选中；异步拉取，先置空再回填） */
  pushLocalRooms: string[]
  /** 提交弹窗是否正在拉取房间列表 */
  pushLocalLoading: boolean
}

export type Rerender = () => void

/**
 * 打开房间弹窗的唯一切入口。
 * 四个调用点（顶栏 / 侧边栏 / 分离模式进页面 / 私有房间 401）如果各自设 roomDialog，
 * 就都得记得顺手清掉上一次的错误提示和草稿，漏一个就会看到上一条残留。
 * 草稿在这里清空而不是在 close() 里：失败重渲染时草稿要留着，只在重新打开时归零。
 */
export function openRoomDialog(ui: UiState, prefill = ''): void {
  ui.roomDialog = true
  ui.roomPrefill = prefill
  ui.roomError = ''
  ui.roomDraft = { name: '', joinPwd: '', gmPwd: '' }
}

/** 新建一个空草稿 */
export function emptyRoomDraft(): UiState['roomDraft'] {
  return { name: '', joinPwd: '', gmPwd: '' }
}

/** 房间操作结果 */
export type RoomResult = { ok: true } | { ok: false; error: string }

/**
 * 连接结果（服务器地址 + 凭证一次提交）。
 * cancelled：用户在「切换会丢弃本地改动」的确认框上点了取消，什么都没改
 * error：可直接展示给用户的失败原因
 */
export type ConnectResult = { ok: true } | { ok: false; cancelled?: boolean; error?: string }

/** GM 鉴权上下文（由 main.ts 提供，ui.ts 只负责展示与收集输入） */
export interface GmContext {
  /** URL 是否强制只读（?readonly 玩家模式：连登录入口都隐藏） */
  urlReadonly: boolean
  /** 当前是否已通过密钥验证 */
  authed: boolean
  /**
   * 一次提交「服务器地址 + 凭证」。
   * 合起来而不是拆成两个动作：地址与凭证本来就是同一次连接的两半，
   * 分开提交会多一次重渲染，也会把「换服务器」和「登录」变成两步多余操作。
   * key 留空 = 不动凭证（只换服务器时用旧凭证对新服务器复验一次）。
   * 实现侧不重渲染，由调用方在结束后统一 rerender。
   */
  onConnect: (base: string, key: string) => Promise<ConnectResult>
  /** 清除登录态 */
  onLogout: () => void
  /** 当前生效的服务器地址（'' = 同源） */
  serverBase: string
  /** 当前房间名（'' = 空白工作区） */
  roomName: string
  /** 当前是否在本地房间（本地房间永远可编辑、永不联网） */
  roomLocal: boolean
  /** 当前加入密码（'' = 公开房间） */
  roomJoinPwd: string
  /**
   * 加入房间（main 侧 pull 到本地；gmPwd 可空 = 只读玩家）。
   * 不带 server 参数：服务器地址只由「连接与登录」弹窗负责，
   * 房间弹窗只管选哪个仓库，join/create 都不再动 API_BASE
   */
  onJoinRoom: (room: string, joinPwd: string, gmPwd: string) => Promise<RoomResult>
  /** 新建房间（main 侧建仓 + push 本地状态） */
  onCreateRoom: (room: string, joinPwd: string, gmPwd: string) => Promise<RoomResult>
  /** 拉取房间列表（公开） */
  onListRooms: () => Promise<string[]>
  /** 本机缓存的已知房间（含密码），供侧边栏一键切换 */
  knownRooms: KnownRoom[]
  /** 切换到已知房间：直接用缓存的密码进，不必重输 */
  onSwitchRoom: (entry: KnownRoom) => Promise<RoomResult>
  /** 忘记某个已知房间：只清本机缓存，不动服务器上的房间 */
  onForgetRoom: (entry: KnownRoom) => void
  /** 删除房间（需已登录 GM；不可恢复，调用方先确认） */
  onDeleteRoom: (room: string) => Promise<RoomResult>
  /** 退出当前房间回到本地空白工作区（远端房间保留在服务器上；本地未同步改动会丢，调用方先确认） */
  onLeaveRoom: () => Promise<RoomResult>
  /** 本机已建的本地房间列表 */
  localRooms: string[]
  /** 新建本地房间（重名自动顺延 (2)；创建后直接进入） */
  onCreateLocalRoom: (name: string) => RoomResult
  /** 删除本地房间（清注册表与状态槽；删的是当前房间则退回空白工作区） */
  onDeleteLocalRoom: (name: string) => RoomResult
  /** 进入已有的本地房间（读它的状态槽，不联网） */
  onEnterLocalRoom: (name: string) => RoomResult
  /** 修改房间密码（PATCH）：只改填了的字段；改完同步本机缓存 */
  onChangePwd: (joinPwd: string, gmPwd: string) => Promise<RoomResult>
  /** 本地房间的来源远端（另存为本地 / 提交成功时记录），提交时优先一键回推 */
  getLocalOrigin: (name: string) => { server: string; room: string } | undefined
  /**
   * 提交本地房间到远端（force push）：目标不存在则新建、存在则整体覆盖。
   * 入口仅对 GM 可见，写凭证不再手输——已有房间用缓存/当前登录凭证，新房间由弹窗提供 GM 密码。
   */
  onPushLocalRoom: (name: string, target: string, newGmPwd?: string) => Promise<RoomResult>
  /** 另存为本地：当前远端房间整体复制为一个本地房间（快照，含来源记录） */
  onSaveAsLocal: () => RoomResult
}

// ---------- 主题（深浅模式：跟随系统 + 手动切换） ----------

const THEME_KEY = 'pc-theme'

function getTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'dark' || saved === 'light') return saved
  // 未设置：跟随系统（不落盘，用户点过按钮后才固定）
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(): 'dark' | 'light' {
  const t = getTheme()
  document.documentElement.dataset.theme = t
  return t
}

export function toggleTheme(): 'dark' | 'light' {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  localStorage.setItem(THEME_KEY, next)
  applyTheme()
  return next
}

// ---------- 渲染 ----------

export function render(
  root: HTMLElement,
  store: Store,
  ui: UiState,
  readonly: boolean,
  rerender: Rerender,
  gm: GmContext,
): void {
  root.textContent = ''
  root.append(renderTopbar(store, ui, readonly, rerender, gm))
  const body = el('div', 'main-body')
  if (ui.sidebarOpen) body.append(renderRoomSidebar(ui, gm, rerender))
  body.append(
    ui.view === 'grid'
      ? renderGrid(store, ui, readonly, rerender)
      : renderList(store, ui, readonly, rerender),
  )
  root.append(body)
  if (!readonly) {
    const fab = el('button', 'fab', '+')
    fab.setAttribute('aria-label', '新建进度钟')
    fab.addEventListener('click', () => {
      ui.creating = true
      rerender()
    })
    root.append(fab)
  }
  if (ui.roomDialog) {
    root.append(renderRoomModal(ui, gm, rerender))
  }
  if (ui.manageRoomDialog) {
    root.append(renderManageRoomModal(ui, gm, rerender))
  }
  if (ui.localRoomDialog) {
    root.append(renderLocalRoomModal(ui, gm, rerender))
  }
  if (ui.pushLocalDialog) {
    root.append(renderPushLocalModal(ui, gm, rerender))
  }
  if (!gm.urlReadonly && ui.gmDialog) {
    root.append(renderGmLoginModal(ui, gm, rerender))
  }
  if (!readonly && ui.creating) {
    root.append(renderNewClockModal(store, ui, rerender))
  }
  if (!readonly && ui.settingsClockId) {
    const clock = store.state.clocks[ui.settingsClockId]
    if (clock) root.append(renderSettings(clock, store, ui, rerender))
  }
  if (ui.moreMenuOpen) {
    root.append(renderMoreMenu(store, ui, readonly, rerender, gm))
  }
  if (ui.shortcuts) {
    root.append(renderShortcutsModal(ui, rerender))
  }
}

// ---------- 工具 ----------

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (tag === 'button') node.setAttribute('type', 'button')
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * 创建输入框。文本类统一挂 .text-input 样式类——
 * 此前各处手写 createElement('input') 再逐个设属性，
 * 一旦 CSS 选择器漏掉某个 type（比如 password）就会掉回浏览器默认外观。
 * type='color' 不挂该类（取色器有自己的尺寸规则）。
 */
function makeInput(
  type: 'text' | 'password' | 'number' | 'color',
  placeholder = '',
  value = '',
): HTMLInputElement {
  const input = document.createElement('input')
  input.type = type
  if (type !== 'color') input.className = 'text-input'
  if (placeholder) input.placeholder = placeholder
  if (value) input.value = value
  input.autocomplete = 'off'
  return input
}

/**
 * 规范化 hex 颜色：#abc / abc / #aabbcc / aabbcc 都收，统一成小写 #rrggbb。
 * 非法返回 null，由调用方决定是提示还是忽略。
 */
function normalizeHexColor(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toLowerCase()
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`
  return null
}

/** 新建 / 设置弹窗的通用外壳：关闭时回调 onClose（清状态 + 重渲染） */
function modalShell(
  title: string,
  onClose: () => void,
): { backdrop: HTMLElement; modal: HTMLElement; close: () => void } {
  const backdrop = el('div', 'modal-backdrop')
  const modal = el('div', 'modal')
  backdrop.append(modal)
  modal.append(el('h2', 'modal-title', title))
  const close = () => {
    backdrop.remove()
    onClose()
  }
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close()
  })
  return { backdrop, modal, close }
}

// ---------- 顶栏 ----------

function renderTopbar(
  store: Store,
  ui: UiState,
  readonly: boolean,
  rerender: Rerender,
  gm: GmContext,
): HTMLElement {
  const bar = el('header', 'topbar')
  // 汉堡菜单：展开/收起侧边栏（房间列表）
  const menuBtn = el('button', 'tbtn menu-btn', '☰')
  menuBtn.title = '展开/收起房间列表'
  menuBtn.setAttribute('aria-label', '展开/收起侧边栏')
  menuBtn.addEventListener('click', () => {
    ui.sidebarOpen = !ui.sidebarOpen
    rerender()
  })
  bar.append(menuBtn)
  bar.append(el('span', 'title', '进度钟'))

  // 房间入口：已连接 → 打开房间管理弹窗；空白工作区 → 打开侧边栏（房间都在那儿建）
  const roomLabel = gm.roomName || '工作区'
  const roomBtn = el('button', 'tbtn room-btn', roomLabel)
  roomBtn.title = gm.roomName
    ? `房间：${gm.roomName}（点击管理）`
    : '本地工作区（点击打开房间列表）'
  roomBtn.addEventListener('click', () => {
    if (gm.roomName) {
      ui.manageRoomDialog = true
      ui.manageError = ''
      ui.changePwdOpen = false
      ui.changePwdDraft = { joinPwd: '', gmPwd: '' }
    } else {
      ui.sidebarOpen = true
    }
    rerender()
  })
  bar.append(roomBtn)

  const viewBtn = el('button', 'tbtn', ui.view === 'grid' ? '☷ 网格' : '≡ 列表')
  viewBtn.title = '切换网格 / 列表视图'
  viewBtn.addEventListener('click', () => {
    ui.view = ui.view === 'grid' ? 'list' : 'grid'
    rerender()
  })
  bar.append(viewBtn)

  // 高频操作留在顶栏：撤销是 GM 改错后的第一反应，不该藏进菜单
  if (!readonly) {
    const undoBtn = el('button', 'tbtn', '↶ 撤销') as HTMLButtonElement
    undoBtn.disabled = !store.canUndo
    undoBtn.title = '撤销（Ctrl+Z）'
    undoBtn.addEventListener('click', () => {
      store.undo()
      rerender()
    })

    const redoBtn = el('button', 'tbtn', '↷ 重做') as HTMLButtonElement
    redoBtn.disabled = !store.canRedo
    redoBtn.title = '重做（Ctrl+Y）'
    redoBtn.addEventListener('click', () => {
      store.redo()
      rerender()
    })

    const newBtn = el('button', 'tbtn primary', '＋ 新建')
    newBtn.title = '新建进度钟（Ctrl+N）'
    newBtn.addEventListener('click', () => {
      ui.creating = true
      rerender()
    })
    bar.append(undoBtn, redoBtn, newBtn)
  }

  // 低频操作收进「更多」，顶栏才不至于挤成一排（手机端尤其明显）
  const moreBtn = el('button', 'tbtn more-btn', '⋯')
  moreBtn.title = '更多'
  moreBtn.setAttribute('aria-label', '更多操作')
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    ui.moreMenuOpen = !ui.moreMenuOpen
    rerender()
  })
  bar.append(moreBtn)

  return bar
}

// ---------- 顶栏「更多」菜单 ----------

function menuItem(
  label: string,
  onSelect: () => void,
  className = '',
): HTMLButtonElement {
  const item = el('button', `menu-item ${className}`.trim(), label) as HTMLButtonElement
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    onSelect()
  })
  return item
}

function renderMoreMenu(
  store: Store,
  ui: UiState,
  readonly: boolean,
  rerender: Rerender,
  gm: GmContext,
): HTMLElement {
  // 透明全屏层：点菜单以外的任何地方即关闭
  const backdrop = el('div', 'menu-backdrop')
  backdrop.addEventListener('click', () => {
    ui.moreMenuOpen = false
    rerender()
  })

  const menu = el('div', 'more-menu')

  if (!gm.urlReadonly) {
    menu.append(
      // 标签固定不随登录态变：弹窗里既能连服务器也能管凭证，「GM 登录」装不下，
      // 而房间弹窗的提示又要按名字指路，两处叫法必须一致
      menuItem(CONNECT_MENU_LABEL, () => {
        ui.moreMenuOpen = false
        ui.gmDialog = true
        ui.gmError = ''
        rerender()
      }),
    )
  }

  // 退出房间：低频操作，和连接与登录同一档（进房间后才有）
  if (gm.roomName) {
    menu.append(
      menuItem('退出房间', () => {
        ui.moreMenuOpen = false
        void gm.onLeaveRoom().then(() => rerender())
      }),
    )
  }

  // 另存为本地：把当前远端房间复制成本地快照（断网/借鉴时离线兜底），只在远端房间出现
  if (gm.roomName && !gm.roomLocal) {
    menu.append(
      menuItem('另存为本地', () => {
        ui.moreMenuOpen = false
        gm.onSaveAsLocal()
      }),
    )
  }

  // 提交本地房间：本地 → 远端 force push。提交是写入操作，入口只对 GM 可见——
  // 没有写权限（未登录 GM）的人根本不该看到这个按钮。本地房间里来源固定为当前房间；
  // 远端房间里也要能进——在远端选「提交房间——提交哪个？搜索/点选」，让本地草稿推得到任意远端目标
  if (gm.roomName && gm.authed && !gm.urlReadonly) {
    menu.append(
      menuItem('提交本地房间', () => {
        ui.moreMenuOpen = false
        ui.pushLocalDialog = true
        ui.pushLocalError = ''
        ui.pushLocalQuery = ''
        ui.pushLocalSourceQuery = ''
        // 本地房间里来源就是当前房间；远端房间里默认取第一个本地房间
        ui.pushLocalSource = gm.roomLocal ? gm.roomName : gm.localRooms[0] ?? ''
        ui.pushLocalRooms = []
        ui.pushLocalLoading = true
        rerender()
      }),
    )
  }

  if (!readonly) {
    menu.append(
      menuItem('导出 PNG', () => {
        ui.moreMenuOpen = false
        exportStateAsPng(store.state)
        rerender()
      }),
    )
  }

  menu.append(
    menuItem(applyTheme() === 'dark' ? '切换为浅色' : '切换为深色', () => {
      toggleTheme()
      ui.moreMenuOpen = false
      rerender()
    }),
  )

  menu.append(
    menuItem('快捷键说明', () => {
      ui.moreMenuOpen = false
      ui.shortcuts = true
      rerender()
    }),
  )

  backdrop.append(menu)
  return backdrop
}

// ---------- 快捷键说明 ----------

const SHORTCUTS: [string, string][] = [
  ['点击钟面', '填充 +1'],
  ['1 / 2 / 3', '给当前钟填充 1~3 格'],
  ['+ / -', '当前钟 +1 / -1（= / _ 同效）'],
  ['0', '当前钟清零'],
  ['← / →（或 ↑ / ↓）', '切换当前钟'],
  ['Enter', '打开当前钟设置'],
  ['Delete', '删除当前钟（可撤销）'],
  ['Ctrl + N', '新建进度钟'],
  ['Ctrl + Z', '撤销'],
  ['Ctrl + Y', '重做（也支持 Ctrl+Shift+Z）'],
  ['Esc', '关闭弹窗'],
  ['?', '显示本说明（Shift + / 同效）'],
  ['长按 / 右键钟面', '打开设置'],
  ['拖动 ⠿ 把手', '调整显示顺序'],
]

function renderShortcutsModal(ui: UiState, rerender: Rerender): HTMLElement {
  const { backdrop, modal, close } = modalShell('快捷键', () => {
    ui.shortcuts = false
    rerender()
  })
  // 说明弹窗没有左右布局：标题与按钮都居中
  modal.classList.add('modal-center')
  for (const [key, desc] of SHORTCUTS) {
    const row = el('div', 'shortcut-row')
    row.append(el('kbd', 'shortcut-key', key), el('span', 'shortcut-desc', desc))
    modal.append(row)
  }
  const actions = el('div', 'modal-actions')
  const done = el('button', 'tbtn primary', '知道了') as HTMLButtonElement
  done.addEventListener('click', close)
  actions.append(done)
  modal.append(actions)
  return backdrop
}

// ---------- 钟交互（点击 +1 / 长按、右键设置） ----------

function bindClockInteractions(
  node: HTMLElement,
  id: string,
  store: Store,
  ui: UiState,
  rerender: Rerender,
): void {
  let timer: number | undefined
  let long = false

  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return
    long = false
    timer = window.setTimeout(() => {
      long = true
      ui.settingsClockId = id
      rerender()
    }, 500)
  })
  node.addEventListener('pointerup', () => window.clearTimeout(timer))
  node.addEventListener('pointercancel', () => window.clearTimeout(timer))
  node.addEventListener('click', () => {
    if (long) {
      long = false
      return
    }
    store.increment(id)
    rerender()
  })
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    ui.settingsClockId = id
    rerender()
  })
}

function preventLongPress(e: Event): void {
  e.stopPropagation()
}

/** 设置齿轮按钮（网格卡片 / 列表行共用） */
function settingsGear(clock: ProgressClock, ui: UiState, rerender: Rerender): HTMLButtonElement {
  const gear = el('button', 'card-settings', '⚙') as HTMLButtonElement
  gear.setAttribute('aria-label', `设置 ${clock.name}`)
  gear.addEventListener('pointerdown', preventLongPress)
  gear.addEventListener('click', (e) => {
    e.stopPropagation()
    ui.settingsClockId = clock.id
    rerender()
  })
  return gear
}

/** 拖动把手：仅非只读模式出现，用来调整显示顺序（顺序存本地，不同步） */
function dragHandle(): HTMLElement {
  const handle = el('div', 'drag-handle', '⠿')
  handle.title = '拖动调整顺序'
  handle.setAttribute('aria-label', '拖动调整顺序')
  return handle
}

// ---------- 卡片网格 ----------

function clockCard(clock: ProgressClock): HTMLElement {
  const card = el('div', 'clock-card')
  card.dataset.clockId = clock.id
  card.insertAdjacentHTML('beforeend', svgClock({ max: clock.max, fill: clock.fill, color: clock.color ?? '#888888' }))
  card.append(el('div', 'clock-count', `${clock.fill}/${clock.max}`))
  card.append(el('div', 'clock-name', clock.name || '未命名'))
  return card
}

function renderGrid(
  store: Store,
  ui: UiState,
  readonly: boolean,
  rerender: Rerender,
): HTMLElement {
  const grid = el('div', 'clocks-grid')
  const onReorder = (id: string, toIndex: number) => {
    store.reorderClock(id, toIndex)
    rerender()
  }
  for (const clock of store.visibleClocks) {
    const card = clockCard(clock)
    if (clock.id === store.currentClockId) card.classList.add('current')
    if (!readonly) {
      const handle = dragHandle()
      card.append(handle)
      bindDragHandle(handle, card, clock.id, { container: grid, onReorder })
      card.append(settingsGear(clock, ui, rerender))
      bindClockInteractions(card, clock.id, store, ui, rerender)
    }
    grid.append(card)
  }
  return grid
}

// ---------- 紧凑列表 ----------

function renderList(
  store: Store,
  ui: UiState,
  readonly: boolean,
  rerender: Rerender,
): HTMLElement {
  const list = el('div', 'clock-list')
  const onReorder = (id: string, toIndex: number) => {
    store.reorderClock(id, toIndex)
    rerender()
  }
  for (const clock of store.visibleClocks) {
    const row = el('div', 'clock-row')
    row.dataset.clockId = clock.id
    if (clock.id === store.currentClockId) row.classList.add('current')

    if (!readonly) {
      const handle = dragHandle()
      row.append(handle)
      bindDragHandle(handle, row, clock.id, { container: list, onReorder })

      const minus = el('button', 'row-btn', '−') as HTMLButtonElement
      minus.setAttribute('aria-label', `减少 ${clock.name}`)
      minus.addEventListener('pointerdown', preventLongPress)
      minus.addEventListener('click', (e) => {
        e.stopPropagation()
        store.increment(clock.id, -1)
        rerender()
      })
      row.append(minus)
    }

    row.append(el('span', 'row-count', `${clock.fill}/${clock.max}`))
    row.append(el('span', 'row-name', clock.name || '未命名'))

    if (!readonly) {
      const plus = el('button', 'row-btn plus', '+') as HTMLButtonElement
      plus.setAttribute('aria-label', `增加 ${clock.name}`)
      plus.addEventListener('pointerdown', preventLongPress)
      plus.addEventListener('click', (e) => {
        e.stopPropagation()
        store.increment(clock.id)
        rerender()
      })
      row.append(plus)
      row.append(settingsGear(clock, ui, rerender))
      bindClockInteractions(row, clock.id, store, ui, rerender)
    }
    list.append(row)
  }
  return list
}

// ---------- 格数快速选择（4/6/8 + 自定义） ----------

const QUICK_MAX = [4, 6, 8]

/**
 * 格数选择器：4/6/8 快速按钮 + 数字输入联动。
 * 返回 (onChange: (max: number) => void) 的挂载函数
 */
function mountMaxPicker(
  container: HTMLElement,
  initial: number,
  onChange: (max: number) => void,
): void {
  const btnRow = el('div', 'quick-max')
  const buttons = new Map<number, HTMLButtonElement>()
  for (const n of QUICK_MAX) {
    const btn = el('button', 'qmax-btn', String(n)) as HTMLButtonElement
    if (n === initial) btn.classList.add('selected')
    btn.addEventListener('click', () => {
      for (const b of buttons.values()) b.classList.remove('selected')
      btn.classList.add('selected')
      numInput.value = String(n)
      onChange(n)
    })
    buttons.set(n, btn)
    btnRow.append(btn)
  }
  const numInput = makeInput('number', '', String(initial))
  numInput.min = String(CLOCK_MIN_SEGMENTS)
  numInput.max = String(CLOCK_MAX_SEGMENTS)
  numInput.addEventListener('change', () => {
    // 手输可能越界（如 0 或 99）：先钳回契约区间并回写输入框，避免「显示 1 实际 2」
    const next = clampInt(Number(numInput.value), CLOCK_MIN_SEGMENTS, CLOCK_MAX_SEGMENTS)
    numInput.value = String(next)
    for (const b of buttons.values()) b.classList.remove('selected')
    if ((QUICK_MAX as number[]).includes(next)) buttons.get(next)?.classList.add('selected')
    onChange(next)
  })
  container.append(btnRow, numInput)
}

// ---------- 新建弹窗 ----------

function renderNewClockModal(
  store: Store,
  ui: UiState,
  rerender: Rerender,
): HTMLElement {
  const { backdrop, modal, close } = modalShell('新建进度钟', () => {
    ui.creating = false
    rerender()
  })

  const nameInput = makeInput('text', '钟名（如：内部巡逻）')
  nameInput.maxLength = 40
  modal.append(el('label', 'field', '名字'))
  modal.append(nameInput)

  modal.append(el('label', 'field', '格数'))
  const maxContainer = el('div', 'max-picker')
  modal.append(maxContainer)
  let chosenMax = 4
  mountMaxPicker(maxContainer, 4, (max) => {
    chosenMax = max
  })

  const actions = el('div', 'modal-actions')
  const cancelBtn = el('button', 'tbtn', '取消')
  cancelBtn.addEventListener('click', () => {
    close()
  })
  const confirmBtn = el('button', 'tbtn primary', '创建')
  confirmBtn.addEventListener('click', () => {
    store.createClock(nameInput.value.trim() || '新钟', chosenMax)
    close()
  })
  actions.append(cancelBtn, confirmBtn)
  modal.append(actions)

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmBtn.click()
    if (e.key === 'Escape') cancelBtn.click()
  })
  nameInput.focus()

  return backdrop
}

// ---------- 设置面板 ----------

function renderSettings(
  clock: ProgressClock,
  store: Store,
  ui: UiState,
  rerender: Rerender,
): HTMLElement {
  const { backdrop, modal, close } = modalShell('钟设置', () => {
    ui.settingsClockId = null
    rerender()
  })

  // 名字
  const nameInput = makeInput('text', '', clock.name)
  nameInput.maxLength = 40
  nameInput.addEventListener('change', () => {
    store.updateClock(clock.id, { name: nameInput.value.trim() })
    rerender()
  })
  modal.append(el('label', 'field', '名字'))
  modal.append(nameInput)

  // 格数：4/6/8 快速 + 自定义
  modal.append(el('label', 'field', '格数'))
  const maxContainer = el('div', 'max-picker')
  modal.append(maxContainer)
  mountMaxPicker(maxContainer, clock.max, (max) => {
    store.updateClock(clock.id, { max })
    rerender()
  })

  // 填充：滑条 + 手输数字。滑条快，但要精确值、或格数很大不便拖时手输更直接
  modal.append(el('label', 'field', '填充'))
  const fillRange = document.createElement('input')
  fillRange.type = 'range'
  fillRange.min = '0'
  fillRange.max = String(clock.max)
  fillRange.value = String(clock.fill)
  const fillInput = makeInput('number', '', String(clock.fill))
  fillInput.className = 'text-input fill-input'
  fillInput.min = '0'
  fillInput.max = String(clock.max)
  const fillLabel = el('span', 'fill-value', `${clock.fill}/${clock.max}`)
  const fillRow = el('div', 'fill-row')
  fillRow.append(fillRange, fillInput, fillLabel)
  fillRange.addEventListener('input', () => {
    // 拖动过程只更新显示，不写 store——否则每一帧都会压一次撤销栈
    fillLabel.textContent = `${fillRange.value}/${clock.max}`
    fillInput.value = fillRange.value
  })
  const commitFill = (raw: string): void => {
    const next = clampInt(Number(raw), 0, clock.max)
    fillRange.value = String(next)
    fillInput.value = String(next)
    fillLabel.textContent = `${next}/${clock.max}`
    store.updateClock(clock.id, { fill: next })
    rerender()
  }
  fillRange.addEventListener('change', () => commitFill(fillRange.value))
  fillInput.addEventListener('change', () => commitFill(fillInput.value))
  modal.append(fillRow)

  // 颜色
  modal.append(el('label', 'field', '颜色'))
  const colorRow = el('div', 'color-row')
  for (const color of PALETTE) {
    const swatch = el('button', 'color-swatch') as HTMLButtonElement
    swatch.style.background = color
    if (color === clock.color) swatch.classList.add('selected')
    swatch.addEventListener('click', () => {
      store.updateClock(clock.id, { color })
      rerender()
    })
    colorRow.append(swatch)
  }
  modal.append(colorRow)

  // 自定义颜色：取色器 + 手输 hex。色板只有 8 色，跑团里想区分「同一危险的不同来源」时不够用
  const colorCustom = el('div', 'color-custom')
  const picker = makeInput('color', '', normalizeHexColor(clock.color) ?? '#888888')
  picker.className = 'color-picker'
  const hexInput = makeInput('text', '#e53935', clock.color ?? '')
  hexInput.className = 'text-input hex-input'
  const hexHint = el('div', 'hex-hint', '')
  colorCustom.append(picker, hexInput)
  modal.append(colorCustom, hexHint)

  const commitColor = (raw: string): void => {
    const next = normalizeHexColor(raw)
    if (!next) return
    store.updateClock(clock.id, { color: next })
    rerender()
  }
  // 取色器：拖动过程只联动文本框，松手（change）才落库，避免每帧压一次撤销栈
  picker.addEventListener('input', () => {
    hexInput.value = picker.value
    hexHint.textContent = ''
  })
  picker.addEventListener('change', () => commitColor(picker.value))
  // 手输：input 只做格式提示，change（回车/失焦）才落库，非法则还原
  hexInput.addEventListener('input', () => {
    const next = normalizeHexColor(hexInput.value)
    hexHint.textContent = hexInput.value.trim() && !next ? '格式应为 #RGB 或 #RRGGBB' : ''
    if (next) picker.value = next
  })
  hexInput.addEventListener('change', () => {
    const next = normalizeHexColor(hexInput.value)
    if (next) {
      commitColor(next)
    } else {
      hexHint.textContent = '格式应为 #RGB 或 #RRGGBB'
      hexInput.value = clock.color ?? ''
    }
  })

  // 操作
  const actions = el('div', 'modal-actions')
  const deleteBtn = el('button', 'tbtn danger', '删除') as HTMLButtonElement
  deleteBtn.addEventListener('click', () => {
    store.deleteClock(clock.id)
    close()
  })
  const doneBtn = el('button', 'tbtn primary', '完成') as HTMLButtonElement
  doneBtn.addEventListener('click', () => {
    close()
  })
  actions.append(deleteBtn, doneBtn)
  modal.append(actions)

  return backdrop
}

// ---------- GM 登录弹窗 ----------

function renderGmLoginModal(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const { backdrop, modal, close } = modalShell('连接与登录', () => {
    ui.gmDialog = false
    ui.gmError = ''
    rerender()
  })

  const hint = el('div', 'gm-hint', ui.gmError)

  // 服务器连接（分离模式）：Web 可指向任意后端；留空 = 同源托管
  const serverInput = makeInput(
    'text',
    '服务器地址（留空 = 同源，如 http://192.168.1.10:2333）',
    gm.serverBase,
  )
  const credLabel = gm.roomName ? 'GM 密码（写权限）' : 'GM 密钥'
  const keyInput = makeInput(
    'password',
    // 已登录时留空 = 保留当前凭证，只换服务器；重新填 = 换凭证
    gm.authed ? `${credLabel}，留空 = 保持当前登录` : credLabel,
  )

  const actions = el('div', 'modal-actions')
  const connectBtn = el('button', 'tbtn primary', '连接') as HTMLButtonElement

  // 提交是异步的：await 之后手上这些节点可能已经被别的 rerender 换掉了，
  // 所以结果一律写回 ui.gmError 再整体重渲染，不直接碰 DOM
  let busy = false
  const submit = async (): Promise<void> => {
    if (busy) return
    const base = serverInput.value.trim()
    const key = keyInput.value.trim()
    // 什么都没改：当作关闭
    if (base === gm.serverBase && !key) {
      close()
      return
    }
    busy = true
    connectBtn.disabled = true
    hint.textContent = '连接中…'
    const result = await gm.onConnect(base, key)
    busy = false

    if (result.ok) {
      close()
      return
    }
    ui.gmError = result.cancelled ? '已取消，保持当前服务器' : result.error ?? '连接失败，请重试'
    rerender()
  }
  connectBtn.addEventListener('click', () => void submit())
  for (const input of [serverInput, keyInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
    })
  }

  if (gm.authed) {
    const logout = el('button', 'tbtn danger', '清除登录')
    logout.addEventListener('click', () => {
      gm.onLogout()
      close()
    })
    actions.append(logout)
  }
  actions.append(connectBtn)

  modal.append(hint, serverInput, keyInput, actions)
  // 焦点落在第一个还空着的框上：分离模式先填服务器，已配好时直接输密钥
  ;(serverInput.value ? keyInput : serverInput).focus()
  return backdrop
}

// ---------- 房间连接弹窗（GitHub 模型：加入 = pull，新建 = 建仓 + push） ----------

function renderRoomModal(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const { backdrop, modal, close } = modalShell('连接房间', () => {
    ui.roomDialog = false
    ui.roomPrefill = ''
    ui.roomError = ''
    rerender()
  })

  const hint = el('div', 'gm-hint', ui.roomError)

  // 服务器地址不再在这里填——它只归「连接与登录」管，这里只告知当前连的是哪台，
  // 免得同一个配置有两个入口，改了这边忘了那边
  const serverNote = el(
    'div',
    'field',
    `服务器：${gm.serverBase || '同源（当前站点）'}（改服务器：顶栏 ⋯ →「${CONNECT_MENU_LABEL}」）`,
  )

  // 三个框的值都优先取草稿：报错后整体重渲染时，用户填的东西不能被冲掉
  const draft = ui.roomDraft
  const roomInput = makeInput('text', '房间名', draft.name || ui.roomPrefill || gm.roomName)
  const pwdInput = makeInput(
    'password',
    '加入密码（可留空 = 公开房间，发给玩家）',
    draft.joinPwd || gm.roomJoinPwd,
  )
  const gmInput = makeInput(
    'password',
    'GM 密码（留空 = 只读玩家；新建时必填 ≥6 位）',
    draft.gmPwd,
  )
  // 输入只写状态、不触发重渲染，否则每敲一个字都会重建输入框、焦点就没了
  roomInput.addEventListener('input', () => {
    ui.roomDraft.name = roomInput.value
  })
  pwdInput.addEventListener('input', () => {
    ui.roomDraft.joinPwd = pwdInput.value
  })
  gmInput.addEventListener('input', () => {
    ui.roomDraft.gmPwd = gmInput.value
  })

  const actions = el('div', 'modal-actions')
  const joinBtn = el('button', 'tbtn primary', '加入房间')
  const createBtn = el('button', 'tbtn', '新建房间')

  // 同 GM 弹窗：提交是异步的，await 之后手上的节点可能已经失效，
  // 所以结果写回 ui.roomError 再整体重渲染。（连接中… 这段是同步的，直接写节点即可）
  let busy = false
  const submit = async (create: boolean) => {
    if (busy) return
    const room = roomInput.value.trim()
    const joinPwd = pwdInput.value.trim()
    const gmPwd = gmInput.value.trim()
    if (!room) {
      ui.roomError = '请填写房间名'
      rerender()
      return
    }
    if (create && gmPwd.length < 6) {
      ui.roomError = 'GM 密码至少 6 位'
      rerender()
      return
    }
    busy = true
    hint.textContent = create ? '创建中…' : '连接中…'
    const result = create
      ? await gm.onCreateRoom(room, joinPwd, gmPwd)
      : await gm.onJoinRoom(room, joinPwd, gmPwd)
    busy = false
    if (result.ok) {
      close()
      return
    }
    ui.roomError = result.error
    rerender()
  }
  joinBtn.addEventListener('click', () => void submit(false))
  createBtn.addEventListener('click', () => void submit(true))
  for (const input of [roomInput, pwdInput, gmInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit(false)
    })
  }
  actions.append(createBtn, joinBtn)

  modal.append(hint, serverNote, roomInput, pwdInput, gmInput, actions)
  roomInput.focus()
  return backdrop
}

// ---------- 房间管理弹窗（已连接：保存更改=改密码 / 删除房间 / 退出） ----------

function renderManageRoomModal(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const { backdrop, modal, close } = modalShell('房间管理', () => {
    ui.manageRoomDialog = false
    ui.manageError = ''
    ui.changePwdOpen = false
    ui.changePwdDraft = { joinPwd: '', gmPwd: '' }
    rerender()
  })

  const hint = el('div', 'gm-hint', ui.manageError)
  modal.append(
    hint,
    el('div', 'field', `房间：${gm.roomName}${gm.serverBase ? `（${gm.serverBase.replace(/^https?:\/\//, '')}）` : ''}`),
  )

  const actions = el('div', 'modal-actions')

  if (gm.roomLocal) {
    // 本地房间：没有密码可改，只有删除本地 + 退出
    const delLocal = el('button', 'tbtn danger', '删除本地房间')
    delLocal.title = '本机数据，不可恢复'
    delLocal.addEventListener('click', () => {
      if (!confirm(`删除本地房间「${gm.roomName}」？所有进度钟将丢失。`)) return
      const result = gm.onDeleteLocalRoom(gm.roomName)
      if (result.ok) close()
      else {
        ui.manageError = result.error
        rerender()
      }
    })
    actions.append(delLocal)
  } else if (gm.authed) {
    // 远端房间 + 已登录：保存更改（改密码）+ 删除房间
    const saveBtn = el('button', 'tbtn', '保存更改')
    saveBtn.title = '修改加入密码 / GM 密码'
    saveBtn.addEventListener('click', () => {
      ui.changePwdOpen = !ui.changePwdOpen
      ui.manageError = ''
      rerender()
    })
    actions.append(saveBtn)

    const delBtn = el('button', 'tbtn danger', '删除房间')
    delBtn.title = '删除后所有进度钟将丢失，无法恢复'
    delBtn.addEventListener('click', async () => {
      if (!confirm(`删除房间「${gm.roomName}」？此操作不可恢复，所有进度钟将丢失。`)) return
      const result = await gm.onDeleteRoom(gm.roomName)
      if (result.ok) close()
      else {
        ui.manageError = result.error
        rerender()
      }
    })
    actions.append(delBtn)
  }

  // 退出：所有已连接状态都有（退出 = 回到本地空白工作区）
  const leaveBtn = el('button', 'tbtn', '退出房间')
  leaveBtn.title = '回到本地空白工作区；远端房间保留在服务器上'
  leaveBtn.addEventListener('click', async () => {
    const result = await gm.onLeaveRoom()
    if (result.ok) close()
    else {
      ui.manageError = result.error
      rerender()
    }
  })
  actions.append(leaveBtn)
  modal.append(actions)

  // 「保存更改」展开的改密码表单（只对远端房间 + GM）
  if (!gm.roomLocal && ui.changePwdOpen && gm.authed) {
    const pwdSection = el('div', 'change-pwd')
    pwdSection.append(el('label', 'field', '修改密码（留空 = 不改）'))
    const joinInput = makeInput('password', '新加入密码（留空 = 不修改）', ui.changePwdDraft.joinPwd)
    const gmInput = makeInput('password', '新 GM 密码（留空 = 不修改，≥6 位）', ui.changePwdDraft.gmPwd)
    joinInput.addEventListener('input', () => {
      ui.changePwdDraft.joinPwd = joinInput.value
    })
    gmInput.addEventListener('input', () => {
      ui.changePwdDraft.gmPwd = gmInput.value
    })
    pwdSection.append(joinInput, gmInput)
    const savePwd = el('button', 'tbtn primary', '保存') as HTMLButtonElement
    const submitPwd = async () => {
      const result = await gm.onChangePwd(ui.changePwdDraft.joinPwd.trim(), ui.changePwdDraft.gmPwd.trim())
      if (result.ok) {
        ui.changePwdOpen = false
        ui.changePwdDraft = { joinPwd: '', gmPwd: '' }
        rerender()
      } else {
        ui.manageError = result.error
        rerender()
      }
    }
    savePwd.addEventListener('click', () => void submitPwd())
    for (const input of [joinInput, gmInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void submitPwd()
      })
    }
    pwdSection.append(savePwd)
    modal.append(pwdSection)
    joinInput.focus()
  }

  return backdrop
}

// ---------- 新建本地房间弹窗（名字即可，本地房间永不联网） ----------

function renderLocalRoomModal(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const { backdrop, modal, close } = modalShell('新建本地房间', () => {
    ui.localRoomDialog = false
    ui.localRoomError = ''
    ui.localRoomDraft = ''
    rerender()
  })

  const hint = el('div', 'gm-hint', ui.localRoomError)
  const nameInput = makeInput('text', '房间名（如：草稿）', ui.localRoomDraft)
  nameInput.maxLength = 40
  nameInput.addEventListener('input', () => {
    ui.localRoomDraft = nameInput.value
  })

  const actions = el('div', 'modal-actions')
  const cancelBtn = el('button', 'tbtn', '取消')
  cancelBtn.addEventListener('click', close)
  const createBtn = el('button', 'tbtn primary', '创建') as HTMLButtonElement
  createBtn.addEventListener('click', () => {
    const result = gm.onCreateLocalRoom(nameInput.value)
    if (result.ok) close()
    else {
      ui.localRoomError = result.error
      rerender()
    }
  })
  actions.append(cancelBtn, createBtn)

  modal.append(hint, el('label', 'field', '名字'), nameInput, actions)
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createBtn.click()
    if (e.key === 'Escape') cancelBtn.click()
  })
  nameInput.focus()
  return backdrop
}

// ---------- 内嵌房间选择器（搜索栏 + 内嵌 box） ----------

/**
 * 与侧边栏同款的选择器：上方搜索栏，下方一个内嵌 box 列房间。
 *
 * 两个要点：
 * - **过滤在前端**，不打服务器；输入走 `paint()` 局部重画，不整屏 rerender——
 *   否则输入框失焦，没法连续敲字。搜索词由调用方存进 UiState，重渲染时不丢。
 * - **box 高度随结果压缩**：不是固定高度的滚动区，条目少了容器就跟着矮下去，
 *   只有多到超过 CSS 的 `max-height` 才滚动。空列表时也不要留一块空白。
 */
function roomPicker(cfg: {
  placeholder: string
  /** 一个房间都没有时的提示 */
  emptyHint: string
  /** 有房间但没匹配上时的提示 */
  noMatchHint: string
  rooms: string[]
  loading?: boolean
  /** 初始搜索词（来自 UiState；之后的输入由本组件自己持有） */
  query: string
  onQuery: (q: string) => void
  isPicked: (room: string) => boolean
  onPick: (room: string) => void
  itemTitle?: (room: string) => string
}): HTMLElement {
  const wrap = el('div', 'room-picker')
  const search = makeInput('text', cfg.placeholder, cfg.query)
  search.className = 'text-input sidebar-search'
  const box = el('div', 'room-picker-box')

  // 输入后由本组件持有搜索词：读 cfg.query 拿到的是构造时的旧值
  let query = cfg.query

  const paint = (): void => {
    box.textContent = ''
    if (cfg.loading) {
      box.append(el('div', 'room-picker-empty', '加载中…'))
      return
    }
    const q = query.trim().toLowerCase()
    const matched = cfg.rooms.filter((r) => r.toLowerCase().includes(q))
    if (matched.length === 0) {
      box.append(
        el('div', 'room-picker-empty', cfg.rooms.length === 0 ? cfg.emptyHint : cfg.noMatchHint),
      )
      return
    }
    // 上限只是防极端情况（几千个房间画到卡），正常列表远不到
    for (const room of matched.slice(0, 30)) {
      const item = el(
        'button',
        `room-picker-item${cfg.isPicked(room) ? ' picked' : ''}`,
        room,
      ) as HTMLButtonElement
      item.title = cfg.itemTitle ? cfg.itemTitle(room) : room
      item.addEventListener('click', () => cfg.onPick(room))
      box.append(item)
    }
  }

  search.addEventListener('input', () => {
    query = search.value
    cfg.onQuery(query)
    paint()
  })
  paint()
  wrap.append(search, box)
  return wrap
}

// ---------- 提交本地房间弹窗（本地 → 远端 force push） ----------

function renderPushLocalModal(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const { backdrop, modal, close } = modalShell('提交本地房间', () => {
    ui.pushLocalDialog = false
    ui.pushLocalError = ''
    rerender()
  })

  const hint = el('div', 'gm-hint', ui.pushLocalError)

  // 来源：本地房间（要提交的那一份）。默认当前房间，可在下面的选择器里换
  const source = ui.pushLocalSource || gm.roomName
  /** 提交中：拦住点选即上传的重复点击（失败后可再来一次） */
  let submitting = false
  // 来源有远端记录（另存为本地 / 之前提交过）且指向当前服务器：列表里高亮它，点一下即一键回推
  const origin = gm.getLocalOrigin(source)
  const sameOrigin = origin && origin.server === gm.serverBase

  modal.append(hint)

  // 来源：本地房间。侧边栏同款选择器——搜索过滤 + 内嵌 box 随结果压缩。
  // 本地房间里也照样给：默认选中当前房间，但要提交另一份本地草稿时不必先退出去切房间
  modal.append(
    el('div', 'field', '要提交的本地房间'),
    roomPicker({
      placeholder: '搜索本地房间…',
      emptyHint: '还没有本地房间——先进本地房间做草稿，或到本地房间的「更多」里新建',
      noMatchHint: '没有匹配的本地房间',
      rooms: gm.localRooms,
      query: ui.pushLocalSourceQuery,
      onQuery: (q) => {
        ui.pushLocalSourceQuery = q
      },
      isPicked: (room) => room === source,
      onPick: (room) => {
        ui.pushLocalSource = room
        rerender()
      },
      itemTitle: (room) => (room === source ? `当前来源：${room}` : `点选为提交来源：${room}`),
    }),
  )

  modal.append(
    el(
      'div',
      'field',
      `目标服务器：${gm.serverBase || '同源（当前站点）'}（改服务器：顶栏 ⋯ →「${CONNECT_MENU_LABEL}」）`,
    ),
  )

  // 远端目标：同一套选择器，点一个房间 = 立即上传（整体覆盖该远端房间）
  const targetPicker = roomPicker({
    placeholder: '搜索远端房间，点击即提交…',
    emptyHint: '暂无已有房间（可在下方输入新名字创建）',
    noMatchHint: '没有匹配的房间',
    rooms: ui.pushLocalRooms,
    loading: ui.pushLocalLoading,
    query: ui.pushLocalQuery,
    onQuery: (q) => {
      ui.pushLocalQuery = q
    },
    isPicked: (room) => !!sameOrigin && room === origin!.room,
    onPick: (room) => {
      // 点选即上传：拦住重复点击，否则一次网络往返里能连发好几个提交
      if (submitting) return
      submitting = true
      hint.textContent = '提交中…'
      void gm.onPushLocalRoom(source, room).then((result) => {
        if (result.ok) close()
        else {
          submitting = false
          ui.pushLocalError = result.error
          rerender()
        }
      })
    },
    itemTitle: () => '提交本地房间并整体覆盖该远端房间',
  })
  modal.append(el('div', 'field', `目标远端房间（点选即提交「${source}」）`), targetPicker)

  if (sameOrigin) {
    modal.append(el('div', 'gm-hint', `该本地房间来自远端「${origin!.room}」，点列表中它即可一键回推`))
  }

  // 或推到一个新名字：创建新的远端房间。新房间没有既有凭证，唯一要填的就是它的 GM 密码；
  // 加入密码免了（新房间默认公开，玩家免密即可看）
  const newRow = el('div', 'push-new-row')
  const newName = makeInput('text', '或输入新房间名…', '')
  newName.maxLength = 40
  const newPwd = makeInput('password', '新房间 GM 密码（≥6 位）', '')
  const newBtn = el('button', 'tbtn', '创建并提交') as HTMLButtonElement
  newBtn.addEventListener('click', () => {
    const target = newName.value.trim()
    const pwd = newPwd.value.trim()
    if (!target) return
    if (pwd.length < 6) {
      ui.pushLocalError = '新房间 GM 密码至少 6 位'
      rerender()
      return
    }
    newBtn.disabled = true
    hint.textContent = '提交中…'
    void gm.onPushLocalRoom(source, target, pwd).then((result) => {
      if (result.ok) close()
      else {
        ui.pushLocalError = result.error
        rerender()
      }
    })
  })
  newRow.append(newName, newPwd, newBtn)
  modal.append(el('div', 'field', '或推到一个新名字'), newRow)

  const actions = el('div', 'modal-actions')
  const cancelBtn = el('button', 'tbtn', '取消')
  cancelBtn.addEventListener('click', close)
  actions.append(cancelBtn)
  modal.append(actions)

  // 异步拉远端房间列表（打开时已置 loading；拉完回填并重渲染）
  if (ui.pushLocalLoading) {
    void gm.onListRooms().then((rooms) => {
      ui.pushLocalRooms = rooms
      ui.pushLocalLoading = false
      rerender()
    })
  }
  // 光标落在远端目标上：那才是这次要完成的动作，本地来源通常已经是当前房间
  targetPicker.querySelector('input')?.focus()
  return backdrop
}

// ---------- 房间侧边栏（搜索 + 远程房间 + 本地房间，各自可折叠） ----------

function renderRoomSidebar(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const aside = el('aside', 'room-sidebar')
  // 手机端是全屏覆盖抽屉：右上角放「✕」关闭（桌面端常驻，此按钮隐藏）
  const closeBtn = el('button', 'sidebar-close', '✕')
  closeBtn.title = '关闭房间列表'
  closeBtn.setAttribute('aria-label', '关闭房间列表')
  closeBtn.addEventListener('click', () => {
    ui.sidebarOpen = false
    rerender()
  })
  aside.append(closeBtn)

  // 搜索框：纯前端过滤，不打服务器。输入时不走 rerender——否则输入框会失焦
  const search = makeInput('text', '搜索房间…', ui.sidebarQuery)
  search.className = 'text-input sidebar-search'
  search.addEventListener('input', () => {
    ui.sidebarQuery = search.value
    paint()
  })
  aside.append(search)

  const body = el('div', 'sidebar-body')
  aside.append(body)

  const matches = (name: string): boolean => {
    const q = ui.sidebarQuery.trim().toLowerCase()
    return q === '' || name.toLowerCase().includes(q)
  }

  /** 清空并重绘两组列表。搜索词变化、折叠切换、刷新后都走这里 */
  function paint(): void {
    body.textContent = ''

    // ---- 远程房间：服务器全量列表；已取得凭证的挂「可编辑 / 可访问」标签 ----
    const remoteHeader = sidebarGroupHeader('远程房间', ui.sidebarRemoteOpen, () => {
      ui.sidebarRemoteOpen = !ui.sidebarRemoteOpen
      paint()
    })
    const remoteAdd = el('button', 'sidebar-add', '+')
    remoteAdd.title = '新建 / 加入远程房间'
    remoteAdd.setAttribute('aria-label', '新建远程房间')
    remoteAdd.addEventListener('click', (e) => {
      e.stopPropagation()
      openRoomDialog(ui)
      rerender()
    })
    // 刷新换成旋转箭头小图标（一眼可辨的刷新语义），放在新建左边，跟本地组一致：新建在最后
    const refresh = el('button', 'sidebar-refresh')
    refresh.title = '重新拉取房间列表'
    refresh.setAttribute('aria-label', '重新拉取房间列表')
    refresh.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>'
    refresh.addEventListener('click', () => {
      ui.sidebarRemoteOpen = true
      paint()
    })
    remoteHeader.append(refresh, remoteAdd)
    body.append(remoteHeader)

    if (ui.sidebarRemoteOpen) {
      const remoteList = el('ul', 'room-sidebar-list')
      remoteList.append(el('li', 'room-sidebar-empty', '加载中…'))
      body.append(remoteList)
      void (async () => {
        let rooms: string[] = []
        let failed = false
        try {
          rooms = await gm.onListRooms()
        } catch {
          failed = true
        }
        // 期间可能又重绘过（搜索词变了 / 折叠了），这个节点已被丢弃就别画了
        if (!remoteList.isConnected) return
        remoteList.textContent = ''
        if (failed) {
          remoteList.append(
            el(
              'li',
              'room-sidebar-empty',
              gm.serverBase ? '无法连接服务器' : '未配置服务器（顶栏 ⋯ →「连接与登录」）',
            ),
          )
          return
        }
        const filtered = rooms.filter(matches)
        if (filtered.length === 0) {
          remoteList.append(
            el('li', 'room-sidebar-empty', rooms.length === 0 ? '暂无远程房间' : '没有匹配的房间'),
          )
          return
        }
        for (const room of filtered) {
          remoteList.append(remoteRoomItem(room, ui, gm, rerender))
        }
      })()
    }

    // ---- 本地房间：本机草稿，点一下直接进，不联网 ----
    const localHeader = sidebarGroupHeader('本地房间', ui.sidebarLocalOpen, () => {
      ui.sidebarLocalOpen = !ui.sidebarLocalOpen
      paint()
    })
    const localAdd = el('button', 'sidebar-add', '+')
    localAdd.title = '新建本地房间（草稿工作区）'
    localAdd.setAttribute('aria-label', '新建本地房间')
    localAdd.addEventListener('click', (e) => {
      e.stopPropagation()
      ui.localRoomDialog = true
      ui.localRoomError = ''
      ui.localRoomDraft = ''
      rerender()
    })
    localHeader.append(localAdd)
    body.append(localHeader)

    if (ui.sidebarLocalOpen) {
      const localList = el('ul', 'room-sidebar-list')
      const locals = gm.localRooms.filter(matches)
      if (locals.length === 0) {
        localList.append(el('li', 'room-sidebar-empty', '暂无本地房间'))
      } else {
        for (const name of locals) {
          localList.append(localRoomItem(name, gm, rerender))
        }
      }
      body.append(localList)
    }
  }

  paint()
  return aside
}

/** 侧边栏折叠分组头：标题 + 折叠箭头，点整行展开/收起 */
function sidebarGroupHeader(
  label: string,
  open: boolean,
  onToggle: () => void,
): HTMLElement {
  const header = el('div', `sidebar-group-header${open ? '' : ' collapsed'}`)
  const title = el('span', 'sidebar-group-title')
  title.append(el('span', 'sidebar-caret', open ? '▼' : '▶'), el('span', 'sidebar-group-label', label))
  header.append(title)
  header.addEventListener('click', onToggle)
  return header
}

/** 远程房间一行：已取得凭证的挂标签直接切（可编辑 > 可访问），否则弹窗填密码加入 */
function remoteRoomItem(
  room: string,
  ui: UiState,
  gm: GmContext,
  rerender: Rerender,
): HTMLElement {
  const known = gm.knownRooms.find((r) => r.room === room && r.server === gm.serverBase)
  const active = !gm.roomLocal && room === gm.roomName
  const li = el('li', 'room-sidebar-item remote')
  if (active) li.classList.add('active')
  li.append(el('span', 'room-name', room))

  if (known) {
    // 有 GM 密码 = 可编辑；只有加入密码 = 可访问。按缓存显示，切换时才真正复验
    const tag = el('span', 'room-tag', known.gmPwd ? '可编辑' : '可访问')
    tag.title = known.gmPwd ? '本机存有 GM 密码，可直接编辑' : '本机存有加入密码，可只读访问'
    li.append(tag)
    li.title = active ? '当前房间' : `切换到「${room}」`
    li.addEventListener('click', () => {
      if (active) return
      void gm.onSwitchRoom(known).then((result) => {
        if (result.ok) rerender()
      })
    })
  } else {
    li.title = '点击加入（需输入密码）'
    li.addEventListener('click', () => {
      openRoomDialog(ui, room)
      rerender()
    })
  }
  return li
}

/** 本地房间一行：点整行进入，✕ 删除（本机数据） */
function localRoomItem(name: string, gm: GmContext, rerender: Rerender): HTMLElement {
  const active = gm.roomLocal && name === gm.roomName
  const li = el('li', 'room-sidebar-item local')
  if (active) li.classList.add('active')
  li.append(el('span', 'room-name', name))
  li.title = active ? '当前房间' : `进入本地房间「${name}」`

  const del = el('button', 'room-forget', '✕') as HTMLButtonElement
  del.title = '删除本地房间（本机数据，不可恢复）'
  del.setAttribute('aria-label', `删除本地房间 ${name}`)
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!confirm(`删除本地房间「${name}」？所有进度钟将丢失。`)) return
    const result = gm.onDeleteLocalRoom(name)
    if (result.ok) rerender()
  })
  li.append(del)

  li.addEventListener('click', () => {
    if (active) return
    const result = gm.onEnterLocalRoom(name)
    if (result.ok) rerender()
  })
  return li
}
