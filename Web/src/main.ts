/**
 * 进度钟 Web 端入口
 * - GM 主控模式（默认）：编辑、快捷键
 * - 玩家查看模式：URL 带 ?readonly 时只读（隐藏编辑入口）
 *
 * 数据流（本地优先 + server 同步）：
 * - 启动：localStorage 立即显示 -> 异步拉取 server 状态替换（server 为权威）
 * - 变更：本地立即生效 + 防抖 500ms 全量推送到 server（单写者全量覆盖，无冲突）
 * - 只读模式：轮询 server（5s），本地不写
 * - server 不可达时：保持本地 localStorage 数据，离线可用
 */
import './styles.css'
import { Store } from './state'
import { applyTheme, render, type UiState } from './ui'
import { fetchState, pollState, saveState } from './api'

// server 地址：默认同源（Web 由 server 静态托管）。
// 独立部署 / 本地联调时改为完整地址，如 'http://192.168.1.10:2333'
const API_BASE = ''

const root = document.getElementById('app')!
applyTheme()

const store = new Store()
const readonly = new URLSearchParams(location.search).has('readonly')
// 演示模式：空状态时预置示例钟（也用于无头验证）
if (
  new URLSearchParams(location.search).has('demo') &&
  Object.keys(store.state.clocks).length === 0
) {
  store.createClock('宅邸警戒', 4)
  store.createClock('红绸党', 6)
  store.createClock('潜入斯特朗福德', 8)
}
const ui: UiState = { view: 'grid', settingsClockId: null, creating: false }

const rerender = () => render(root, store, ui, readonly, rerender)
rerender()

// ---------- 同步层 ----------

// 变更防抖推送到 server（失败静默，下次变更重试）
let pushTimer: number | undefined
store.subscribe(() => {
  if (readonly) return
  window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(() => {
    saveState(API_BASE, store.state).catch(() => {})
  }, 500)
})

if (readonly) {
  // 玩家端：轮询 server
  pollState(API_BASE, (remote) => {
    store.replaceState(remote)
    rerender()
  })
} else {
  // GM 端：启动时拉取 server 状态（server 为权威；失败则保持本地数据）
  fetchState(API_BASE)
    .then((remote) => {
      store.replaceState(remote)
      rerender()
    })
    .catch(() => {
      // server 不可达：离线模式，仅本地 localStorage
    })
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

  if (readonly) return

  if (e.key === 'Escape') {
    if (ui.creating) {
      ui.creating = false
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
