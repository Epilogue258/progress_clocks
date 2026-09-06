/**
 * 同步引擎特征测试：锁住 core/sync.ts 的现有语义，不是验证理想语义。
 * 这些不变式原先只活在注释与作者脑子里（「漏掉这一句轮询永久挡死」式的），现在由测试传承。
 *
 * 运行：npm test（Node 原生 test runner 跑 TS，无框架）。
 * 手法：假时钟（手动推进的定时队列）+ 假网络（手控 resolve/reject 的 deferred 队列）
 * + 假 Store（记录 replaceState / markSynced 调用）——引擎的依赖全部注入，此处零 DOM。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClockState } from '../../../common/types.ts'
import { createEmptyState } from '../../../common/types.ts'
import { ApiError } from '../api.ts'
import { type SyncDeps, SyncEngine, type SyncStore } from './sync.ts'

// ---------- 假件 ----------

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 手动推进的假时钟：schedule 记账，advance 到点依次执行 */
class FakeClock {
  now = 0
  private tasks: { id: number; fn: () => void; at: number }[] = []
  private nextId = 1

  schedule(fn: () => void, ms: number): () => void {
    const id = this.nextId++
    this.tasks.push({ id, fn, at: this.now + ms })
    return () => {
      this.tasks = this.tasks.filter((t) => t.id !== id)
    }
  }

  /** 当前挂起定时的剩余毫秒（升序） */
  get pendingDelays(): number[] {
    return this.tasks.map((t) => t.at - this.now).sort((a, b) => a - b)
  }

  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.tasks = this.tasks.filter((t) => t.id !== due.id)
      this.now = due.at
      due.fn()
    }
    this.now = target
  }
}

/** 假 Store：记录引擎关心的切面（版本、替换次数、markSynced 轨迹） */
class FakeStore implements SyncStore {
  state: ClockState = createEmptyState()
  replaceCalls = 0
  markSyncedVersions: number[] = []
  private listeners = new Set<(kind: 'data' | 'order') => void>()

