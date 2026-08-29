import type { ProgressClock } from '../../common/types'
import { PALETTE, Store } from './state'
import { svgClock } from './clock-svg'
import { exportStateAsPng } from './export'

export type ViewMode = 'grid' | 'list'

export interface UiState {
  view: ViewMode
  settingsClockId: string | null
  /** 新建弹窗开关 */
  creating: boolean
  /** GM 登录弹窗开关 */
  gmDialog: boolean
  /** 房间连接弹窗开关 */
  roomDialog: boolean
  /** 侧边栏点击预填的房间名 */
  roomPrefill: string
  /** 侧边栏展开开关（汉堡菜单） */
  sidebarOpen: boolean
}

export type Rerender = () => void

/** 房间操作结果 */
export type RoomResult = { ok: true } | { ok: false; error: string }

/** GM 鉴权上下文（由 main.ts 提供，ui.ts 只负责展示与收集输入） */
export interface GmContext {
  /** URL 是否强制只读（?readonly 玩家模式：连登录入口都隐藏） */
  urlReadonly: boolean
  /** 当前是否已通过密钥验证 */
  authed: boolean
  /** 提交密钥验证（main 侧校验并持久化），返回是否成功 */
  onSubmitKey: (key: string) => Promise<boolean>
  /** 清除登录态 */
  onLogout: () => void
  /** 当前生效的服务器地址（'' = 同源） */
  serverBase: string
  /** 保存并切换服务器（main 侧连接新 server、重拉状态、重新验证密钥） */
  onServerChange: (base: string) => Promise<boolean>
  /** 当前房间名（'' = 默认房间） */
  roomName: string
  /** 当前加入密码（'' = 公开房间） */
  roomJoinPwd: string
  /** 加入房间（main 侧 pull 到本地；gmPwd 可空 = 只读玩家） */
  onJoinRoom: (server: string, room: string, joinPwd: string, gmPwd: string) => Promise<RoomResult>
  /** 新建房间（main 侧建仓 + push 本地状态） */
  onCreateRoom: (server: string, room: string, joinPwd: string, gmPwd: string) => Promise<RoomResult>
  /** 拉取房间列表（公开） */
  onListRooms: () => Promise<string[]>
  /** 删除房间（需已登录 GM；不可恢复，调用方先确认） */
  onDeleteRoom: (room: string) => Promise<RoomResult>
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
}

// ---------- 工具 ----------

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (tag === 'button') node.setAttribute('type', 'button')
  if (text !== undefined) node.textContent = text
  return node
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
  const roomBtn = el('button', 'tbtn', gm.roomName ? `房间 ${gm.roomName}` : '连接')
  roomBtn.title = '连接服务器房间（加入 / 新建）'
  roomBtn.addEventListener('click', () => {
    ui.roomDialog = true
    rerender()
  })
  bar.append(roomBtn)

  // GM 登录状态（玩家只读模式下隐藏入口）
  if (!gm.urlReadonly) {
    const gmBtn = el('button', 'tbtn', gm.authed ? 'GM ✓' : 'GM 登录')
    gmBtn.title = gm.authed ? '点击管理 GM 登录' : '输入 GM 密钥获得编辑权限'
    gmBtn.addEventListener('click', () => {
      ui.gmDialog = true
      rerender()
    })
    bar.append(gmBtn)
  }

  const viewBtn = el('button', 'tbtn', ui.view === 'grid' ? '☷ 网格' : '≡ 列表')
  viewBtn.addEventListener('click', () => {
    ui.view = ui.view === 'grid' ? 'list' : 'grid'
    rerender()
  })
  bar.append(viewBtn)

  const themeBtn = el('button', 'tbtn', applyTheme() === 'dark' ? '深色' : '浅色')
  themeBtn.title = '切换深浅模式'
  themeBtn.addEventListener('click', () => {
    themeBtn.textContent = toggleTheme() === 'dark' ? '深色' : '浅色'
    rerender()
  })
  bar.append(themeBtn)

  if (!readonly) {
    const exportBtn = el('button', 'tbtn', '⤓ 导出')
    exportBtn.title = '导出全部进度钟为 PNG'
    exportBtn.addEventListener('click', () => exportStateAsPng(store.state))
    bar.append(exportBtn)

    const undoBtn = el('button', 'tbtn', '↶ 撤销') as HTMLButtonElement
    undoBtn.disabled = !store.canUndo
    undoBtn.addEventListener('click', () => {
      store.undo()
      rerender()
    })
    bar.append(undoBtn)

    const redoBtn = el('button', 'tbtn', '↷ 重做') as HTMLButtonElement
    redoBtn.disabled = !store.canRedo
    redoBtn.addEventListener('click', () => {
      store.redo()
      rerender()
    })
    bar.append(redoBtn)

    const newBtn = el('button', 'tbtn primary', '＋ 新建')
    newBtn.addEventListener('click', () => {
      ui.creating = true
      rerender()
    })
    bar.append(newBtn)
  }

  return bar
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

