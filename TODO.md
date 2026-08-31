# TODO —— progress_clocks

> 仅本仓库相关项。根目录 `README.md` 的「待办任务」一节是这里的摘要，
> 增删条目时两边一起改。

## Open

- [ ] **dist 可双击打开**（`TODO-bcb78b27`，web/build）
  `dist/index.html` 用的是 `<script type="module">`，主流浏览器在 `file://` 下
  都会以 CORS 为由拒绝加载，所以 README 里「双击 file:// 打开」的说法不成立。
  二选一：改出单文件内联构建（脚本内联进 HTML，真正可双击），或如实改文档去掉该说法。
  注意与 `TODO-bf7146b6`（CORS 收紧）相关：白名单要处理 `file://` 下来源为 `null` 的 preflight。

- [ ] **云部署**（`TODO-6b955a94`，deploy/ops）
  学生云 + `GM_KEY` + 中文字体（`apt install fonts-noto-cjk`，否则导出图中文变方块）
  + 可选反向代理（Caddy/Nginx）+ 仅暴露 Tailscale/局域网或加鉴权。

- [ ] **Apk 端实现**（`TODO-e9513499`，apk/mvp）
  目录已有最小 Compose 工程。实现画钟、点击+1/长按菜单、撤销重做、
  本地持久化（契约同 `common/types.ts`）、GM 登录、房间同步。

- [ ] **SSE 推送**（`TODO-87e5ae0e`，server/web，可选）
  server 加 `GET /api/events`（状态变更推送），Web 玩家端 EventSource 订阅替代轮询，
  保留轮询 fallback。当前设计决策：变更频率低，5s 轮询足够，SSE 为非必要增强。

- [ ] **写鉴权限流**（`TODO-26c7a47f`，server/optional）
  401 失败计数限速，防公网暴力尝试。当前信任网络假设下非必需。

- [ ] **CORS 收紧**（`TODO-bf7146b6`，server/security）
  现状：`server/src/index.ts` 对所有响应下发 `Access-Control-Allow-Origin: *`，
  同时 `Access-Control-Allow-Headers` 放行 `Authorization`。
  局域网 / Tailscale 下无害，但一旦按「云部署」暴露到公网，任意网站的 JS
  都能带着 GM 密钥读写房间（浏览器不会拦，因为服务端亲口允许了 `*`）。
  做法：默认改为同源 + 仅放行配置白名单（`ALLOWED_ORIGINS`，分离部署时显式配置），
  保留 `*` 作为 `--dev` 开关；注意 `file://` 分离模式的 preflight 来源为 `null`，
  白名单需允许 `null` 或固定走同源。与「云部署」互为前置，可一起做。

## Done

- [x] **本地房间 / 远端房间分离**（`TODO-ff3a66e8`）——核心已落地
  房间分 local（只活本机、永远可编辑、永不联网）与 remote（无写凭证即只读镜像），
  状态按槽隔离；`canEdit` / `canPush` 拆开；「拉取冲突」这条路径整体删除；
  启动即本地工作区，不再强制进远端房间。2026-08-30 完成。

- [x] **「另存为本地」**（`TODO-2d37f13a` 的入口部分）——2026-08-30 完成
  入口常驻顶栏「更多（⋯）」；把当前远端房间落成本地快照（重名顺延 `room_name(2)`），
  记住 `origin: { server, room }` 便于「提交本地房间」一键回推。
  「离线置灰」部分单独立项，见 Done 区「断线三阶段的界面置灰」。

- [x] **bootstrapPull 不再无条件覆盖本地**（`TODO-786a225c`）——2026-08-30 完成
  `bootstrapPull` 只对远端房间运行（server 权威，覆盖即正确语义）；
  本地房间与空白工作区不联网，本地改动不再被启动拉取覆盖。

- [x] **轮询协议：结果分类 + 降级 + 恢复**（`TODO-97427710` 的核心）——2026-08-30 完成
  成功且版本相同 → 跳过（避免清撤销栈/选中态）；版本不同 → 本地不 dirty 采用远端、
  本地 dirty 先 push；404 → 房间已删退出，不无限重试。
  断线退避重试（`5s → 10s → 20s → 40s`，上限 `60s`）+ 静默补一次快速重试；
  401 与超时分开且按请求类型分流（轮询 401 = joinPwd 错、推送 401 = gmPwd 错，降级只读）。

- [x] **断线三阶段的界面置灰**（`TODO-97427710` 剩余，web/ux）——2026-08-31 完成
  「重试中 / 离线」的界面置灰、断线横幅、手动「重试」按钮全部落地：
  首次失败静默补一次快速重试（不提示不置灰）→ 仍失败进「重试中」（置灰写操作 + 横幅提示）
  → 再连续失败 3 次进「离线」（横幅引导「更多 → 另存为本地」）→ 退避拉长 + 手动重试；
  任一请求成功即解除并给「已重新连接」反馈。轮询撞 401 停轮询弹连接弹窗重输，不进退避。
  置灰只针对写操作（新建/删除/填充/钟设置/拖动/提交本地房间）；撤销/重做按撤销栈保留，
  导出 PNG、另存为本地、连接与登录、退出房间等非写功能一律保留。
  连接状态由请求结果推导（不做独立探活），本地房间与空白工作区恒 reachable。

- [x] **多场景支持**（`TODO-6d8a3ba3`，web/contract）——被房间机制替代实现
  一个房间 = 一次团（状态按房间隔离），替代契约方案 A（clock 加 `group` 字段）。
  2026-08-29 关闭。

- [x] **push 默认覆盖乐观锁**（`TODO-2a188191`，web/sync）——2026-08-30 完成
  `store.syncState`（version = 同步基线）换成 `store.pushState`（不带 version）；
  服务端对 version 非数字的写入本就走强制覆盖，未改服务端。
  实测：无 version 连续推送两次均 200 且真的覆盖；带陈旧 version 仍 409（Bot 路径保留）。
  `syncedVersion` 随之删除（没人再读），`markSynced` 保留——轮询靠 `state.version` 判断是否落后。

- [x] **轮询每 5s 无条件 `replaceState` 清掉选中态**（`TODO-71af8dd5`，web/bug）——2026-08-30 完成
  轮询回调先比对 `version`，相同直接 return，不再清空撤销栈与「当前钟」选中态。

- [x] **推送失败后按退避重试**（web/data-loss，未立项，审计时发现）——2026-08-30 完成
  推送的网络错误分支原先完全静默，`dirty` 恒为真而 GM 端不轮询，改动再也没有第二次机会；
  关掉页面后本地数据还在，却会被下次 `bootstrapPull` 覆盖掉。
  改为排一次重试：5s → 10s → 20s → 40s，上限 60s，成功即重置。

- [x] **加入/切换房间后未清 `dirty`**（web/bug，未立项，审计时发现）——2026-08-30 完成
  两处 `replaceState(remote)` 之后漏了 `dirty = false`（退出房间与换服务器那两处是有的），
  导致轮询被 `if (dirty) return` 永久挡死，刚进的房间是张静止快照。
