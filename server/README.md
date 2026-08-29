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

## API 自检（写插件前先跑一遍）

`api-check.py` 会照着契约把接口打一遍，确认「服务器活着 + 返回的形状对」。
只用标准库，无需 `pip install`。

```bash
python api-check.py                                  # 本机 2333，只读
python api-check.py --base http://服务器:2333 --key 你的GM密钥
python api-check.py --full                           # 含写往返（自建临时房间，测完删除）
python api-check.py --full --join-pwd 123            # 顺带验证加入密码读锁
```

- **默认只读**：只发 GET，外加一次带过期 `version` 的 POST —— 版本不匹配会被服务端
  拒绝（409），不会改动任何状态，可以直接对线上房间跑。
- **`--full` 才改数据**：写往返、房间生命周期、1MB 体积上限全在脚本自建的临时房间里做，
  测完删掉。默认房间和已有房间不会被碰；若目标房间名已存在则整个生命周期跳过，
  **不会删除不是自己建的房间**。
- 退出码：`0` 无失败项 / `1` 有失败项 / `2` 连不上服务器。
- 访问 `localhost` 时自动忽略 `http_proxy`（代理认不出 localhost，会返 502，
  看着像服务器挂了）；远程地址需要绕代理用 `--no-proxy`。

## 部署注意事项

- **中文字体**：Linux 服务器需安装中文字体（如 `fonts-noto-cjk`），否则导出图中文渲染成方块：
  ```bash
  apt install fonts-noto-cjk
  ```
- **公网暴露**：直接对公网开放时建议加反向代理（Caddy / Nginx）+ 鉴权，或仅暴露在 Tailscale / 局域网
