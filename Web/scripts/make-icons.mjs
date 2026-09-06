/**
 * PWA 图标生成（一次性工具，产物已提交进 Web/public/icons/，改设计后重跑本脚本即可）。
 * 运行：node Web/scripts/make-icons.mjs
 * 复用 server 已安装的 @resvg/resvg-js（createRequire 指向 server 包），不新增依赖。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { Resvg } = require('@resvg/resvg-js')

const RED = '#e53935'
const DARK = '#161616'
const LIGHT = '#faf9f5'

function polar(cx, cy, r, a) {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

function wedge(cx, cy, r, a0, a1, fill, seam) {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return (
    `<path d="M ${cx} ${cy} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z"` +
    ` fill="${fill}"${seam ? ` stroke="${seam}" stroke-width="2.5"` : ''}/>`
  )
}

/**
 * 透明底图标：与 favicon 同款——红圆 + 12→3 点暗色扇形（1/4 填充的钟）。
 * 触角留 4% 边距，各启动器缩放时不贴边。
 */
function iconSvg() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<g transform="translate(4 4) scale(0.92)">` +
    `<circle cx="50" cy="50" r="46" fill="${RED}"/>` +
    wedge(50, 50, 46, -Math.PI / 2, 0, DARK) +
    `</g></svg>`
  )
}

/**
 * 不透明底（maskable / apple-touch-icon）：暗底 + 四段红钟、一段亮色表示已填充，
 * 扇形间用底色描出接缝。内容缩放到安全区（maskable 中心 80% 内）之内。
 */
function opaqueIconSvg() {
  const seam = DARK
  const scale = 0.78
  const pad = (100 - 100 * scale) / 2
  let wedges = ''
  for (let i = 0; i < 4; i++) {
    const a0 = -Math.PI / 2 + (i * Math.PI) / 2
    wedges += wedge(50, 50, 46, a0, a0 + Math.PI / 2, i === 0 ? LIGHT : RED, seam)
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${DARK}"/>` +
    `<g transform="translate(${pad} ${pad}) scale(${scale})">${wedges}</g>` +
    `</svg>`
  )
}

function renderPng(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

const outDir = new URL('../public/icons/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const files = [
  ['icon-192.png', renderPng(iconSvg(), 192)],
  ['icon-512.png', renderPng(iconSvg(), 512)],
  ['maskable-192.png', renderPng(opaqueIconSvg(), 192)],
  ['maskable-512.png', renderPng(opaqueIconSvg(), 512)],
  // iOS 不支持 manifest 图标，只认 apple-touch-icon；且不能透明（会被填黑成不规则形状）
  ['apple-touch-icon.png', renderPng(opaqueIconSvg(), 180)],
]

for (const [name, png] of files) {
  writeFileSync(new URL(name, outDir), png)
  console.log(`ok ${name} (${png.length} bytes)`)
}