// ---------- 卡片网格 ----------

function clockCard(clock: ProgressClock): HTMLElement {
  const card = el('div', 'clock-card')
  card.dataset.id = clock.id
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
  for (const clock of Object.values(store.state.clocks)) {
    const card = clockCard(clock)
    if (clock.id === store.currentClockId) card.classList.add('current')
    if (!readonly) {
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
  for (const clock of Object.values(store.state.clocks)) {
    const row = el('div', 'clock-row')
    row.dataset.id = clock.id
    if (clock.id === store.currentClockId) row.classList.add('current')

    if (!readonly) {
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
  const numInput = document.createElement('input')
  numInput.type = 'number'
  numInput.min = '2'
  numInput.max = '10'
  numInput.value = String(initial)
  numInput.addEventListener('change', () => {
    for (const b of buttons.values()) b.classList.remove('selected')
    onChange(Number(numInput.value))
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

  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.placeholder = '钟名（如：内部巡逻）'
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
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.value = clock.name
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

  // 填充（滑块）
  modal.append(el('label', 'field', '填充'))
  const fillRange = document.createElement('input')
  fillRange.type = 'range'
  fillRange.min = '0'
  fillRange.max = String(clock.max)
  fillRange.value = String(clock.fill)
  const fillLabel = el('span', 'fill-value', `${clock.fill}/${clock.max}`)
  const fillRow = el('div', 'fill-row')
  fillRow.append(fillRange, fillLabel)
  fillRange.addEventListener('input', () => {
    fillLabel.textContent = `${fillRange.value}/${clock.max}`
  })
  fillRange.addEventListener('change', () => {
    store.updateClock(clock.id, { fill: Number(fillRange.value) })
    rerender()
  })
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
  const { backdrop, modal, close } = modalShell('GM 登录', () => {
    ui.gmDialog = false
    rerender()
  })

  if (gm.authed) {
    modal.append(el('p', 'gm-status', '当前已以 GM 身份登录'))
  }

  const hint = el('div', 'gm-hint', '')
  const input = document.createElement('input')
  input.type = 'password'
  input.placeholder = gm.roomName ? 'GM 密码（写权限）' : 'GM 密钥'
  input.autocomplete = 'off'

  const actions = el('div', 'modal-actions')
  const submit = el('button', 'tbtn primary', gm.authed ? '更换密钥' : '验证并登录')
  submit.addEventListener('click', async () => {
    const key = input.value.trim()
    if (!key) return
    hint.textContent = '验证中…'
    const ok = await gm.onSubmitKey(key)
    if (ok) {
      close()
    } else {
      hint.textContent = '密钥无效，请重试'
    }
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click()
  })

  if (gm.authed) {
    const logout = el('button', 'tbtn danger', '清除登录')
    logout.addEventListener('click', () => {
      gm.onLogout()
      close()
    })
    actions.append(logout)
  }
  actions.append(submit)

  // 服务器连接（分离模式）：Web 可指向任意后端；留空 = 同源托管
  const serverInput = document.createElement('input')
  serverInput.type = 'text'
  serverInput.placeholder = '服务器地址（留空 = 同源，如 http://192.168.1.10:2333）'
  serverInput.value = gm.serverBase
  serverInput.autocomplete = 'off'

  const serverActions = el('div', 'modal-actions')
  const saveServer = el('button', 'tbtn', '保存并连接')
  saveServer.addEventListener('click', async () => {
    const base = serverInput.value.trim()
    if (base === gm.serverBase) {
      close()
      return
    }
    hint.textContent = '连接中…'
    const done = await gm.onServerChange(base)
    hint.textContent = ''
    if (done) {
      close()
    } else {
      hint.textContent = '已取消，保持当前服务器'
    }
  })
  serverInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveServer.click()
  })
  serverActions.append(saveServer)

  modal.append(hint, input, actions, serverInput, serverActions)
  input.focus()
  return backdrop
}

// ---------- 房间连接弹窗（GitHub 模型：加入 = pull，新建 = 建仓 + push） ----------

function renderRoomModal(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const { backdrop, modal, close } = modalShell('连接房间', () => {
    ui.roomDialog = false
    ui.roomPrefill = ''
    rerender()
  })

  const hint = el('div', 'gm-hint', '')

  const serverInput = document.createElement('input')
  serverInput.type = 'text'
  serverInput.placeholder = '服务器地址（留空 = 同源，如 http://192.168.1.10:2333）'
  serverInput.value = gm.serverBase
  serverInput.autocomplete = 'off'

  const roomInput = document.createElement('input')
  roomInput.type = 'text'
  roomInput.placeholder = '房间名'
  roomInput.value = ui.roomPrefill || gm.roomName
  roomInput.autocomplete = 'off'

  const pwdInput = document.createElement('input')
  pwdInput.type = 'password'
  pwdInput.placeholder = '加入密码（可留空 = 公开房间，发给玩家）'
  pwdInput.value = gm.roomJoinPwd
  pwdInput.autocomplete = 'off'

  const gmInput = document.createElement('input')
  gmInput.type = 'password'
  gmInput.placeholder = 'GM 密码（留空 = 只读玩家；新建时必填 ≥6 位）'
  gmInput.autocomplete = 'off'

  const actions = el('div', 'modal-actions')
  const joinBtn = el('button', 'tbtn primary', '加入房间')
  const createBtn = el('button', 'tbtn', '新建房间')

  const submit = async (create: boolean) => {
    const server = serverInput.value.trim()
    const room = roomInput.value.trim()
    const joinPwd = pwdInput.value.trim()
    const gmPwd = gmInput.value.trim()
    if (!room) {
      hint.textContent = '请填写房间名'
      return
    }
    if (create && gmPwd.length < 6) {
      hint.textContent = 'GM 密码至少 6 位'
      return
    }
    hint.textContent = create ? '创建中…' : '连接中…'
    const result = create
      ? await gm.onCreateRoom(server, room, joinPwd, gmPwd)
      : await gm.onJoinRoom(server, room, joinPwd, gmPwd)
    if (result.ok) {
      close()
    } else {
      hint.textContent = result.error
    }
  }
  joinBtn.addEventListener('click', () => void submit(false))
  createBtn.addEventListener('click', () => void submit(true))
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit(false)
  })
  pwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit(false)
  })
  gmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit(false)
  })
  actions.append(createBtn, joinBtn)

  // 删除当前房间（仅已登录 GM；不可恢复，需确认）
  if (gm.authed && gm.roomName) {
    const delBtn = el('button', 'tbtn danger', '删除当前房间')
    delBtn.title = '删除后所有进度钟将丢失，无法恢复'
    delBtn.addEventListener('click', async () => {
      if (!confirm(`删除房间「${gm.roomName}」？此操作不可恢复，所有进度钟将丢失。`)) return
      const result = await gm.onDeleteRoom(gm.roomName)
      if (result.ok) {
        close()
      } else {
        hint.textContent = result.error
      }
    })
    modal.append(delBtn)
  }

  modal.append(hint, serverInput, roomInput, pwdInput, gmInput, actions)
  roomInput.focus()
  return backdrop
}

// ---------- 房间侧边栏（显示所有房间，点击加入） ----------

function renderRoomSidebar(ui: UiState, gm: GmContext, rerender: Rerender): HTMLElement {
  const aside = el('aside', 'room-sidebar')
  const titleRow = el('div', 'room-sidebar-title')
  titleRow.append(el('span', '', '房间'))
  const list = el('ul', 'room-sidebar-list')

  const load = async () => {
    list.textContent = ''
    const rooms = await gm.onListRooms()
    if (rooms.length === 0) {
      list.append(el('li', 'room-sidebar-empty', '暂无房间'))
      return
    }
    for (const room of rooms) {
      const li = el('li', 'room-sidebar-item', room)
      li.title = '点击加入（输入密码）'
      li.addEventListener('click', () => {
        ui.roomPrefill = room
        ui.roomDialog = true
        rerender()
      })
      list.append(li)
    }
  }
  const refresh = el('button', 'tbtn', '刷新')
  refresh.addEventListener('click', () => void load())
  titleRow.append(refresh)
  aside.append(titleRow, list)
  void load()
  return aside
}
