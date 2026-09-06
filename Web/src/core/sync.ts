/**
 * 同步引擎：变更防抖推送 + 只读轮询 + 断线三阶段状态机。
 *
 * 从 main.ts 拆出的「怎么把本地改动送到服务器、怎么把远端变化拉回来」。
 * 纯逻辑单元——fetch、定时器、localStorage、DOM 一概不碰，全部由 deps 注入；
 * 这条红线是它的可测试性所在（见 sync.test.ts：假时钟 + 假网络即可驱动全部状态转移）。
 *
 * 行为不变式（README「同步协议」「断线的三阶段」，由测试锁定）：
 * - 版本相同跳过 replaceState（不清撤销栈与选中态）；本地 dirty 时远端不得覆盖
 * - push 不带 version（force push）；409 分支保留给仍带 version 的第三方客户端
 * - 401 与网络异常分开：401 按请求类型分流（轮询 401 弹重输、推送 401 清凭证），超时/断网走退避
 * - 首次失败静默补一次快速重试，再失败进「重试中」，连败 3 次进「离线」；退避 5s→…→60s 封顶
 */
import type { ClockState } from '../../../common/types'
// 运行时导入带 .ts 扩展名：sync.test.ts 由 Node 原生跑 TS（type stripping 不解析扩展名），
// Vite 与 tsc（allowImportingTsExtensions）都认这种写法——server/ 目录同款约定
import { ApiError } from '../api.ts'

export type ConnState = 'reachable' | 'degraded' | 'down'

/** 引擎需要的会话快照。随取随读（getter 每次求值），保证换房间/换凭证后立即可见 */
export interface SyncContext {
  /** 当前房间名（'' = 空白工作区，不联网） */
  readonly room: string
  readonly joinPwd: string
  /** 只有远端房间且持有写凭证才推送 */
  canPush(): boolean
  /** 本地/空白工作区不轮询、GM 靠推送不轮询，玩家只读才轮询 */
  shouldPoll(): boolean
}

/** 引擎所需 Store 的最小切面（真实 Store 结构兼容；测试用假实现） */
export interface SyncStore {
  subscribe(fn: (kind: 'data' | 'order') => void): () => void
  replaceState(next: ClockState): void
  markSynced(version: number): void
  readonly state: { readonly version: number }
}

export interface SyncDeps extends SyncContext {
  /** 拉取当前远端房间状态（读会话快照，不缓存参数） */
  pull(): Promise<ClockState>
  /** 推送当前状态，返回服务端新版本 */
  push(): Promise<number>
  /** 定时器；返回取消函数（测试注入假时钟） */
  schedule(fn: () => void, ms: number): () => void
  toast(msg: string): void
  /** 全量重渲染 */
  render(): void
  /** 轮询/启动拉取撞 401（加入密码错）：停轮询弹「连接房间」重输 */
  promptRejoin(): void
  /** GM 凭证被服务器明确拒绝（推送 401）：清登录态（含提示） */
  onCredentialRejected(): void
}

const POLL_INTERVAL = 5000
const PUSH_DEBOUNCE = 500
const RETRY_BASE = 5000
const RETRY_CAP = 60000
/** 进入「重试中」后再连续失败的次数上限（达到即「离线」） */
const DOWN_AFTER_FAILS = 3

export class SyncEngine {
  // ---- 推送侧 ----
  private dirtyFlag = false
  private retryDelay = RETRY_BASE
  private pushCancel: (() => void) | undefined
  private retryCancel: (() => void) | undefined
  // ---- 轮询侧 / 断线三阶段 ----
  private connValue: ConnState = 'reachable'
  private silentFail = false // 首次失败后等快速重试；补的那一次不计入离线判定的失败次数
  private degradedFails = 0 // 进入「重试中」后的连续失败次数（≥3 → 离线）
  private pollDelay = POLL_INTERVAL
  private pollStop: (() => void) | null = null

  constructor(
    private deps: SyncDeps,
    private store: SyncStore,
  ) {
    this.store.subscribe((kind) => {
      // 显示顺序是本机的视图偏好，不是契约数据，不参与同步
      if (kind === 'order') return
      // 只有远端房间且持有写凭证才推送；本地房间 / 空白工作区的改动由 Store 就地落盘，是终点
      if (!this.deps.canPush()) return
      this.dirtyFlag = true
      this.pushCancel?.()
      this.pushCancel = this.deps.schedule(() => void this.pushNow(), PUSH_DEBOUNCE)
    })
  }

  /** 本地是否有未同步到服务器的改动（推送成功才清零；切换上下文前用于丢弃确认） */
  get dirty(): boolean {
    return this.dirtyFlag
  }

