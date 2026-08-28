# progress_clocks

Blades in the Dark 风格进度钟工具：线下跑团（APK）+ 线上跑团（Web）两端，配套 server 提供 JSON 同步与图片导出 API（外部插件如 QQ Bot 可接入）。

## 架构

```
本地优先：任何端离线可用（线下无网也 OK），localStorage 兜底
单写者：GM 端是唯一写入者，玩家端只读 -> 零冲突
同步：GM 变更 -> 防抖 500ms 全量 JSON 推送到 server；玩家 Web 轮询（5s）
外部插件：直接读写 server 的 JSON / 调导出图 API
```

## 目录

| 目录 | 内容 | 技术栈 |
|------|------|--------|
| `common/` | 共享层：JSON 契约、钟图几何、导出图 SVG 生成（三端共用） | TypeScript，平台无关 |
| `Web/` | 线上主控（GM）+ 只读查看（玩家），同一应用两种角色 | Vite + TypeScript + SVG，零框架 |
| `Apk/` | 线下主控（平板），本地优先 | Kotlin + Jetpack Compose（minSdk 34） |
| `server/` | Node 后端：JSON 持久化 + 导出图 API + Web 静态托管 | Node 24 原生 TS，仅 @resvg/resvg-js 一个依赖 |

## 运行

```bash
# 1. 构建并启动 server（自动托管 Web/dist）
cd server && npm install && npm start
# 打开 http://localhost:2333 （?demo 查看示例钟，?readonly 为玩家只读模式）

# 开发 Web 单独调试
cd Web && npm run dev
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 完整状态 JSON |
| POST | `/api/state` | 全量覆盖保存（GM 端 / 外部插件） |
| GET | `/api/export.png` | 整张导出图 PNG（QQ Bot 直接下载发群） |
| GET | `/api/export.svg` | 导出图 SVG |

详见 `server/README.md`。

## 统一 JSON 契约（SchemaVersion 1，定义在 common/types.ts）

```json
{
  "schemaVersion": 1,
  "clocks": {
    "1720000000000-a1b2": {
      "id": "1720000000000-a1b2",
      "name": "斯特朗福德宅邸警戒",
      "max": 4,
      "fill": 3,
      "color": "#e74c3c",
      "linkTo": "1720000000001-c3d4"
    }
  }
}
```

- 扩展规则：新增字段可选，旧版本忽略未知键，天然向后兼容
- 边界：`fill > max` clamp；`linkTo` 指向不存在 id 时忽略（当普通钟渲染）
- 字段命名统一 camelCase

## Web 功能

- SVG 画钟（清晰接缝 / 填充动画）、卡片网格 + 紧凑列表双视图、深浅模式（跟随系统+手动）
- 撤销/重做（快照栈）、快捷键（Ctrl+Z/Y/N、数字键 1-3 批量填充）、手机长按/右键设置
- 新建弹窗（名字 + 4/6/8 格数快速选择）、导出 PNG（离线兜底走浏览器，在线可改用 server API）

## 状态

- [x] 骨架：目录结构、JSON 契约、API 客户端、Apk 最小工程
- [x] Web：画钟渲染、网格/列表视图、深浅模式、撤销/设置面板/快捷键、localStorage
- [x] server：JSON 持久化（原子写）、状态 API、导出图 API（PNG/SVG）、静态托管、CORS
- [x] 共享层：common/（契约、几何、导出 SVG），三端共用
- [ ] Apk：本地持久化、画钟交互（待做）
- [ ] server：写鉴权 / 多场景支持（二期）
