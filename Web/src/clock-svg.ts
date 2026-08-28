/**
 * SVG 钟生成：披萨饼式扇形分段。
 * - 每个格独立扇形 path，段间用卡片色描边分隔 -> 接缝清晰
 * - 已填段 = 钟颜色，未填段 = track 色；填满也能看出分段
 * - fill 用 CSS transition 实现填充动画
 * - viewBox 100x100，任意尺寸缩放
 */

export interface ClockVisual {
  max: number
  fill: number
  color: string
}

const CX = 50
const CY = 50
const R = 46
const START = -Math.PI / 2 // 12 点方向起，顺时针

function polar(angle: number): [number, number] {
  return [CX + R * Math.cos(angle), CY + R * Math.sin(angle)]
}

function segmentPath(a0: number, a1: number): string {
  const [x0, y0] = polar(a0)
  const [x1, y1] = polar(a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${CX} ${CY} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`
}

export function svgClock(clock: ClockVisual): string {
  const step = (Math.PI * 2) / clock.max
  const segs: string[] = []
  for (let i = 0; i < clock.max; i++) {
    const a0 = START + i * step
    const a1 = a0 + step
    const filled = i < clock.fill
    const fill = filled ? clock.color : 'var(--track)'
    segs.push(
      `<path d="${segmentPath(a0, a1)}" ` +
        `style="fill: ${fill}; stroke: var(--card); stroke-width: 2.5; transition: fill .3s ease"/>`,
    )
  }
  return `<svg viewBox="0 0 100 100" role="img" aria-label="${clock.fill}/${clock.max}">${segs.join('')}</svg>`
}