  /** 上下文整体切换（进房/退出/另存）后由调用方清零：旧上下文的待推送改动随场景作废 */
  resetDirty(): void {
    this.dirtyFlag = false
  }

  /** 连接状态（reachable / 重试中 / 离线），由请求结果推导，不做独立探活 */
  get connState(): ConnState {
    return this.connValue
  }

  /**
   * 任一请求成功（轮询 / 推送 / 启动拉取）都复位断线状态并给一次可见反馈——
   * 静默恢复等于没恢复，用户不知道什么时候能继续编辑。
   */
  private markReachable(): void {
    if (this.connValue !== 'reachable') {
      this.connValue = 'reachable'
      this.silentFail = false
      this.degradedFails = 0
      this.pollDelay = POLL_INTERVAL
      this.deps.toast('已重新连接')
      this.deps.render()
    }
  }

  /** 推送一次。成功清掉 dirty 并把退避重置回起点 */
  private async pushNow(): Promise<void> {
    // dirty 已被清掉（退出房间等）就别推了，否则会把空状态推上去覆盖服务端
    if (!this.dirtyFlag) return
    try {
      const version = await this.deps.push()
      // 推送成功：更新同步基线（轮询据此判断远端是否领先），并复位断线状态
      this.store.markSynced(version)
      this.dirtyFlag = false
      this.retryDelay = RETRY_BASE
      this.markReachable()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 多写冲突：采用服务器最新状态（丢包重做模式，桌游场景足够）。
        // Web 端推送不带 version 走强制覆盖，自己撞不到这一支；
        // 保留给仍带 version 的客户端（QQ Bot），以及将来恢复乐观锁的情形
        try {
          const remote = e.latest ?? (await this.deps.pull())
          this.store.replaceState(remote)
          // 采用远端后本地与服务端同版本，算已同步；
          // 不置 false 的话 dirty 会一直为真，轮询从此被 if (dirty) return 挡死
          this.dirtyFlag = false
          this.deps.toast('状态已在别处更新，已同步最新')
          this.deps.render()
        } catch {
          // 拉取失败静默
        }
      } else if (e instanceof ApiError && e.status === 401) {
        // GM 密码失效：清除写凭证并提示重新输入（加入密码错误则轮询静默，不影响只读）
        this.deps.onCredentialRejected()
        this.deps.render()
        this.reconfigure()
      } else {
        // 网络错误 / 服务器不可达：dirty 保持为真，排一次重试，并进入断线状态机（置灰 + 横幅）。
        // GM 端是不轮询的（shouldPoll 为假），没有别的路径能把它推出去；关掉页面更糟：
        // 本地数据还在，下次启动 bootstrap 会用服务端状态覆盖掉。
        this.handlePollError(e)
        this.scheduleRetryPush()
      }
    }
  }

  /** 排一次推送重试；已在等待中就不再排（避免每次改动叠一个定时器） */
  private scheduleRetryPush(): void {
    if (this.retryCancel !== undefined) return
    this.retryCancel = this.deps.schedule(() => {
      this.retryCancel = undefined
      void this.pushNow()
    }, this.retryDelay)
    // 退避：服务器已下线时固定 5s 打下去只是空转
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_CAP)
  }

  /**
   * 启动拉取（仅远端房间调用；server 为权威）。
   * 失败保持本地数据：401 弹重输并停轮询，网络异常进断线状态机、5s 后重试，
   * server 重启后自动恢复。
   */
  bootstrap(): void {
    void (async () => {
      try {
        const remote = await this.deps.pull()
        this.store.replaceState(remote)
        this.markReachable()
        this.deps.render()
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && this.deps.room) {
          // 私有房间 / 加入密码记忆失效：弹连接弹窗重新输入。
          // 停轮询：密码不对时每 5s 的失败请求无意义，等用户重新输入后再起
          this.stopPolling()
          this.deps.promptRejoin()
          this.deps.render()
        } else {
          this.handlePollError(e)
          this.deps.schedule(() => this.bootstrap(), RETRY_BASE)
        }
      }
    })()
  }

  /** 轮询成功回调：复位断线状态 + 原同步逻辑 */
  private handlePollUpdate(remote: ClockState): void {
    this.markReachable()
    // 本地有未推送成功的改动时不覆盖，防丢改动。
    // 只看 dirty，不看凭证态：推送撞 401 时凭证会被清掉并重启轮询，
    // 而那一刻恰恰是本地改动最需要保护的时候——带上凭证态反而撤掉了保护
    if (this.dirtyFlag) return
    // 版本没变就整个跳过：replaceState() 会清空撤销栈并把当前钟选中态置空，
    // 无条件每 5s 替换一次，等于每 5 秒把只读端刚点选中的钟取消掉（TODO-71af8dd5）。
    // version 由服务端每次写入自增，因此「版本相同」即可认为内容相同。
    if (remote.version === this.store.state.version) return
    this.store.replaceState(remote)
    this.deps.render()
  }

  /** 轮询失败回调：401（加入密码错）弹重输；网络异常走断线三阶段 */
  private handlePollError(e: unknown): void {
    if (e instanceof ApiError && e.status === 401) {
      // 加入密码错误：停轮询，弹连接弹窗重新输入（与 bootstrap 一致），不要无限重试
      this.stopPolling()
      this.deps.promptRejoin()
      this.deps.render()
      return
    }
    if (this.connValue === 'reachable') {
      if (!this.silentFail) {
        // 首次失败：静默补一次快速重试（下一个 tick 用 100ms），不提示、不置灰
        this.silentFail = true
        this.pollDelay = 100
      } else {
        // 补的快速重试也失败：进「重试中」，置灰写操作
        this.connValue = 'degraded'
        this.degradedFails = 1
        this.pollDelay = POLL_INTERVAL
        this.silentFail = false
      }
    } else {
      // degraded / down：退避继续翻倍直至 60s 封顶。此前 down 没有分支、pollDelay 卡死在
      // 进入离线时的 20s——离线状态下点一次手动「重试」（pollDelay 复位 5s）后更是永久 5s 空转，
      // 正是 README 明确要避免的「服务器已下线时固定 5s 打下去只是空转」。
      // down 判定只在 degraded 分支做一次：已离线就不再降级，也不会重复置灰
      this.degradedFails++
      this.pollDelay = Math.min(this.pollDelay * 2, RETRY_CAP) // 5s → 10s → 20s → 40s → 60s 封顶
      if (this.connValue === 'degraded' && this.degradedFails >= DOWN_AFTER_FAILS) {
        this.connValue = 'down'
      }
    }
    this.deps.render()
  }

  /**
   * 手动「重试」：立刻发一次请求并把退避重置回起点（覆盖「网络已恢复但不想等退避」的情况）。
   * 重置要落在节拍上：旧的长间隔定时一并取消，重试收尾后按起点（失败则翻倍值）重排轮询——
   * 否则「重置」只改了变量，轮询还在干等旧的长间隔，等于没重置。
   */
  retryNow(): void {
    this.pollDelay = POLL_INTERVAL
    if (this.pollStop) {
      this.pollPendingCancel?.()
      this.pollPendingCancel = undefined
    }
    void (async () => {
      try {
        this.handlePollUpdate(await this.deps.pull())
      } catch (err) {
        this.handlePollError(err)
      }
      if (this.pollStop && this.pollPendingCancel === undefined) {
        this.scheduleNextTick(this.pollGeneration)
      }
    })()
  }

  private pollGeneration = 0
  private pollPendingCancel: (() => void) | undefined

  /** 下一次轮询的间隔：静默快速重试补那一次用 100ms；正常 reachable 用固定间隔；断线中用退避值 */
  private nextPollDelay(): number {
    return this.silentFail ? 100 : this.connValue === 'reachable' ? POLL_INTERVAL : this.pollDelay
  }

  /** 代次令牌：startPolling/stopPolling 各前进一步，过期 tick（在途请求回来晚了）自行作废不重排 */
  private scheduleNextTick(gen: number): void {
    if (gen !== this.pollGeneration) return
    this.pollPendingCancel = this.deps.schedule(() => void this.pollTick(gen), this.nextPollDelay())
  }

  private pollTick = async (gen: number): Promise<void> => {
    if (gen !== this.pollGeneration) return
    try {
      this.handlePollUpdate(await this.deps.pull())
    } catch (e) {
      this.handlePollError(e)
    }
    if (gen !== this.pollGeneration) return
    this.scheduleNextTick(gen)
  }

  private startPolling(): void {
    this.stopPolling()
    // 新上下文（进房间 / 换服务器 / 重新登录）重置连接状态
    this.connValue = 'reachable'
    this.silentFail = false
    this.degradedFails = 0
    this.pollDelay = POLL_INTERVAL
    this.pollGeneration++
    const gen = this.pollGeneration
    this.pollStop = () => {
      this.pollPendingCancel?.()
      this.pollPendingCancel = undefined
      this.pollGeneration++
    }
    void this.pollTick(gen)
  }

  stopPolling(): void {
    this.pollStop?.()
    this.pollStop = null
  }

  /** 按当前上下文重建轮询：本地 / 空白工作区不联网；远端房间 GM 靠推送停轮询、玩家轮询 */
  reconfigure(): void {
    if (!this.deps.shouldPoll()) this.stopPolling()
    else this.startPolling()
  }
}
