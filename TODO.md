# TODO —— progress_clocks

> 仅本仓库相关项。根目录 `README.md` 的「待办任务」一节是这里的摘要，
> 增删条目时两边一起改。

## Open

- [ ] **本地房间 / 远端房间分离**（`TODO-ff3a66e8`，web/architecture）
  README「目标架构：本地房间与远端房间分离」一节的落地，本批工作的核心。
  做四件事：
  1. 房间分 local（只活本机、永远可编辑、永不联网）与 remote（指向 server）两类，状态隔离存放
  2. remote 房间仅在「在线 + 写凭证有效」时是工作副本，否则降级为只读镜像
  3. localStorage 按房间分格（当前只有一份全局状态，没有房间的概念）
  4. 启动不再强制进入远端房间，打开就是本地工作区

  起手式是拆 `main.ts` 里 `urlReadonly || !gmAuthed` 这一行——它把
  「能不能 push」和「能不能编辑」合成了一个 `readonly` 参数传给 `render`。
  拆成 `canPush`（决定是否推送、是否显示同步入口）与 `readonly`（决定编辑入口是否可用）
  两个概念后，上面的 1–4 才有地方挂。

  完成后「拉取冲突」这条路径应当整体消失：local 不联网无从冲突，
  remote 无凭证即只读、本就不存在待推送改动。相关 `confirm` 对话框一并删掉。

- [ ] **「另存为本地」+ 离线置灰**（`TODO-2d37f13a`，web/ux，依赖上一条）
  离线（或凭证未验证）时，把除「另存为本地」以外的编辑入口全部置灰。
  点它把当前 remote 房间的内容落成一份 local 房间，让用户能继续工作而不是对着点不动的图发呆。
  本地重名自动顺延为 `room_name(2)`（取第一个空位，不是无脑 +1）。
  存下来的 local 房间记住 `origin: { server, room }`，恢复网络后可一键 push 回去。

- [ ] **push 默认覆盖乐观锁**（`TODO-2a188191`，web/sync）
  独立于上面两条，改动小，可先做。
  push 是用户主动发起的操作，等同 force push，默认覆盖而不再被 `version` 挡住。
  服务端已经支持：`POST /api/room/<name>/state` 请求体不带 `version` 即为强制覆盖，**无需改服务端**。
  前端改动是推送时不带 `version`；服务端版本领先于本地基线时给一次性警告，
  用户确认后照推。乐观锁保留给自动路径兜底并发写入。

- [ ] **bootstrapPull 停止无条件覆盖本地**（`TODO-786a225c`，web/data-loss，依赖 `TODO-ff3a66e8`）
  `bootstrapPull` 现在直接 `store.replaceState(remote)`。今天只是覆盖了空状态所以无碍，
  但按目标架构允许本地编辑之后，这就是一条实实在在的丢数据路径。
  需先判断本地是否存在未同步改动，有则不能静默覆盖。

- [ ] **dist 可双击打开**（`TODO-bcb78b27`，web/build）
  `dist/index.html` 用的是 `<script type="module">`，主流浏览器在 `file://` 下
  都会以 CORS 为由拒绝加载，所以 README 里「双击 file:// 打开」的说法不成立。
  二选一：改出单文件内联构建（脚本内联进 HTML，真正可双击），或如实改文档去掉该说法。
  注意与 `TODO-bf7146b6`（CORS 收紧）相关：白名单要处理 `file://` 下来源为 `null` 的 preflight。

- [ ] **QQ Bot 示例脚本**（`TODO-22c3f83c`，bot/example）
  命令解析脚本（`/clock 2/4 名字`、`/clock show`、`/clock list`），调 API 的参考实现。
  当前已有 curl / Python（requests）示例，见 `server/README.md`。
  动工前先跑 `server/api-check.py`（API 契约自检，只读/--full 两档），确认接口形状没漂。

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

- [x] **多场景支持**（`TODO-6d8a3ba3`，web/contract）——被房间机制替代实现
  一个房间 = 一次团（状态按房间隔离），替代契约方案 A（clock 加 `group` 字段）。
  2026-08-29 关闭。
