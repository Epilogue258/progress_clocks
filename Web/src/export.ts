/**
 * 浏览器端导出 PNG（离线兜底方案）：
 * 复用 common/export-svg 生成 SVG -> img -> canvas -> PNG 下载。
 *
 * 在线场景可改用 server 的 GET /api/export.png（外部插件 / QQ Bot 也用这个）。
 */

import { buildExportSvg } from '../../common/export-svg'
import type { ClockState } from '../../common/types'

/** 导出当前全部进度钟为 PNG（白底固定排版，方便发送给玩家） */
export async function exportStateAsPng(state: ClockState): Promise<void> {
  const svg = buildExportSvg(state)

  // SVG 转位图（等字体与几何渲染完成后）
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()

  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(img, 0, 0)

  const a = document.createElement('a')
  a.download = `progress-clocks-${new Date().toISOString().slice(0, 10)}.png`
  a.href = canvas.toDataURL('image/png')
  a.click()
}
