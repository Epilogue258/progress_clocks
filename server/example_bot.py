#!/usr/bin/env python3
"""progress_clocks 无框架 Bot 示例。

从一段外部输入（命令行参数或 stdin 的一行）读取命令，调房间 API 完成
「读状态 / 写状态 / 导出图」的往返。不依赖任何 Bot 框架：核心逻辑是
handle_command() 这个普通函数，任何框架（QQ、飞书、IRC、cron…）都能
import 它、把收到的文本原样丢进来；main() 只是演示「从命令行 / stdin
读一句输入再交给它」。

命令（消息里的 /clock 前缀可带可不带）：
    clock 2/4 名字     注册 / 更新一个钟：2/4 = 当前填充 / 总格数，名字为剩余文本
    clock list         列出房间所有钟（纯文本）
    clock show         列出所有钟，并把全景导出图存成 PNG（--out 指定路径）

用法：
    python example_bot.py "clock 2/4 守卫" --room 龙与地下城 --key 你的GM密码
    echo "clock show" | python example_bot.py --room 龙与地下城 --join 玩家密码 --out /tmp/钟.png
    任意框架：from example_bot import handle_command; handle_command("clock list", ...)

只用标准库，无需 pip install。写命令需要 GM 密码（--key），读命令有加入密码（--join）即可。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# ---- 契约常量：改这里之前先看 common/types.ts，两边必须一致 ----
SCHEMA_VERSION = 1
CLOCK_MIN_SEGMENTS = 2
CLOCK_MAX_SEGMENTS = 10
DEFAULT_BASE = 'http://localhost:2333'

# `clock 2/4 名字`：接受可选的 /clock 前缀（QQ 消息习惯），名字是剩下的整段
CLOCK_CMD = re.compile(r'^/?clock\s+(\d+)\s*/\s*(\d+)\s+(.+)$')


class ApiError(Exception):
    """服务器明确拒绝（4xx/5xx）。带状态码与响应文本，调用方决定怎么转成人话。"""

    def __init__(self, status: int, text: str):
        super().__init__(f'HTTP {status}: {text[:200]}')
        self.status = status
        self.text = text


def request(
    base: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    payload: object = None,
    timeout: float = 10.0,
) -> tuple[int, bytes]:
    """发一个请求，返回 (状态码, 原始字节)。4xx/5xx 不抛异常，交给调用方判断。"""
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(base.rstrip('/') + path, data=data, method=method)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    # localhost 直连：urllib 默认会读 http_proxy，而代理普遍不认 localhost，会返 502
    host = (urllib.parse.urlsplit(base).hostname or '').lower()
    if host in ('localhost', '127.0.0.1', '::1', ''):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    else:
        opener = urllib.request.build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Room:
    """一台 server 上的一个房间：凭证（加入密码读、GM 密码写）一次配好，命令只管调用。"""

    def __init__(self, base: str, name: str, join: str = '', key: str = ''):
        self.base = base
        self.qname = urllib.parse.quote(name, safe='')
        self.join = join or None  # 空 = 公开房间，不带读凭证
        self.key = key

    def fetch(self) -> dict:
        status, body = request(self.base, 'GET', f'/api/room/{self.qname}/state', token=self.join)
        if status != 200:
            raise ApiError(status, body.decode('utf-8', 'replace'))
        return json.loads(body)

    def save(self, state: dict) -> dict:
        """带 version 写（乐观锁）：409 时服务端不回最新状态，由调用方提示重试。"""
        if not self.key:
            raise ApiError(401, '写命令需要 GM 密码（--key）')
        status, body = request(self.base, 'POST', f'/api/room/{self.qname}/state',
                               token=self.key, payload=state)
        if status != 200:
            raise ApiError(status, body.decode('utf-8', 'replace'))
        return json.loads(body)

    def export_png(self, out: str) -> None:
        status, body = request(self.base, 'GET', f'/api/room/{self.qname}/export.png', token=self.join)
        if status != 200:
            raise ApiError(status, body.decode('utf-8', 'replace'))
        with open(out, 'wb') as f:
            f.write(body)


def _fmt(state: dict) -> list[str]:
    """把状态渲染成多行文本，list 与 show 共用。"""
    clocks = state.get('clocks') or {}
    if not clocks:
        return ['（房间里还没有钟）']
    lines = []
    for cid, c in clocks.items():
        label = cid if cid != c.get('name') else c.get('name', cid)
        lines.append(f'{label}  {c.get("fill", 0)}/{c.get("max", 0)}')
    return lines


def handle_command(command: str, *, base: str = DEFAULT_BASE, room: str, join: str = '', key: str = '',
                   out: str = 'progress-clocks.png') -> tuple[bool, str]:
    """处理一句命令，返回 (是否成功, 给人看的消息)。任何框架 import 后把消息文本丢进来即可。"""
    text = command.strip()
    if not room:
        return False, '缺少房间名（--room）'
    # Bearer 鉴权头只支持 ASCII——中文 / emoji 密码连 Web 端都发不出去，这里也直接拦下，
    # 免得 urllib 在组头时抛 UnicodeEncodeError（一段看不懂的 traceback）
    for label, value in (('加入密码', join), ('GM 密码', key)):
        if value and not value.isascii():
            return False, f'{label}含非 ASCII 字符：Bearer 鉴权头只支持 ASCII，请换纯英文/数字密码'
    r = Room(base, room, join, key)
    try:
        m = CLOCK_CMD.match(text)
        if m:
            fill, max_seg, name = int(m.group(1)), int(m.group(2)), m.group(3).strip()
            if not (CLOCK_MIN_SEGMENTS <= max_seg <= CLOCK_MAX_SEGMENTS):
                return False, f'格数应在 {CLOCK_MIN_SEGMENTS}-{CLOCK_MAX_SEGMENTS}（实际 {max_seg}）'
            if not (0 <= fill <= max_seg):
                return False, f'填充应在 0-{max_seg}（实际 {fill}）'
            state = r.fetch()
            # 用名字定位钟：同名更新，没有就新建（id 直接用名字，契约要求 id 与键一致）
            cid = next((k for k, c in state['clocks'].items() if c.get('name') == name), None)
            clock = {'id': cid or name, 'name': name, 'max': max_seg, 'fill': fill}
            if cid is None:
                state['clocks'][name] = clock
                verb = '已注册'
            else:
                state['clocks'][cid].update(clock)
                verb = '已更新'
            r.save(state)
            return True, f'{verb}：{name}  {fill}/{max_seg}'
        if text == 'clock list':
            return True, '\n'.join(_fmt(r.fetch()))
        if text == 'clock show':
            lines = _fmt(r.fetch())
            r.export_png(out)
            return True, '\n'.join(lines) + f'\n（全景图已存 {out}）'
        return False, f'看不懂这条命令：{text!r}（试试 clock 2/4 名字 / clock list / clock show）'
    except ApiError as e:
        if e.status == 401:
            return False, '凭证不对：加入密码错误或写命令缺 GM 密码'
        if e.status == 404:
            return False, '房间不存在（或服务端还没建它）'
        if e.status == 409:
            return False, '写冲突：房间刚被改过，重试一次即可（本示例按「先读再改再写」走乐观锁）'
        return False, f'API 报错 {e}'
    except (urllib.error.URLError, OSError) as e:
        return False, f'连不上服务器：{e}'


def main() -> int:
    p = argparse.ArgumentParser(description='progress_clocks 无框架 Bot 示例')
    p.add_argument('command', nargs='?', help='命令文本；不传则从 stdin 读一行')
    p.add_argument('--base', default=DEFAULT_BASE, help=f'服务器地址（默认 {DEFAULT_BASE}）')
    p.add_argument('--room', default='', help='房间名（必填）')
    p.add_argument('--join', default='', help='加入密码（公开房间可省略）')
    p.add_argument('--key', default='', help='GM 密码（写命令需要）')
    p.add_argument('--out', default='progress-clocks.png', help='clock show 的 PNG 保存路径')
    args = p.parse_args()

    command = args.command
    if command is None:
        line = sys.stdin.readline()
        if not line:
            p.print_usage()
            return 1
        command = line.strip()
    ok, msg = handle_command(command, base=args.base, room=args.room, join=args.join,
                             key=args.key, out=args.out)
    print(msg)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
