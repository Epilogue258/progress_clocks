/**
 * 拖动排序（指针事件实现，桌面与触屏同一套）。
 *
 * 手势分工：把手负责拖动，卡片其余部分保持原有语义（点击 +1 / 长按设置 / 右键设置）。
 * 用独立把手而不是「按住卡片直接拖」，是因为移动端的长按已被「打开设置」占用，
 * 两者抢同一段指针序列必然打架；把手自带 touch-action:none，也不会打断页面滚动。
 */

export interface DragSortConfig {
  /** 容纳所有条目的容器（网格或列表），用于定位兄弟元素与放置插入指示线 */
  container: HTMLElement
  /** 拖动落定后回调：把 id 插到第 toIndex 位（下标以「不含自己」的序列为准） */
  onReorder: (id: string, toIndex: number) => void
}

const ITEM_SELECTOR = '[data-clock-id]'

export function bindDragHandle(
  handle: HTMLElement,
  item: HTMLElement,
  id: string,
  cfg: DragSortConfig,
): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 掐断冒泡：不要把拖动的起点当成卡片点击（会误 +1）或长按（会误开设置）
    e.preventDefault()
    e.stopPropagation()
    startDrag(e, handle, item, id, cfg)
  })
}

function startDrag(
  down: PointerEvent,
  handle: HTMLElement,
  item: HTMLElement,
  id: string,
  cfg: DragSortConfig,
): void {
  const container = cfg.container
  const isGrid = container.classList.contains('clocks-grid')
  /** 含被拖元素在内的完整序列 */
  const all = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
  /** 不含被拖元素的序列——插入下标以此为准 */
  const others = (): HTMLElement[] => all().filter((el) => el !== item)

  // item 在完整序列里排第 k，那么在「移除自己」的序列里插回第 k 位正好复原，
  // 所以 originIndex 取完整序列下标，与 targetIndex 的语义才对得上。
  const originIndex = Math.max(0, all().indexOf(item))
  let targetIndex = originIndex

  const marker = document.createElement('div')
  marker.className = 'drag-marker'
  container.append(marker)
  document.body.classList.add('drag-active')
  item.classList.add('dragging')

  /** 把指示线摆到第 index 个位置的前面（index 越界则摆在末尾） */
  const placeMarker = (index: number): void => {
    const list = others()
    const ref = index < list.length ? list[index] : list[list.length - 1]
    if (!ref) return
    const cr = container.getBoundingClientRect()
    const r = ref.getBoundingClientRect()
    if (isGrid) {
      marker.style.left = `${(index < list.length ? r.left - 7 : r.right + 4) - cr.left}px`
      marker.style.top = `${r.top - cr.top}px`
      marker.style.width = '3px'
      marker.style.height = `${r.height}px`
    } else {
      marker.style.left = `${r.left - cr.left}px`
      marker.style.top = `${(index < list.length ? r.top - 7 : r.bottom + 4) - cr.top}px`
      marker.style.width = `${r.width}px`
      marker.style.height = '3px'
    }
  }

  /** 指针落点对应的插入下标：先找最近的条目，再判断落在它之前还是之后 */
  const computeIndex = (x: number, y: number): number => {
    const list = others()
    if (list.length === 0) return 0
    let bestIdx = 0
    let bestDist = Infinity
    list.forEach((el, i) => {
      const r = el.getBoundingClientRect()
      const dx = x - (r.left + r.width / 2)
      const dy = y - (r.top + r.height / 2)
      const dist = dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    })
    const r = list[bestIdx].getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // 网格：不在同一行时按 y 判前后，落在同一行则按 x；列表恒按 y
    const before = isGrid ? (Math.abs(y - cy) > r.height / 2 ? y < cy : x < cx) : y < cy
    return before ? bestIdx : bestIdx + 1
  }

  placeMarker(targetIndex)

  const onMove = (e: PointerEvent): void => {
    item.style.transform = `translate(${e.clientX - down.clientX}px, ${e.clientY - down.clientY}px)`
    targetIndex = computeIndex(e.clientX, e.clientY)
    placeMarker(targetIndex)
  }

  const finish = (commit: boolean): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onCancel)
    marker.remove()
    document.body.classList.remove('drag-active')
    item.classList.remove('dragging')
    item.style.transform = ''
    if (commit && targetIndex !== originIndex) cfg.onReorder(id, targetIndex)
  }

  const onUp = (): void => finish(true)
  const onCancel = (): void => finish(false)

  try {
    handle.setPointerCapture(down.pointerId)
  } catch {
    // 指针已失效（极端时序）时退化为普通事件流，不影响其余逻辑
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onCancel)
}