  subscribe(fn: (kind: 'data' | 'order') => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 模拟一次本地编辑（走引擎订阅的同一条路） */
  emitData(): void {
    for (const fn of this.listeners) fn('data')
  }

  replaceState(next: ClockState): void {
    this.replaceCalls++
    this.state = structuredClone(next)
  }

  markSynced(version: number): void {
    this.markSyncedVersions.push(version)
    this.state.version = version
  }
}

// ---------- 装配 ----------

function harness(overrides?: Partial<Pick<SyncDeps, 'canPush' | 'shouldPoll' | 'room'>>) {
  const store = new FakeStore()
  const clock = new FakeClock()
  const events: string[] = []
  const pendingPulls: Deferred<ClockState>[] = []
  const pendingPushes: Deferred<number>[] = []
  const deps: SyncDeps = {
    room: '测试房',
    joinPwd: '',
    canPush: () => true,
    shouldPoll: () => true,
    pull: () => {
      const d = defer<ClockState>()
      pendingPulls.push(d)
      return d.promise
    },
    push: () => {
      const d = defer<number>()
      pendingPushes.push(d)
      return d.promise
    },
    schedule: (fn, ms) => clock.schedule(fn, ms),
    toast: (msg) => events.push(`toast:${msg}`),
    render: () => events.push('render'),
    promptRejoin: () => events.push('promptRejoin'),
    onCredentialRejected: () => events.push('credentialRejected'),
    ...overrides,
  }
  const sync = new SyncEngine(deps, store)
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return { sync, store, clock, events, pendingPulls, pendingPushes, flush }
}

// ---------- 推送侧 ----------

test('store 数据变更 + canPush：防抖 500ms 后推送一次（连续变更只排一个定时器）', async () => {
  const h = harness()
  h.store.emitData()
  h.store.emitData()
  h.store.emitData()
  assert.deepEqual(h.clock.pendingDelays, [500])
  h.clock.advance(500)
  await h.flush()
  assert.equal(h.pendingPushes.length, 1)
})

test('canPush 为假（本地房间/未登录）：变更不触发推送', async () => {
  const h = harness({ canPush: () => false })
  h.store.emitData()
  h.clock.advance(5000)
  await h.flush()
  assert.equal(h.pendingPushes.length, 0)
  assert.equal(h.sync.dirty, false)
})

test('推送成功：markSynced 记新版本、dirty 清零、退避复位', async () => {
  const h = harness()
  h.store.emitData()
  h.clock.advance(500)
  await h.flush()
  h.pendingPushes[0].resolve(7)
  await h.flush()
  assert.deepEqual(h.store.markSyncedVersions, [7])
  assert.equal(h.sync.dirty, false)
  assert.equal(h.events.includes('toast:已重新连接'), false) // 一直 reachable，恢复提示不该响
})

test('推送网络失败：dirty 保持 + 排一次重试，退避 5s→10s→20s→40s→60s 封顶', async () => {
  const h = harness()
  h.store.emitData()
  h.clock.advance(500)
  await h.flush()
  h.pendingPushes[0].reject(new TypeError('network down'))
  await h.flush()
  assert.equal(h.sync.dirty, true) // 改动不能丢
  assert.deepEqual(h.clock.pendingDelays, [5000])
  for (const expected of [10000, 20000, 40000, 60000, 60000]) {
    h.clock.advance(60000)
    await h.flush()
    h.pendingPushes.at(-1)?.reject(new TypeError('network down'))
    await h.flush()
    assert.deepEqual(h.clock.pendingDelays, [expected])
  }
})

test('推送重试成功：dirty 清零、退避复位回 5s；连败两次后恢复给「已重新连接」反馈', async () => {
  const h = harness({ shouldPoll: () => false }) // GM 端不轮询：connState 只能由推送推导
  h.store.emitData()
  h.clock.advance(500)
  await h.flush()
  // 第一次失败：只消耗「静默快速重试」名额，连接状态仍是 reachable，不提示
  h.pendingPushes[0].reject(new TypeError('network down'))
  await h.flush()
  assert.equal(h.sync.connState, 'reachable')
  // 第二次失败才进「重试中」
  h.clock.advance(5000)
  await h.flush()
  h.pendingPushes.at(-1)?.reject(new TypeError('network down'))
  await h.flush()
  assert.equal(h.sync.connState, 'degraded')
  // 重试成功：dirty 清零 + 一次可见的恢复反馈
  h.clock.advance(10000)
  await h.flush()
  h.pendingPushes.at(-1)?.resolve(3)
  await h.flush()
  assert.equal(h.sync.dirty, false)
  assert.equal(h.sync.connState, 'reachable')
  assert.equal(h.events.includes('toast:已重新连接'), true)
  // 再改一次：新的防抖推送 500ms 后照常发出（引擎没有坏掉）
  h.store.emitData()
  h.clock.advance(500)
  await h.flush()
  assert.equal(h.pendingPushes.length, 4)
})

test('推送 409 且带 latest：采用服务器最新状态 + dirty 清零（保留给带 version 的 Bot）', async () => {
  const h = harness()
  const latest = createEmptyState()
  latest.version = 9
  h.store.emitData()
  h.clock.advance(500)
  await h.flush()
  h.pendingPushes[0].reject(new ApiError(409, '冲突', latest))
  await h.flush()
  assert.equal(h.store.replaceCalls, 1)
  assert.equal(h.store.state.version, 9)
  assert.equal(h.sync.dirty, false)
  assert.equal(h.events.includes('toast:状态已在别处更新，已同步最新'), true)
})

test('推送 409 不带 latest：回源拉取最新', async () => {
  const h = harness()
  h.store.emitData()
  h.clock.advance(500)
  await h.flush()
  h.pendingPushes[0].reject(new ApiError(409, '冲突'))
  await h.flush()
  assert.equal(h.pendingPulls.length, 1)
  const remote = createEmptyState()
  remote.version = 4
  h.pendingPulls[0].resolve(remote)
  await h.flush()
  assert.equal(h.store.state.version, 4)
  assert.equal(h.sync.dirty, false)
})

test('推送 401：清凭证回调触发并重建轮询上下文', async () => {
  const h = harness({ shouldPoll: () => false })
  h.store.emitData()
  h.clock.advance(500)
  await h.flush()
  h.pendingPushes[0].reject(new ApiError(401, '未授权'))
  await h.flush()
  assert.equal(h.events.includes('credentialRejected'), true)
})

test('resetDirty 后待推送的防抖定时触发时不再推（防把空状态推上去）', async () => {
  const h = harness()
  h.store.emitData()
  h.sync.resetDirty()
  h.clock.advance(500)
  await h.flush()
  assert.equal(h.pendingPushes.length, 0)
})

// ---------- 轮询侧 ----------

test('版本相同：跳过 replaceState（不清撤销栈与选中态），也重渲染', async () => {
  const h = harness()
  h.store.state.version = 3
  h.sync.reconfigure() // shouldPoll=true → 开始轮询，立即发一次拉取
  await h.flush()
  assert.equal(h.pendingPulls.length, 1)
  const same = createEmptyState()
  same.version = 3
  h.pendingPulls[0].resolve(same)
  await h.flush()
  assert.equal(h.store.replaceCalls, 0)
  // 正常间隔 5s 后下一次轮询
  assert.deepEqual(h.clock.pendingDelays, [5000])
})

test('版本不同且不 dirty：采用远端', async () => {
  const h = harness()
  h.sync.reconfigure()
  await h.flush()
  const remote = createEmptyState()
  remote.version = 5
  h.pendingPulls[0].resolve(remote)
  await h.flush()
  assert.equal(h.store.replaceCalls, 1)
  assert.equal(h.store.state.version, 5)
})

test('版本不同但本地 dirty：不得覆盖本地改动', async () => {
  const h = harness()
  h.store.emitData() // dirty = true
  h.sync.reconfigure()
  await h.flush()
  const remote = createEmptyState()
  remote.version = 5
  h.pendingPulls[0].resolve(remote)
  await h.flush()
  assert.equal(h.store.replaceCalls, 0)
  assert.equal(h.sync.dirty, true)
})

test('首次轮询失败：静默补一次快速重试（100ms），连接状态仍是 reachable', async () => {
  const h = harness()
  h.sync.reconfigure()
  await h.flush()
  h.pendingPulls[0].reject(new TypeError('offline'))
  await h.flush()
  assert.equal(h.sync.connState, 'reachable')
  assert.deepEqual(h.clock.pendingDelays, [100])
})

test('快速重试也失败：进「重试中」（degraded），之后连续失败 3 次进「离线」（down）', async () => {
  const h = harness()
  h.sync.reconfigure()
  await h.flush()
  h.pendingPulls[0].reject(new TypeError('offline'))
  await h.flush()
  h.clock.advance(100)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.equal(h.sync.connState, 'degraded')
  assert.deepEqual(h.clock.pendingDelays, [5000])
  // degraded 阶段：第 2 次失败仍在 degraded，第 3 次进 down
  h.clock.advance(5000)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.equal(h.sync.connState, 'degraded')
  h.clock.advance(10000)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.equal(h.sync.connState, 'down')
  // down 后退避继续爬升到 60s 封顶（此前 down 无分支、卡死在 20s——测试抓出来的 bug，已修）
  assert.deepEqual(h.clock.pendingDelays, [20000])
  h.clock.advance(20000)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.deepEqual(h.clock.pendingDelays, [40000])
  h.clock.advance(40000)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.deepEqual(h.clock.pendingDelays, [60000])
  h.clock.advance(60000)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.deepEqual(h.clock.pendingDelays, [60000])
})

test('退避间隔序列：5s → 10s → 20s → 40s → 60s 封顶', async () => {
  const h = harness()
  h.sync.reconfigure()
  await h.flush()
  h.pendingPulls[0].reject(new TypeError('offline'))
  await h.flush()
  h.clock.advance(100)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  const expected = [5000, 10000, 20000, 40000, 60000, 60000]
  for (const delay of expected) {
    assert.deepEqual(h.clock.pendingDelays, [delay])
    h.clock.advance(delay)
    await h.flush()
    h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
    await h.flush()
  }
})

test('断线中恢复：复位为 reachable 并给一次「已重新连接」反馈', async () => {
  const h = harness()
  h.sync.reconfigure()
  await h.flush()
  h.pendingPulls[0].reject(new TypeError('offline'))
  await h.flush()
  h.clock.advance(100)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.equal(h.sync.connState, 'degraded')
  const same = createEmptyState()
  same.version = h.store.state.version
  h.clock.advance(5000)
  await h.flush()
  h.pendingPulls.at(-1)?.resolve(same)
  await h.flush()
  assert.equal(h.sync.connState, 'reachable')
  assert.equal(h.events.includes('toast:已重新连接'), true)
})

test('轮询 401（加入密码错）：停轮询 + 弹重输，凭证不被自动清掉', async () => {
  const h = harness()
  h.sync.reconfigure()
  await h.flush()
  h.pendingPulls[0].reject(new ApiError(401, '加入密码错误'))
  await h.flush()
  assert.equal(h.events.includes('promptRejoin'), true)
  assert.deepEqual(h.clock.pendingDelays, []) // 轮询已停，不再空转
})

test('手动 retryNow：立刻发一次请求，并把退避重置回 5s', async () => {
  const h = harness()
  h.sync.reconfigure()
  await h.flush()
  // 打到 down
  h.pendingPulls[0].reject(new TypeError('offline'))
  await h.flush()
  h.clock.advance(100)
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  for (const delay of [5000, 10000, 20000]) {
    h.clock.advance(delay)
    await h.flush()
    h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
    await h.flush()
  }
  assert.equal(h.sync.connState, 'down')
  assert.deepEqual(h.clock.pendingDelays, [40000])
  h.sync.retryNow()
  await h.flush()
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  // 退避复位回起点后重新爬升：下一次失败 10s（而不是卡死在 5s 空转）
  assert.deepEqual(h.clock.pendingDelays, [10000])
})

test('reconfigure：shouldPoll 为假时停轮询（GM 靠推送、本地房间不联网）', async () => {
  const h = harness({ shouldPoll: () => false })
  h.sync.reconfigure()
  await h.flush()
  assert.deepEqual(h.clock.pendingDelays, [])
  h.sync.reconfigure()
  await h.flush()
  assert.deepEqual(h.clock.pendingDelays, [])
})

test('bootstrap 成功：采用服务端状态并渲染', async () => {
  const h = harness()
  const remote = createEmptyState()
  remote.version = 5
  h.sync.bootstrap()
  await h.flush()
  h.pendingPulls[0].resolve(remote)
  await h.flush()
  assert.equal(h.store.replaceCalls, 1)
  assert.equal(h.store.state.version, 5)
  assert.equal(h.events.at(-1), 'render')
})

test('bootstrap 网络失败：走断线状态机，5s 后自动重试，再败进「重试中」', async () => {
  const h = harness()
  h.sync.bootstrap()
  await h.flush()
  h.pendingPulls[0].reject(new TypeError('offline'))
  await h.flush()
  // 首次失败静默（仍是 reachable），bootstrap 自身的 5s 重试已排上
  assert.equal(h.sync.connState, 'reachable')
  assert.deepEqual(h.clock.pendingDelays, [5000])
  h.clock.advance(5000)
  await h.flush()
  // 重试再败：快速重试名额已被上次消耗，进「重试中」
  h.pendingPulls.at(-1)?.reject(new TypeError('offline'))
  await h.flush()
  assert.equal(h.sync.connState, 'degraded')
})

test('bootstrap 401：弹重输且不再自动重试', async () => {
  const h = harness()
  h.sync.bootstrap()
  await h.flush()
  h.pendingPulls[0].reject(new ApiError(401, '加入密码错误'))
  await h.flush()
  assert.equal(h.events.includes('promptRejoin'), true)
  assert.deepEqual(h.clock.pendingDelays, [])
})
