# progress_clocks

Blades in the Dark 风格进度钟工具：线下跑团（APK）+ 线上跑团（Web）两端的进度钟跟踪。

## 架构

```
本地优先：任何端离线可用（线下无网也 OK），本地 JSON 是主数据
单写者：GM 端是唯一写入者，玩家端只读 -> 零冲突
同步：GM 变更 -> 全量 JSON 推送；玩家 Web 轮询 GET（5s）
```

## 目录

| 目录 | 内容 | 技术栈 |
|------|------|--------|
| `Web/` | 线上主控（GM）+ 只读查看（玩家），同一应用两种角色 | Vite + TypeScript + Canvas，零框架 |
| `Apk/` | 线下主控（平板），本地优先 | Kotlin + Jetpack Compose（minSdk 34） |
| `server/` | Node 单文件后端：状态存储 + 静态托管 | Node 原生 http，零依赖 |

## 统一 JSON 契约（SchemaVersion 1）

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
- 字段命名统一 camelCase（各端序列化时映射）

## 状态

- [x] 骨架：目录结构、JSON 契约、API 客户端、Apk 最小工程
- [x] Web MVP：SVG 画钟（清晰接缝/填充动画）、卡片网格 + 紧凑列表双视图、深浅模式（跟随系统+手动）、撤销/重做（快照栈）、设置面板（改名/格数/填充/颜色/删除）、快捷键（Ctrl+Z/Y/N、数字键 1-3 批量填充）、手机长按/右键设置、?readonly 只读模式、localStorage 持久化
- [ ] Web：接入 server 同步（轮询）、GM/查看角色分离完善
- [ ] Apk：本地持久化、画钟交互
- [ ] server：状态存储 + 静态托管
