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
  /** 当前房间名（'' = 默认房间） */
  roomName: string
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
  /** 退出当前房间回到默认房间（服务器上的房间保留；本地未同步改动会丢，调用方先确认） */
  onLeaveRoom: () => Promise<RoomResult>
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

  // 房间连接入口（所有模式可见：GM 建房间 / 玩家加入）
  const roomBtn = el('button', 'tbtn room-btn', gm.roomName || '连接')
  roomBtn.title = gm.roomName
    ? `房间：${gm.roomName}（点击切换 / 新建）`
    : '连接服务器房间（加入 / 新建）'
  roomBtn.addEventListener('click', () => {
    openRoomDialog(ui)
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

  // 房间内才有的两个动作：退出（服务器上的房间留着）与删除（不可恢复）。
  // 放同一行而不是各占一行——退出不是破坏性操作，不该和删除一样有分量
  const roomActions = el('div', 'modal-actions')
  if (gm.roomName) {
    const leaveBtn = el('button', 'tbtn', '退出房间')
    leaveBtn.title = '回到默认房间；服务器上的房间保留'
    // 确认放在 main 侧：只有那儿知道本地有没有未同步的改动（dirty）。
    // 与加入 / 切换房间同一个口径——没事就别拿弹窗烦人
    leaveBtn.addEventListener('click', async () => {
      const result = await gm.onLeaveRoom()
      if (result.ok) {
        close()
      } else {
        ui.roomError = result.error
        rerender()
      }
    })
    roomActions.append(leaveBtn)
  }
  if (gm.authed && gm.roomName) {
    const delBtn = el('button', 'tbtn danger', '删除当前房间')
    delBtn.title = '删除后所有进度钟将丢失，无法恢复'
    delBtn.addEventListener('click', async () => {
      if (!confirm(`删除房间「${gm.roomName}」？此操作不可恢复，所有进度钟将丢失。`)) return
      const result = await gm.onDeleteRoom(gm.roomName)
      if (result.ok) {
        close()
      } else {
        ui.roomError = result.error
        rerender()
      }
    })
    roomActions.append(delBtn)
  }

  modal.append(hint, serverNote, roomInput, pwdInput, gmInput, actions)
  // 空的行会白留一道 gap，只有真有按钮时才挂上去
  if (roomActions.children.length) modal.append(roomActions)
  roomInput.focus()
  return backdrop
}

// ---------- 房间侧边栏（搜索 + 我的房间 + 全部房间） ----------

function renderRoomSidebar(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const aside = el('aside', 'room-sidebar')

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

  /** 清空并绘制两段列表。搜索词变化、刷新、忘记房间后都走这里 */
  function paint(): void {
    body.textContent = ''

    // ---- 我的房间：本机缓存的，点一下直接切（密码已记住） ----
    const known = gm.knownRooms.filter((r) => matches(r.room))
    if (known.length > 0) {
      body.append(el('div', 'sidebar-section', '我的房间'))
      const ul = el('ul', 'room-sidebar-list')
      for (const entry of known) {
        ul.append(knownRoomItem(entry, gm, paint, rerender))
      }
      body.append(ul)
    }

    // ---- 全部房间：服务器上的，点一下弹窗填密码加入 ----
    const header = el('div', 'sidebar-section-row')
    header.append(el('span', 'sidebar-section', '全部房间'))
    const refresh = el('button', 'sidebar-refresh', '刷新')
    refresh.title = '重新拉取房间列表'
    header.append(refresh)
    body.append(header)

    const allList = el('ul', 'room-sidebar-list')
    const loading = el('li', 'room-sidebar-empty', '加载中…')
    allList.append(loading)
    body.append(allList)

    const loadAll = async () => {
      const rooms = await gm.onListRooms()
      // 期间可能又重绘过（搜索词变了/忘了房间），这个节点已被丢弃就别画了
      if (!allList.isConnected) return
      allList.textContent = ''
      const filtered = rooms.filter(matches)
      if (filtered.length === 0) {
        allList.append(
          el('li', 'room-sidebar-empty', rooms.length === 0 ? '暂无房间' : '没有匹配的房间'),
        )
        return
      }
      for (const room of filtered) {
        const li = el('li', 'room-sidebar-item')
        li.append(el('span', 'room-name', room))
        li.title = '点击加入（需输入密码）'
        li.addEventListener('click', () => {
          openRoomDialog(ui, room)
          rerender()
        })
        allList.append(li)
      }
    }
    refresh.addEventListener('click', () => void loadAll())
    void loadAll()

    if (known.length === 0) {
      // 没有缓存也不代表没有房间，给个说明避免看起来像坏了
      body.append(el('div', 'sidebar-hint', '加入过的房间会记在这里'))
    }
  }

  paint()
  return aside
}

/** 「我的房间」里的一行：点整行切换，✕ 忘记 */
function knownRoomItem(
  entry: KnownRoom,
  gm: GmContext,
  repaint: () => void,
  rerender: Rerender,
): HTMLElement {
  const active = entry.room === gm.roomName && entry.server === gm.serverBase
  const li = el('li', 'room-sidebar-item known')
  if (active) li.classList.add('active')

  const label = el('span', 'room-name', entry.room)
  li.append(label)

  // 分离模式会连不同的服务器，光有房间名分不清，补一个小字标注
  if (entry.server) {
    const host = el('span', 'room-server', entry.server.replace(/^https?:\/\//, ''))
    host.title = entry.server
    li.append(host)
  }

  const forget = el('button', 'room-forget', '✕') as HTMLButtonElement
  forget.title = '忘记这个房间（只清本机缓存，不删服务器上的房间）'
  forget.setAttribute('aria-label', `忘记房间 ${entry.room}`)
  forget.addEventListener('click', (e) => {
    e.stopPropagation()
    gm.onForgetRoom(entry)
    repaint()
  })
  li.append(forget)

  li.title = active ? '当前房间' : `切换到「${entry.room}」`
  li.addEventListener('click', () => {
    if (active) return
    void gm.onSwitchRoom(entry).then((result) => {
      // 失败原因由 main 侧统一 toast，这里只需在成功时收起侧边栏
      if (result.ok) rerender()
    })
  })
  return li
}
