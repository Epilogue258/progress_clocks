/**
 * 导出图渲染：SVG -> PNG。
 * 使用 @resvg/resvg-js（Rust 实现，预编译二进制，无原生编译依赖）。
 *
 * 注意：中文字体依赖系统字体，Linux 服务器需安装中文字体
 * （如 Noto Sans CJK SC / fonts-noto-cjk），否则中文会渲染成方块。
 */

import { Resvg } from '@resvg/resvg-js'
import { buildExportSvg } from '../../common/export-svg.ts'
import type { ClockState } from '../../common/types.ts'

/** 生成整张导出图的 PNG（白底，宽度限制 1200，自动等比缩放） */
export function renderPng(state: ClockState): Buffer {
  const svg = buildExportSvg(state)
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
  return resvg.render().asPng()
}
