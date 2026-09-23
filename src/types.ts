/**
 * Shared types, configuration, and branded identifiers for the UU 远程
 * (uuyc-cli) remote-control plugin. Cross-boundary ids are branded so a device
 * id can never be passed where a session id is expected.
 * @module @deepseek-ai/dsh-uuyc
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque UU 远程设备 ID (形如 uuyc20260606)。 */
export type UuycDeviceId = Branded<'UuycDeviceId'>

/** 插件自己维护的本地会话句柄 ID（非 uuyc 侧的会话编号）。 */
export type UuycLocalSessionId = Branded<'UuycLocalSessionId'>

/** 远程终端 Shell 类型。 */
export type UuycShell = 'powershell' | 'cmd'

/** `device list` 返回的一台设备。 */
export interface UuycDevice {
  deviceId: UuycDeviceId
  deviceName: string
  isOnline: boolean
  platform: number
}

/** 插件配置（由 cordis.yml 注入，schemastery 提供默认值）。 */
export interface UuycConfig {
  /** uuyc-cli.exe 的完整路径（Windows）。留空则由 {@link resolveCliPath} 在常见安装位置中查找。 */
  cliPath: string
  /** 默认 Shell 类型。 */
  defaultShell: UuycShell
  /** 单次远程命令执行的超时（毫秒）。 */
  execTimeoutMs: number
  /** 连接 / 列表等控制类命令的超时（毫秒）。 */
  controlTimeoutMs: number
  /** 有状态会话的空闲回收时间（毫秒）。 */
  sessionIdleTtlMs: number
  /**
   * 被控端锁屏时用于解锁的账户密码（可选）。仅当目标设备锁屏、需要密码才能建终端会话时
   * 才发送（作为 stdin 首行）。为空则锁屏设备直接报 UuycLockedError。
   * ⚠️ 该值会进入 cordis.yml 与对话记录，使用后应提醒用户修改密码。
   */
  password: string
  /**
   * 终端握手失败（handshakeUnavailable）时的最大重试次数。握手失败通常是被控端
   * 没有活跃终端会话 / P2P 刚重启，退避重试往往能自愈。默认 1（即总共尝试 2 次）。
   */
  handshakeRetries: number
  /** 握手重试的退避基数（毫秒），第 n 次重试等待 backoffMs * n。 */
  handshakeBackoffMs: number
}

/** 一次远程命令执行的结果。 */
export interface UuycExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** 被控端锁屏导致需要密码、命令未执行。 */
  locked?: boolean
  /** 终端握手失败：被控端无活跃终端会话 / 版本不匹配 / P2P 未就绪，需用户在远端打开一个 UU 终端窗口。 */
  handshakeUnavailable?: boolean
  /**
   * 远程终端桥不可用（terminal_bridge_unavailable）：多见于向不支持的 shell（如 cmd）
   * 发起会话。命中后工具层会自动回退到受支持的默认 shell（powershell）。
   */
  bridgeUnavailable?: boolean
}
