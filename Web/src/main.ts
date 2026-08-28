/**
 * 进度钟 Web 端入口
 * - GM 主控模式（默认）：编辑、快捷键
 * - 玩家查看模式：URL 带 ?readonly 时只读（隐藏编辑入口）
 */
import './styles.css'
import { Store } from './state'
import { applyTheme, render, type UiState } from './ui'

const root = document.getElementById('app')!
applyTheme()

const store = new Store()
const readonly = new URLSearchParams(location.search).has('readonly')
// 演示模式：空状态时预置示例钟（也用于无头验证）
if (new URLSearchParams(location.search).has('demo') && Object.keys(store.state.clocks).length === 0) {
  store.createClock('宅邸警戒', 4)
  store.createClock('红绸党', 6)
  store.createClock('潜入斯特朗福德', 8)
}
const ui: UiState = { view: 'grid', settingsClockId: null, creating: false }

const rerender = () => render(root, store, ui, readonly, rerender)
rerender()

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
