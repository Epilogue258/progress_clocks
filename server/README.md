# server（Node 后端，零框架）

状态存储 + 图片导出 API + Web 静态托管，单进程单文件部署。

## 运行

```bash
# 先构建 Web 前端（产物在 Web/dist，由本服务托管）
cd ../Web && npm run build

# 启动（Node 24+，原生运行 TypeScript，无需编译）
cd ../server && npm install && npm start
# 开发模式（文件变更自动重启）：npm run dev
```

默认端口 2333（环境变量 `PORT` 可改）。数据文件：`data/state.json`（原子写入，运行时生成，已 gitignore）。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 完整状态 JSON（公开，玩家/外部插件读取） |
| POST | `/api/state` | 全量覆盖保存（需鉴权；带 version 走乐观锁） |
| GET | `/api/auth-check` | GM 密钥验证（登录用） |
| GET | `/api/export.png` | 整张导出图 PNG（QQ Bot 直接下载发群） |
| GET | `/api/export.svg` | 导出图 SVG（调试用） |
| GET | `/*` | 静态托管 `Web/dist` 构建产物 |

- CORS 全开（`Access-Control-Allow-Origin: *`），方便独立部署的 Web 端跨域调用
- PNG 渲染依赖 `@resvg/resvg-js`（预编译，无需原生编译）

## 鉴权与多写

- **写鉴权**：设置环境变量 `GM_KEY` 后，`POST /api/state` 要求请求头 `Authorization: Bearer <GM_KEY>`，否则 401。不设置则不鉴权（仅限开发/局域网信任环境）。
- **乐观锁**：状态带 `version`，每次写入 +1。客户端 POST 时携带自己看到的 version；与服务器不一致返回 `409` + 最新状态，客户端拉取合并后重试（Web 端自动处理）。不带 version = 强制覆盖（兼容旧客户端 / 简化 Bot 调用）。

```bash
# 启动（带鉴权）
GM_KEY=你的密钥 npm start
# 不带鉴权（开发用）
npm start
```

## 外部插件示例（如 QQ Bot）

```bash
# 读取当前状态（公开）
curl http://服务器:2333/api/state

# 提交状态（需 GM 密钥；带 version 走乐观锁，可省略强制覆盖）
curl -X POST http://服务器:2333/api/state \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的密钥" \
  --data-binary @state.json

# 导出图片（公开，直接下载发群）
curl -o clock.png http://服务器:2333/api/export.png
```

```python
# Python（常见 Bot 框架场景）
import requests

BASE = 'http://服务器:2333'
KEY = '你的密钥'
H = {'Authorization': f'Bearer {KEY}'}

state = requests.get(f'{BASE}/api/state').json()                 # 读（公开）
img = requests.get(f'{BASE}/api/export.png').content            # 生成图片发群

state['clocks']['new-1'] = {'id': 'new-1', 'name': '警报', 'max': 4, 'fill': 1}
requests.post(f'{BASE}/api/state', json=state, headers=H)       # 写（需密钥）
```

## 部署注意事项

- **中文字体**：Linux 服务器需安装中文字体（如 `fonts-noto-cjk`），否则导出图中文渲染成方块：
  ```bash
  apt install fonts-noto-cjk
  ```
- **公网暴露**：直接对公网开放时建议加反向代理（Caddy / Nginx）+ 鉴权，或仅暴露在 Tailscale / 局域网
