import type { ProgressClock } from './types'
import { PALETTE, Store } from './state'
import { svgClock } from './clock-svg'
import { exportStateAsPng } from './export'

export type ViewMode = 'grid' | 'list'

export interface UiState {
  view: ViewMode
  settingsClockId: string | null
  /** 新建弹窗开关 */
  creating: boolean
}

export type Rerender = () => void

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
): void {
  root.textContent = ''
  root.append(renderTopbar(store, ui, readonly, rerender))
  root.append(
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
): HTMLElement {
  const bar = el('header', 'topbar')
  bar.append(el('span', 'title', '进度钟'))

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
