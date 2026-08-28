import type { ClockState } from './types'

/**
 * 导出当前全部进度钟为一张 PNG（白底固定排版，与主题无关，方便发给玩家）。
 * canvas 2D 重绘（不复用 SVG，避免 CSS 变量和序列化问题）。
 */

const CELL = 340
const HEADER = 110
const PAD = 48
const R = 100

function drawClock(
  ctx: CanvasRenderingContext2D,
  clock: { name: string; max: number; fill: number; color?: string },
  cx: number,
  cy: number,
): void {
  const color = clock.color ?? '#888888'
  const track = '#e3e1da'
  const step = (Math.PI * 2) / clock.max

  for (let i = 0; i < clock.max; i++) {
    const a0 = -Math.PI / 2 + i * step
    const a1 = a0 + step
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, R, a0, a1)
    ctx.closePath()
    ctx.fillStyle = i < clock.fill ? color : track
    ctx.fill()
    // 白色描边 = 清晰接缝（填满也能看出份数）
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 5
    ctx.stroke()
  }

  ctx.textAlign = 'center'
  ctx.fillStyle = '#161616'
  ctx.font = 'bold 34px system-ui, sans-serif'
  ctx.fillText(`${clock.fill}/${clock.max}`, cx, cy + R + 46)
  ctx.fillStyle = '#6b6b66'
  ctx.font = '600 26px system-ui, sans-serif'
  ctx.fillText(clock.name || '未命名', cx, cy + R + 86)
}

export function exportStateAsPng(state: ClockState): void {
  const clocks = Object.values(state.clocks)
  if (clocks.length === 0) return

  const cols = Math.ceil(Math.sqrt(clocks.length))
  const rows = Math.ceil(clocks.length / cols)
  const width = cols * CELL + PAD * 2
  const height = HEADER + rows * CELL + PAD

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = '#161616'
  ctx.font = '800 44px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('进度钟', width / 2, 70)

  clocks.forEach((clock, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    drawClock(ctx, clock, PAD + col * CELL + CELL / 2, HEADER + row * CELL + CELL / 2)
  })

  const a = document.createElement('a')
  a.download = `progress-clocks-${new Date().toISOString().slice(0, 10)}.png`
  a.href = canvas.toDataURL('image/png')
  a.click()
}
