/**
 * 进度钟 PWA Service Worker：只负责「app 外壳离线可启动」。
 *
 * 与业务数据层的分工（README「目标架构」）：local 房间与同步状态机早已把离线
 * 能力做在应用层，这里绝不碰业务——尤其是 /api/* 一律不拦截：
 * 同步逻辑（401 与超时分流、退避重试）建立在真实响应上，缓存会整个破坏它。
 *
 * 缓存策略（两条）：
 * - 导航请求 network-first：在线拿最新 index.html（引用最新 hash 资源），
 *   成功顺手刷新外壳缓存；离线回退缓存里的入口页。
 * - 其余静态资源 cache-first：构建产物带 hash 不可变，命中即返回，未命中回源并写入。
 *   （旧版本构建的残留会留在 runtime 缓存里，单次构建几百 KB，不值得为此做清单比对）
 *
 * 更新：改本文件时必须递增 VERSION——旧缓存靠 activate 时的前缀比对清理；
 * 不改本文件的新构建无需任何操作，导航 network-first 天然拿到新 index.html。
 */
const VERSION = 'pc-shell-v1'
const SHELL = `${VERSION}-shell`
const RUNTIME = `${VERSION}-runtime`
/** 安装期预缓存：入口页 + manifest（图标等走 runtime，首访后即有） */
const SHELL_URLS = ['./', './manifest.json']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)))
  // 不 skipWaiting：新版本等下一个会话再接管，不打断正在跑的团
  // （页面还持着旧资源的引用，中途换 SW 没有收益只有风险）
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // 跨域（分离模式指向外部服务器）不拦：与同源静态资源不是一个生命周期
  if (url.origin !== self.location.origin) return
  // API 绝不缓存（见文件头）；其余交给浏览器
  if (url.pathname.startsWith('/api/')) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 顺手刷新外壳缓存的入口页，保证离线副本始终是最近一次成功访问的版本
          const copy = res.clone()
          void caches.open(SHELL).then((cache) => cache.put('./', copy))
          return res
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    )
    return
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            void caches.open(RUNTIME).then((cache) => cache.put(req, copy))
          }
          return res
        }),
    ),
  )
})
