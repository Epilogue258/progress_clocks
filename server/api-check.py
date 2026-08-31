#!/usr/bin/env python3
"""progress_clocks API 契约自检脚本。

在写 QQ Bot（或任何外部插件）之前，先确认目标 server 的 API 表面是活的，
且返回的形状符合 common/types.ts 的契约。

默认只读：只发 GET，外加一次「带过期 version 的 POST」——版本不匹配会被
服务端拒绝（409），所以不会改动任何状态，可以直接对线上房间跑。

写往返、房间生命周期、1MB 体积上限这些会改数据的检查，一律收进 --full，
且在脚本自建的临时房间里做，测完删掉。默认房间和用户已有的房间不会被碰。

只用标准库，无需 pip install。

用法：
    python api-check.py                                  # 本机默认 2333
    python api-check.py --base http://服务器:2333
    python api-check.py --base http://服务器:2333 --key 你的GM密钥
    python api-check.py --full                           # 含写往返（临时房间）
    python api-check.py --full --join-pwd 123            # 顺带验证加入密码读锁

退出码：0 = 无失败项，1 = 有失败项，2 = 连不上服务器。
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---- 契约常量：改这里之前先看 common/types.ts，两边必须一致 ----
SCHEMA_VERSION = 1
CLOCK_MIN_SEGMENTS = 2
CLOCK_MAX_SEGMENTS = 10
MAX_BODY_BYTES = 1 * 1024 * 1024  # server/src/index.ts: MAX_BODY
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
DEFAULT_BASE = 'http://localhost:2333'

PASS, FAIL, SKIP, WARN = 'PASS', 'FAIL', 'SKIP', 'WARN'


def is_int(value: object) -> bool:
    """bool 是 int 的子类，契约里的数字字段不该接受 true/false"""
    return isinstance(value, int) and not isinstance(value, bool)


class Response:
    """urllib 的返回值包装：4xx/5xx 不抛异常，交给调用方按状态码判断"""

    def __init__(self, status: int, body: bytes, headers: dict):
        self.status = status
        self.body = body
        self.headers = {k.lower(): v for k, v in headers.items()}

    @property
    def text(self) -> str:
        return self.body.decode('utf-8', 'replace')

    @property
    def ctype(self) -> str:
        return (self.headers.get('content-type') or '').split(';')[0].strip().lower()

    def json(self):
        try:
            return json.loads(self.body)
        except Exception:
            return None


_opener: urllib.request.OpenerDirector | None = None


def configure_http(base: str, no_proxy: bool) -> None:
    """决定要不要走环境里的 HTTP_PROXY。

    坑点：urllib 默认读 http_proxy 环境变量，而这类代理基本都不认 localhost，
    结果就是本机服务被代理拦掉、返回 502，看起来像「服务器挂了」。
    localhost 一律直连；远程地址尊重环境配置，需要绕开就加 --no-proxy。
    """
    global _opener
    host = (urllib.parse.urlsplit(base).hostname or '').lower()
    if no_proxy or host in ('localhost', '127.0.0.1', '::1', ''):
        _opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    else:
        _opener = urllib.request.build_opener()


def request(
    base: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    payload: object = None,
    raw: bytes | None = None,
    timeout: float = 10.0,
) -> Response:
    """发一个请求。payload 会自动序列化为 JSON；raw 用于发非 JSON 的原始字节（测体积上限）。"""
    data: bytes | None = None
    if raw is not None:
        data = raw
    elif payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')

    req = urllib.request.Request(base.rstrip('/') + path, data=data, method=method)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    opener = _opener or urllib.request.build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            return Response(resp.status, resp.read(), dict(resp.headers))
    except urllib.error.HTTPError as e:
        return Response(e.code, e.read(), dict(e.headers))
    except http.client.RemoteDisconnected:
        # 请求体还没发完连接就被服务端掐断（历史 bug：超限时 pause 后回 413 会触发）。
        # 折叠成 status=-1，让上层按 FAIL 统计而不是整个脚本 traceback 崩掉
        return Response(-1, b'<connection dropped>', {})


class Report:
    """逐条打印检查结果，末尾汇总。FAIL 才影响退出码，WARN/SKIP 不影响。"""

    def __init__(self, verbose: bool = False):
        self.counts = {PASS: 0, FAIL: 0, SKIP: 0, WARN: 0}
        self.verbose = verbose

    def add(self, name: str, status: str, detail: str = '') -> None:
        self.counts[status] += 1
        line = f'  [{status}] {name}'
        if detail:
            line += f'  —— {detail}'
        print(line)

    def expect(self, name: str, ok: bool, detail: str = '') -> bool:
        self.add(name, PASS if ok else FAIL, detail)
        return ok

    def skip(self, name: str, why: str) -> None:
        self.add(name, SKIP, why)

    def warn(self, name: str, why: str) -> None:
        self.add(name, WARN, why)

    def section(self, title: str) -> None:
        print(f'\n{title}')


def state_shape_errors(state: object) -> list[str]:
    """按 common/types.ts 的 ClockState 校验形状，返回问题列表（空 = 合规）"""
    if not isinstance(state, dict):
        return ['响应不是 JSON 对象']
    errs: list[str] = []
    if not is_int(state.get('schemaVersion')):
        errs.append('schemaVersion 不是整数')
    if not is_int(state.get('version')):
        errs.append('version 不是整数')
    clocks = state.get('clocks')
    if not isinstance(clocks, dict):
        return errs + ['clocks 不是对象']
    for key, clock in clocks.items():
        if not isinstance(clock, dict):
            errs.append(f'clocks["{key}"] 不是对象')
            continue
        # parseState 用 key 作为 id 回填，所以两者必须相等
        if clock.get('id') != key:
            errs.append(f'clocks["{key}"].id 与键名不一致')
        if not isinstance(clock.get('name'), str):
            errs.append(f'clocks["{key}"].name 不是字符串')
        mx = clock.get('max')
        if not is_int(mx) or not (CLOCK_MIN_SEGMENTS <= mx <= CLOCK_MAX_SEGMENTS):
            errs.append(f'clocks["{key}"].max 越界（应为 {CLOCK_MIN_SEGMENTS}-{CLOCK_MAX_SEGMENTS}）')
            continue
        fill = clock.get('fill')
        if not is_int(fill) or not (0 <= fill <= mx):
            errs.append(f'clocks["{key}"].fill 不在 [0, max] 内')
    return errs


def check_state(rep: Report, resp: Response, label: str):
    """校验一个状态响应：200 + 合法 JSON + 契约形状。返回解析后的状态或 None"""
    if not rep.expect(f'{label} 返回 200', resp.status == 200, f'实际 {resp.status}'):
        return None
    data = resp.json()
    if data is None:
        rep.add(f'{label} 返回合法 JSON', FAIL)
        return None
    errs = state_shape_errors(data)
    rep.expect(f'{label} 符合契约形状', not errs, '；'.join(errs[:3]))
    return data


def check_export(rep: Report, base: str, path: str, kind: str, timeout: float, token: str | None = None) -> None:
    resp = request(base, 'GET', path, token=token, timeout=timeout)
    label = f'GET {path}'
    if not rep.expect(f'{label} 返回 200', resp.status == 200, f'实际 {resp.status}'):
        return
    if kind == 'svg':
        rep.expect(f'{label} Content-Type', resp.ctype == 'image/svg+xml', resp.ctype or '(空)')
        head = resp.text.lstrip()[:40].replace('\n', ' ')
        rep.expect(f'{label} 内容是 SVG', head.startswith('<svg'), head)
    else:
        rep.expect(f'{label} Content-Type', resp.ctype == 'image/png', resp.ctype or '(空)')
        rep.expect(f'{label} PNG 魔数正确', resp.body.startswith(PNG_MAGIC), f'{len(resp.body)} 字节')
        if len(resp.body) == 0:
            rep.warn(f'{label} 内容为空', '导出图 0 字节（空状态也可能正常，但值得看一眼）')


def check_rooms_list(rep: Report, base: str, timeout: float) -> None:
    resp = request(base, 'GET', '/api/rooms', timeout=timeout)
    if not rep.expect('GET /api/rooms 返回 200', resp.status == 200, f'实际 {resp.status}'):
        return
    data = resp.json()
    rooms = data.get('rooms') if isinstance(data, dict) else None
    rep.expect(
        'GET /api/rooms 返回字符串数组',
        isinstance(rooms, list) and all(isinstance(r, str) for r in rooms),
        f'{len(rooms) if isinstance(rooms, list) else "?"} 个房间',
    )


def check_auth(rep: Report, base: str, key: str, timeout: float) -> bool:
    """探测鉴权模式。返回「无密钥时是否可写」——决定后续哪些检查能做。"""
    anon = request(base, 'GET', '/api/auth-check', timeout=timeout)
    if anon.status == 200:
        rep.warn('服务端未设置 GM_KEY', '写接口完全开放；公网暴露前务必设 GM_KEY')
        return True
    if anon.status == 401:
        rep.expect('未带密钥时 auth-check 返回 401', True, '写鉴权已启用')
        if not key:
            rep.skip('带密钥的 auth-check', '未通过 --key 或环境变量 GM_KEY 提供密钥')
            return False
        authed = request(base, 'GET', '/api/auth-check', token=key, timeout=timeout)
        rep.expect('带 --key 的 auth-check 返回 200', authed.status == 200,
                   f'实际 {authed.status}（密钥不对？）')
        if authed.status != 200:
            # 补一次必然错误的请求，用来区分「密钥不对」和「接口本身坏了」
            bad = request(base, 'GET', '/api/auth-check', token=key + 'x', timeout=timeout)
            rep.expect('带错误密钥的 auth-check 返回 401', bad.status == 401, f'实际 {bad.status}')
        return authed.status == 200
    rep.add('GET /api/auth-check', FAIL, f'未预期的状态码 {anon.status}')
    return False


def check_missing_room(rep: Report, base: str, timeout: float) -> None:
    name = f'apicheck-missing-{int(time.time())}'
    resp = request(base, 'GET', f'/api/room/{urllib.parse.quote(name, safe="")}/state', timeout=timeout)
    rep.expect('不存在的房间返回 404', resp.status == 404, f'实际 {resp.status}')


def check_static(rep: Report, base: str, timeout: float) -> None:
    resp = request(base, 'GET', '/', timeout=timeout)
    if resp.status == 200:
        rep.expect('GET / 返回 HTML', 'html' in resp.ctype, resp.ctype or '(空)')
    elif resp.status == 404:
        rep.warn('GET / 返回 404', 'Web/dist 未构建，静态托管无内容（不影响 API）')
    else:
        rep.add('GET /', FAIL, f'未预期的状态码 {resp.status}')


def probe_state(version: int, clocks: dict) -> dict:
    """构造一份最小合法状态，用于写往返"""
    return {
        'schemaVersion': SCHEMA_VERSION,
        'version': version,
        'clocks': clocks,
    }


def room_lifecycle(rep: Report, base: str, args) -> None:
    """在自建临时房间里跑完整生命周期；失败也保证只删自己建的房间。"""
    rep.section('房间生命周期（临时房间，测完删除）')
    name = args.room or f'apicheck-中文-{int(time.time())}'  # 中文名顺带验证 URL 编码
    gm_pwd = args.gm_pwd or secrets.token_urlsafe(9)
    join_pwd = args.join_pwd or ''
    qname = urllib.parse.quote(name, safe='')

    created = request(
        base, 'POST', '/api/rooms',
        payload={'name': name, 'joinPwd': join_pwd, 'gmPwd': gm_pwd},
        timeout=args.timeout,
    )
    if created.status == 409:
        # 房间已存在：绝不接着往下测。后面的 DELETE 会删掉别人的房间。
        rep.skip('房间生命周期', f'房间「{name}」已存在，用 --room 换个不冲突的名字重试（不会删除已有房间）')
        return
    if not rep.expect('POST /api/rooms 新建成功', created.status == 200, f'{created.status} {created.text[:120]}'):
        return

    try:
        state_url = f'/api/room/{qname}/state'
        # 读（含导出图）统一带加入密码。房间设了 joinPwd 却空手读，只会拿到 401
        read_token = join_pwd or None

        # 新房间应当是空的、version 为 0
        data = check_state(rep, request(base, 'GET', state_url, token=read_token, timeout=args.timeout),
                           'GET 新房间状态')
        if data is not None:
            rep.expect('新房间为空且 version=0', data.get('version') == 0 and data.get('clocks') == {},
                       f"version={data.get('version')}")

        # 写锁：gmPwd 验证
        ok = request(base, 'GET', f'/api/room/{qname}/auth-check', token=gm_pwd, timeout=args.timeout)
        rep.expect('GM 密码 auth-check 返回 200', ok.status == 200, f'实际 {ok.status}')
        bad = request(base, 'GET', f'/api/room/{qname}/auth-check', token=gm_pwd + 'x', timeout=args.timeout)
        rep.expect('错误 GM 密码 auth-check 返回 401', bad.status == 401, f'实际 {bad.status}')

        # 读锁：joinPwd 非空时未带密码应 401
        if join_pwd:
            anon = request(base, 'GET', state_url, timeout=args.timeout)
            rep.expect('未带加入密码读房间返回 401', anon.status == 401, f'实际 {anon.status}')
            good = request(base, 'GET', state_url, token=join_pwd, timeout=args.timeout)
            rep.expect('带加入密码读房间返回 200', good.status == 200, f'实际 {good.status}')
        else:
            rep.skip('加入密码读锁', '临时房间为公开只读（要测读锁请加 --join-pwd）')

        # 未授权写应被拒
        denied = request(base, 'POST', state_url, token=gm_pwd + 'x',
                         payload=probe_state(0, {}), timeout=args.timeout)
        rep.expect('错误 GM 密码写入返回 401', denied.status == 401, f'实际 {denied.status}')

        # 乐观锁：过期 version 应 409 并带回最新状态
        stale = request(base, 'POST', state_url, token=gm_pwd,
                        payload=probe_state(999999, {}), timeout=args.timeout)
        if rep.expect('过期 version 写入返回 409', stale.status == 409, f'实际 {stale.status}'):
            stale_json = stale.json()
            has_state = isinstance(stale_json, dict) and 'state' in stale_json
            rep.expect('409 响应带回最新状态', has_state,
                       '' if has_state else '缺少 state 字段，客户端无法合并重试')

        # 正常写入往返
        clock = {'id': 'probe-1', 'name': '自检钟', 'max': 4, 'fill': 2}
        saved = request(base, 'POST', state_url, token=gm_pwd,
                        payload=probe_state(0, {'probe-1': clock}), timeout=args.timeout)
        if rep.expect('带正确 version 写入返回 200', saved.status == 200, f'{saved.status} {saved.text[:120]}'):
            rep.expect('写入后 version 递增为 1', (saved.json() or {}).get('version') == 1,
                       f"实际 {(saved.json() or {}).get('version')}")

        back = check_state(rep, request(base, 'GET', state_url, token=read_token, timeout=args.timeout),
                           'GET 回读写入结果')
        if back is not None:
            c = (back.get('clocks') or {}).get('probe-1')
            matched = isinstance(c, dict) and c.get('fill') == 2 and c.get('max') == 4 and c.get('name') == '自检钟'
            rep.expect('回读内容一致（fill/max/name）', matched,
                       '' if matched else (json.dumps(c, ensure_ascii=False) if c else '钟丢失'))

        # 导出图放在清空之前：这时房间里有一个钟，验的是「有内容」的渲染路径
        check_export(rep, base, f'/api/room/{qname}/export.svg', 'svg', args.timeout, read_token)
        check_export(rep, base, f'/api/room/{qname}/export.png', 'png', args.timeout, read_token)

        # 省略 version = 强制覆盖（Bot 常用姿势）
        forced = request(base, 'POST', state_url, token=gm_pwd,
                         payload={'schemaVersion': SCHEMA_VERSION, 'clocks': {}}, timeout=args.timeout)
        if rep.expect('省略 version 写入（强制覆盖）返回 200', forced.status == 200, f'实际 {forced.status}'):
            after = request(base, 'GET', state_url, token=read_token, timeout=args.timeout).json() or {}
            rep.expect('强制覆盖真的清空了 clocks', after.get('clocks') == {},
                       json.dumps(after.get('clocks'), ensure_ascii=False)[:80])

        # 体积上限：1MB + 1 字节应 413（body 读取在鉴权之后，所以这里带了 GM 密码）
        huge = request(base, 'POST', state_url, token=gm_pwd,
                       raw=b'x' * (MAX_BODY_BYTES + 1), timeout=max(args.timeout, 30))
        rep.expect(f'超过 {MAX_BODY_BYTES // 1024 // 1024}MB 的请求体返回 413', huge.status == 413,
                   f'实际 {huge.status}')

        # ---- 改密码（PATCH /api/room/<name>，对外 API，需 GM 密码） ----
        patch_url = f'/api/room/{qname}'
        # 未授权 / 空 patch / 弱 GM 密码应被拒
        bad_patch = request(base, 'PATCH', patch_url, token=gm_pwd + 'x',
                            payload={'joinPwd': 'hacked'}, timeout=args.timeout)
        rep.expect('错误 GM 密码改密码返回 401', bad_patch.status == 401, f'实际 {bad_patch.status}')
        empty_patch = request(base, 'PATCH', patch_url, token=gm_pwd,
                              payload={}, timeout=args.timeout)
        rep.expect('空字段改密码返回 400', empty_patch.status == 400, f'实际 {empty_patch.status}')
        weak_patch = request(base, 'PATCH', patch_url, token=gm_pwd,
                             payload={'gmPwd': '123'}, timeout=args.timeout)
        rep.expect('弱 GM 密码改密返回 400', weak_patch.status == 400, f'实际 {weak_patch.status}')

        # 改加入密码：只改 joinPwd，gmPwd 保持；新密码立即生效、旧密码失效
        new_join = (join_pwd or 'read') + '-v2'
        patched = request(base, 'PATCH', patch_url, token=gm_pwd,
                          payload={'joinPwd': new_join}, timeout=args.timeout)
        if rep.expect('PATCH 改加入密码返回 200', patched.status == 200, f'{patched.status} {patched.text[:120]}'):
            room = (patched.json() or {}).get('room') or {}
            rep.expect('响应回显新 joinPwd', room.get('joinPwd') == new_join, f"实际 {room.get('joinPwd')!r}")
            rep.expect('新加入密码可读', request(base, 'GET', state_url, token=new_join,
                                            timeout=args.timeout).status == 200, '')
            if join_pwd:
                rep.expect('旧加入密码失效（401）', request(base, 'GET', state_url, token=join_pwd,
                                                        timeout=args.timeout).status == 401, '')
            join_pwd = new_join
            read_token = new_join or None

        # 改 GM 密码：新密码立即生效、旧密码失效；后续清理用新密码
        new_gm = gm_pwd + '-v2'
        patched2 = request(base, 'PATCH', patch_url, token=gm_pwd,
                           payload={'gmPwd': new_gm}, timeout=args.timeout)
        if rep.expect('PATCH 改 GM 密码返回 200', patched2.status == 200, f'{patched2.status} {patched2.text[:120]}'):
            old_auth = request(base, 'GET', f'/api/room/{qname}/auth-check', token=gm_pwd, timeout=args.timeout)
            rep.expect('旧 GM 密码失效（401）', old_auth.status == 401, f'实际 {old_auth.status}')
            new_auth = request(base, 'GET', f'/api/room/{qname}/auth-check', token=new_gm, timeout=args.timeout)
            rep.expect('新 GM 密码可验证（200）', new_auth.status == 200, f'实际 {new_auth.status}')
            gm_pwd = new_gm
    finally:
        deleted = request(base, 'DELETE', f'/api/room/{qname}', token=gm_pwd, timeout=args.timeout)
        rep.expect('清理临时房间', deleted.status == 200, f'实际 {deleted.status}')
        gone = request(base, 'GET', f'/api/room/{qname}/state', timeout=args.timeout)
        rep.expect('删除后房间不可访问（404）', gone.status == 404, f'实际 {gone.status}')


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description='progress_clocks API 契约自检',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='默认只读，可直接对线上服务器跑；改数据的检查需 --full。',
    )
    p.add_argument('--base', default=os.environ.get('PROGRESS_CLOCKS_BASE', DEFAULT_BASE),
                   help=f'服务器地址（默认 {DEFAULT_BASE}）')
    p.add_argument('--key', default=os.environ.get('GM_KEY', ''),
                   help='默认房间的 GM 密钥（默认读环境变量 GM_KEY）')
    p.add_argument('--full', action='store_true',
                   help='额外跑写往返 / 房间生命周期 / 体积上限（在自建临时房间内，测完删除）')
    p.add_argument('--room', help='临时房间名（默认自动生成带中文的名字，顺带验证 URL 编码）')
    p.add_argument('--gm-pwd', help='临时房间的 GM 密码（默认随机；≥6 位）')
    p.add_argument('--join-pwd', default='', help='临时房间的加入密码（默认空 = 公开只读）')
    p.add_argument('--timeout', type=float, default=10.0, help='单个请求超时秒数（默认 10）')
    p.add_argument('--no-proxy', action='store_true',
                   help='忽略环境变量里的 HTTP(S)_PROXY（访问 localhost 时本来就会自动忽略）')
    p.add_argument('-v', '--verbose', action='store_true', help='打印状态摘要')
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.full and args.gm_pwd and len(args.gm_pwd) < 6:
        print('--gm-pwd 至少 6 位（服务端要求）')
        return 2

    base = args.base.rstrip('/')
    configure_http(base, args.no_proxy)
    rep = Report()
    print(f'progress_clocks API 自检 —— {base}')
    print(f'模式：{"完整（含写往返）" if args.full else "只读"}')

    # 连通性：连不上就没必要继续了
    try:
        first = request(base, 'GET', '/api/state', timeout=args.timeout)
    except urllib.error.URLError as e:
        print(f'\n连不上 {base}：{e.reason}')
        print('确认服务已启动（server 目录 npm start），或换 --base 指向正确的地址。')
        print('若本机服务返回了代理的错误页，说明 http_proxy 拦了 localhost，加 --no-proxy 重试。')
        return 2
    except OSError as e:
        print(f'\n请求失败：{e}')
        return 2

    rep.section('状态契约')
    state = check_state(rep, first, 'GET /api/state')
    if state is not None and rep.verbose:
        print(f'        version={state.get("version")} 钟数={len(state.get("clocks") or {})}')

    rep.section('鉴权')
    authed = check_auth(rep, base, args.key, timeout=args.timeout)

    rep.section('导出与房间列表')
    check_export(rep, base, '/api/export.svg', 'svg', args.timeout)
    check_export(rep, base, '/api/export.png', 'png', args.timeout)
    check_rooms_list(rep, base, args.timeout)

    rep.section('边界与静态托管')
    check_missing_room(rep, base, args.timeout)
    check_static(rep, base, args.timeout)
    if authed:
        huge = request(base, 'POST', '/api/state', token=args.key or None,
                       raw=b'x' * (MAX_BODY_BYTES + 1), timeout=max(args.timeout, 30))
        rep.expect(f'超过 {MAX_BODY_BYTES // 1024 // 1024}MB 的请求体返回 413', huge.status == 413,
                   f'实际 {huge.status}')
    else:
        rep.skip('体积上限（413）', '写鉴权未通过，无法探测（先提供正确的 --key）')

    if args.full:
        room_lifecycle(rep, base, args)
    else:
        rep.section('写往返与房间生命周期')
        rep.skip('全部跳过', '加 --full 才会跑（会自建临时房间，不碰默认房间和已有房间）')

    c = rep.counts
    print('\n' + '─' * 46)
    print(f'通过 {c[PASS]}  失败 {c[FAIL]}  跳过 {c[SKIP]}  提醒 {c[WARN]}')
    if c[FAIL]:
        print('有失败项：上面 [FAIL] 的行即为不符合契约之处。')
        return 1
    print('API 可用，可以照着这个契约写 Bot 了。')
    return 0


if __name__ == '__main__':
    # Windows 控制台可能是 GBK，直接打印中文有概率抛 UnicodeEncodeError
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    sys.exit(main())
