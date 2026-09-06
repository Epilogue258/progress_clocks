/**
 * 导出图 SVG 生成（平台无关纯函数）：
 * - Web 端：SVG -> img -> canvas -> PNG 下载（离线可用）
 * - server 端：SVG -> resvg -> PNG（供 QQ Bot 等外部插件调用）
 *
 * 固定白底排版，与主题无关，方便发送给玩家。
 */

import type { ClockState } from './types'

/** 导出图布局常量（与旧 canvas 实现一致） */
const CELL = 340 // 每个钟的单元格边长
const HEADER = 110 // 顶部标题区高度
const PAD = 48 // 边距
const R = 100 // 钟的半径

/** 角度 -> 圆周坐标（以 cx/cy 为圆心） */
function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
}

/** 扇形 path 数据 */
function fan(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`
}

/** XML 转义（钟名可能含 <>& 等字符） */
function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** 单个钟的 SVG 分组：扇形 + 数字 + 名字 */
function clockGroup(
  clock: { name: string; max: number; fill: number; color?: string },
  cx: number,
  cy: number,
): string {
  const color = clock.color ?? '#888888'
  const track = '#e3e1da'
  const step = (Math.PI * 2) / clock.max

  const segs: string[] = []
  for (let i = 0; i < clock.max; i++) {
    const a0 = -Math.PI / 2 + i * step
    const a1 = a0 + step
    // 白色描边 = 清晰接缝（填满也能看出份数）
    segs.push(
      `<path d="${fan(cx, cy, R, a0, a1)}" fill="${i < clock.fill ? color : track}" stroke="#ffffff" stroke-width="5"/>`,
    )
  }

  const name = esc(clock.name || '未命名')
  return (
    `<g>` +
    segs.join('') +
    `<text x="${cx}" y="${cy + R + 46}" font-family="'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif" font-size="34" font-weight="700" fill="#161616" text-anchor="middle">${clock.fill}/${clock.max}</text>` +
    `<text x="${cx}" y="${cy + R + 86}" font-family="'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif" font-size="26" font-weight="600" fill="#6b6b66" text-anchor="middle">${name}</text>` +
    `</g>`
  )
}

/** 生成整张导出图 SVG */
export function buildExportSvg(state: ClockState): string {
  const clocks = Object.values(state.clocks)
  if (clocks.length === 0) {
    // 空状态：返回一张提示图
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>` +
      `<text x="300" y="160" font-family="system-ui,sans-serif" font-size="32" font-weight="700" fill="#6b6b66" text-anchor="middle">暂无进度钟</text>` +
      `</svg>`
    )
  }

  const cols = Math.ceil(Math.sqrt(clocks.length))
  const rows = Math.ceil(clocks.length / cols)
  const width = cols * CELL + PAD * 2
  const height = HEADER + rows * CELL + PAD

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${width / 2}" y="70" font-family="'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif" font-size="44" font-weight="800" fill="#161616" text-anchor="middle">进度钟</text>`,
  ]

  clocks.forEach((clock, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    parts.push(clockGroup(clock, PAD + col * CELL + CELL / 2, HEADER + row * CELL + CELL / 2))
  })

  parts.push('</svg>')
  return parts.join('')
}
