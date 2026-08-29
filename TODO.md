# TODO —— progress_clocks

> 仅本仓库相关项。根目录 `README.md` 的「待办任务」一节是这里的摘要，
> 增删条目时两边一起改。

## Open

- [ ] **QQ Bot 示例脚本**（`TODO-22c3f83c`，bot/example）
  命令解析脚本（`/clock 2/4 名字`、`/clock show`、`/clock list`），调 API 的参考实现。
  当前已有 curl / Python（requests）示例，见 `server/README.md`。

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

## Done

- [x] **多场景支持**（`TODO-6d8a3ba3`，web/contract）——被房间机制替代实现
  一个房间 = 一次团（状态按房间隔离），替代契约方案 A（clock 加 `group` 字段）。
  2026-08-29 关闭。
