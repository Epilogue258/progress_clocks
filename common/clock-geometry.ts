/**
 * 钟图几何（平台无关纯函数）：Web 端 SVG 渲染与 server 端导出图共用。
 */

/** 圆心坐标与半径 */
const CX = 50
const CY = 50
const R = 46

/** 起始角：12 点方向，顺时针 */
const START = -Math.PI / 2

/** 角度 -> 圆周上点的坐标 */
function polar(angle: number): [number, number] {
  return [CX + R * Math.cos(angle), CY + R * Math.sin(angle)]
}

/** 生成单个扇形的 SVG path 数据（从圆心到弧） */
export function segmentPath(a0: number, a1: number): string {
  const [x0, y0] = polar(a0)
  const [x1, y1] = polar(a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${CX} ${CY} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`
}

/** 第 i 段的起止角（共 max 段） */
export function segmentAngles(i: number, max: number): [number, number] {
  const step = (Math.PI * 2) / max
  const a0 = START + i * step
  return [a0, a0 + step]
}
