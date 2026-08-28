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
| GET | `/api/state` | 完整状态 JSON（玩家轮询 / GM 拉取 / 外部插件读取） |
| POST | `/api/state` | 全量覆盖保存（请求体为完整状态 JSON，自动校验容错） |
| GET | `/api/export.png` | 整张导出图 PNG（QQ Bot 等外部插件调用） |
| GET | `/api/export.svg` | 导出图 SVG（调试用） |
| GET | `/*` | 静态托管 `Web/dist` 构建产物 |

- CORS 全开（`Access-Control-Allow-Origin: *`），方便独立部署的 Web 端跨域调用
- 单写者模型（GM 端全量覆盖），无冲突处理；写鉴权未实现，公网暴露请自加反向代理
- PNG 渲染依赖 `@resvg/resvg-js`（预编译，无需原生编译）

## 外部插件示例（如 QQ Bot）

```bash
# 读取当前状态
curl http://服务器:2333/api/state

# 提交状态（全量覆盖）
curl -X POST http://服务器:2333/api/state \
  -H "Content-Type: application/json" \
  --data-binary @state.json

# 导出图片（直接下载发群）
curl -o clock.png http://服务器:2333/api/export.png
```

```python
# Python（常见 Bot 框架场景）
import requests

BASE = 'http://服务器:2333'

state = requests.get(f'{BASE}/api/state').json()           # 读
img = requests.get(f'{BASE}/api/export.png').content       # 生成图片发群

state['clocks']['new-1'] = {'id': 'new-1', 'name': '警报', 'max': 4, 'fill': 1}
requests.post(f'{BASE}/api/state', json=state)             # 写
```

## 部署注意事项

- **中文字体**：Linux 服务器需安装中文字体（如 `fonts-noto-cjk`），否则导出图中文渲染成方块：
  ```bash
  apt install fonts-noto-cjk
  ```
- **公网暴露**：直接对公网开放时建议加反向代理（Caddy / Nginx）+ 鉴权，或仅暴露在 Tailscale / 局域网
