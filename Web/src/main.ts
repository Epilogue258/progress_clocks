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
import { ApiError, fetchState, pollState, saveState, verifyKey } from './api'

// server 地址：默认同源（Web 由 server 静态托管）。
// 独立部署 / 本地联调时改为完整地址，如 'http://192.168.1.10:2333'
const API_BASE = ''

const GM_KEY_STORAGE = 'pc-gm-key'
const urlReadonly = new URLSearchParams(location.search).has('readonly')

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
const ui: UiState = { view: 'grid', settingsClockId: null, creating: false, gmDialog: false }

// ---------- GM 鉴权状态 ----------

let gmKey: string | null = localStorage.getItem(GM_KEY_STORAGE)
let gmAuthed = false

// 启动时验证本地已存的密钥是否仍有效
if (!urlReadonly && gmKey) {
  verifyKey(API_BASE, gmKey).then((ok) => {
    gmAuthed = ok
    if (!ok) {
      gmKey = null
      localStorage.removeItem(GM_KEY_STORAGE)
    }
    rerender()
  })
}

const gm: GmContext = {
  urlReadonly,
  get authed() {
    return gmAuthed
  },
  onSubmitKey: async (key) => {
    const ok = await verifyKey(API_BASE, key)
    if (ok) {
      gmKey = key
      gmAuthed = true
      localStorage.setItem(GM_KEY_STORAGE, key)
      rerender()
    }
    return ok
  },
  onLogout: () => {
    gmAuthed = false
    gmKey = null
    localStorage.removeItem(GM_KEY_STORAGE)
    rerender()
  },
}

const rerender = () =>
  render(root, store, ui, urlReadonly || !gmAuthed, rerender, gm)
rerender()

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
  window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(async () => {
    try {
      const version = await saveState(API_BASE, store.syncState, gmKey ?? undefined)
      // 推送成功：更新同步基线，避免下次操作（含撤销）携带旧版本触发假冲突
      store.markSynced(version)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 多写冲突：采用服务器最新状态（丢包重做模式，桌游场景足够）
        try {
          const remote = e.latest ?? (await fetchState(API_BASE))
          store.replaceState(remote)
          showToast('状态已在别处更新，已同步最新')
          rerender()
        } catch {
          // 拉取失败静默
        }
      } else if (e instanceof ApiError && e.status === 401) {
        // 密钥失效：清除登录态并提示重新输入
        gmAuthed = false
        gmKey = null
        localStorage.removeItem(GM_KEY_STORAGE)
        showToast('GM 密钥失效，请重新登录')
        rerender()
      }
      // 其他错误（网络等）静默
    }
  }, 500)
})

// 启动：拉取 server 状态（server 为权威；失败保持本地数据，离线可用）
fetchState(API_BASE)
  .then((remote) => {
    store.replaceState(remote)
    rerender()
  })
  .catch(() => {
    // 离线模式，仅本地 localStorage
  })

// 玩家只读模式：轮询 server（GM 端不轮询，靠推送）
if (urlReadonly) {
  pollState(API_BASE, (remote) => {
    store.replaceState(remote)
    rerender()
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

  if (urlReadonly || !gmAuthed) return

  if (e.key === 'Escape') {
    if (ui.creating) {
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
