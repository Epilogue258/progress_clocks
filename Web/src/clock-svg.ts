/**
 * 页面钟渲染（SVG，披萨饼式扇形分段）：
 * - 每个格独立扇形 path，段间用卡片色描边分隔 -> 接缝清晰
 * - 已填段 = 钟颜色，未填段 = track 色；填满也能看出分段
 * - fill 用 CSS transition 实现填充动画
 * - 几何计算复用 common/clock-geometry（与导出图一致）
 */

import { segmentAngles, segmentPath } from '../../common/clock-geometry'

export interface ClockVisual {
  max: number
  fill: number
  color: string
}

export function svgClock(clock: ClockVisual): string {
  const segs: string[] = []
  for (let i = 0; i < clock.max; i++) {
    const [a0, a1] = segmentAngles(i, clock.max)
    const filled = i < clock.fill
    const fill = filled ? clock.color : 'var(--track)'
    segs.push(
      `<path d="${segmentPath(a0, a1)}" ` +
        `style="fill: ${fill}; stroke: var(--card); stroke-width: 2.5; transition: fill .3s ease"/>`,
    )
  }
  return `<svg viewBox="0 0 100 100" role="img" aria-label="${clock.fill}/${clock.max}">${segs.join('')}</svg>`
}
