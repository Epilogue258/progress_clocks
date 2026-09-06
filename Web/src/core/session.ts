/**
 * 会话状态：当前连接的服务器、所在房间与持有的凭证。
 *
 * 从 main.ts 拆出的「我是谁、在哪、拿什么凭证」——状态与本机落盘都在这里，
 * main.ts 只负责编排（URL 同步、状态槽切换、渲染触发）。
 * 形态与 state.ts 的 Store 一致：变更方法内部落盘并通知订阅者。
 *
 * 已知陷阱在此内部消化，外界不再可能搞错：
 * - 凭证落在哪个键取决于当前是否在房间（ROOM_GM_STORAGE / GM_KEY_STORAGE），
 *   因此 leave() 必须先清凭证再清房间名——顺序封装在方法内。
 * - 服务器地址的变更途经此处的都会顺手记进 known-servers（?server= 分享链接
 *   的首次记忆仍归 main.ts，那属于启动引导）。
 */
// 运行时导入带 .ts 扩展名：Node 原生跑 TS 不解析扩展名（见 core/sync.ts 说明）
import { rememberServer } from '../known-servers.ts'

const API_BASE_STORAGE = 'pc-api-base'
const ROOM_STORAGE = 'pc-room-name'
const ROOM_JOIN_STORAGE = 'pc-room-join'
const ROOM_GM_STORAGE = 'pc-room-gm'
const GM_KEY_STORAGE = 'pc-gm-key'
const ROOM_TYPE_STORAGE = 'pc-room-type'

export function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export interface SessionInit {
  urlReadonly: boolean
  /** ?server= URL 参数（分享链接），优先于本机记忆 */
  urlServer?: string
  /** ?room= URL 参数（分享链接，指向远端房间） */
  urlRoom?: string
}

export class Session {
  private apiBase: string
  private roomName: string
  private roomIsLocal: boolean
  private joinPwdValue: string
  private gmKeyValue: string | null
  private authedValue: boolean
  private listeners = new Set<() => void>()

  constructor(
    private init: SessionInit,
    private storage: Storage = localStorage,
  ) {
    const savedBase = storage.getItem(API_BASE_STORAGE)
    this.apiBase = init.urlServer
      ? normalizeBase(init.urlServer)
      : savedBase
        ? normalizeBase(savedBase)
        : ''
    // ?room= 指向远端房间；本地房间只按记忆恢复（不分享）
    this.roomName = init.urlRoom ?? storage.getItem(ROOM_STORAGE) ?? ''
    this.roomIsLocal = !init.urlRoom && storage.getItem(ROOM_TYPE_STORAGE) === 'local'
    this.joinPwdValue = storage.getItem(ROOM_JOIN_STORAGE) ?? ''
    // 房间模式：gmKey = GM 密码（写凭证）；空白工作区：GM_KEY
    this.gmKeyValue = this.roomName
      ? storage.getItem(ROOM_GM_STORAGE)
      : storage.getItem(GM_KEY_STORAGE)
    this.authedValue = this.roomName ? !!this.gmKeyValue : false
  }

  /** 当前生效的服务器地址（'' = 同源托管） */
  get serverBase(): string {
    return this.apiBase
  }

  /** 当前房间名（'' = 空白工作区） */
  get room(): string {
    return this.roomName
  }

  get roomLocal(): boolean {
    return this.roomIsLocal
  }

  /** 当前加入密码（'' = 公开房间） */
  get joinPwd(): string {
    return this.joinPwdValue
  }

  get gmKey(): string | null {
    return this.gmKeyValue
  }

  get authed(): boolean {
    return this.authedValue
  }

  /** 能否推送：只有远端房间且持有写凭证才会同步；本地与空白工作区不联网 */
  canPush(): boolean {
    return this.roomName !== '' && !this.roomIsLocal && this.authedValue && !this.init.urlReadonly
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  /** 切换服务器（规范化 + 落盘 + 记进 known-servers） */
  setServer(base: string): void {
    this.apiBase = normalizeBase(base)
    this.storage.setItem(API_BASE_STORAGE, this.apiBase)
    rememberServer(this.apiBase)
    this.notify()
  }

  /** 记录验证通过的凭证：登录态 + 本机记忆一并落 */
  setCredential(key: string): void {
    this.gmKeyValue = key
    this.authedValue = true
    this.persistCredential()
    this.notify()
  }

  /** 先记后验（已知房间一键切换）：只赋值不落盘，验证结果出来再 setAuthed / persistCredential */
  setCredentialUnverified(key: string): void {
    this.gmKeyValue = key
    this.notify()
  }

  persistCredential(): void {
    this.storage.setItem(this.roomName ? ROOM_GM_STORAGE : GM_KEY_STORAGE, this.gmKeyValue ?? '')
    this.notify()
  }

  setAuthed(authed: boolean): void {
    this.authedValue = authed
    this.notify()
  }

  /** 修改加入密码（房间管理改密后同步本机记忆） */
  setJoinPwd(joinPwd: string): void {
    this.joinPwdValue = joinPwd
    this.storage.setItem(ROOM_JOIN_STORAGE, joinPwd)
    this.notify()
  }

  /**
   * 丢弃 GM 写凭证并复位登录态：gmKey / authed 清零 + 本机记忆删除。
   * 清理序列的统一入口——此前推送 401 / 改名 401 / 提交本地房间 401 / 启动复验失败
   * 各写一遍，漏掉任何一步（登录态没复位、或本机残留）表现各异且难排查。
   * 只清「当前房间 / 工作区」这一份凭证；known-rooms 缓存的按房间条目由调用方决定是否抹掉。
   */
  invalidateCredential(): void {
    this.gmKeyValue = null
    this.authedValue = false
    this.storage.removeItem(this.roomName ? ROOM_GM_STORAGE : GM_KEY_STORAGE)
    this.notify()
  }

  /** 进入远端房间：更新房间记忆（URL 同步与状态槽切换归 main.ts） */
  enterRemoteRoom(room: string, joinPwd: string): void {
    this.roomName = room
    this.roomIsLocal = false
    this.joinPwdValue = joinPwd
    this.storage.setItem(ROOM_STORAGE, room)
    this.storage.setItem(ROOM_JOIN_STORAGE, joinPwd)
    this.storage.setItem(ROOM_TYPE_STORAGE, 'remote')
    this.notify()
  }

  /** 进入本地房间：换房间记忆并复位凭证——本地房间永远可编辑、永不联网 */
  enterLocalRoom(name: string): void {
    this.roomName = name
    this.roomIsLocal = true
    this.joinPwdValue = ''
    this.gmKeyValue = null
    this.authedValue = true
    this.storage.setItem(ROOM_STORAGE, name)
    this.storage.removeItem(ROOM_JOIN_STORAGE)
    this.storage.setItem(ROOM_TYPE_STORAGE, 'local')
    this.notify()
  }

  /**
   * 退出到空白工作区（与 enterRemoteRoom / enterLocalRoom 对偶）。
   * 写凭证先清——此时房间名还在，才能选对要删的本机键；随后再清房间记忆。
   * 远端房间的 GM 密码与空白工作区无关。
   */
  leave(): void {
    this.invalidateCredential()
    this.roomName = ''
    this.roomIsLocal = false
    this.joinPwdValue = ''
    this.storage.removeItem(ROOM_STORAGE)
    this.storage.removeItem(ROOM_JOIN_STORAGE)
    this.storage.removeItem(ROOM_TYPE_STORAGE)
    this.notify()
  }
}
