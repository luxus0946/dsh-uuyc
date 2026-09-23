/**
 * deepseek-harness plugin: UU 远程 (uuyc-cli) 远程 Windows 控制。
 *
 * 暴露一个模型可见工具 `uuyc_terminal`，覆盖设备管理与远程命令执行两条腿：
 * - 设备管理：list_devices / connect / disconnect
 * - 远程执行：exec（一次性会话）/ open_session / run_in_session / kill_session / list_sessions
 *
 * 设计要点：
 * - uuyc 的 `term` 仅支持 Windows 被控端（Linux 请用 harness 原生 SSH 后端）。
 * - 所有 uuyc 调用都先 `echo` 探活，主程序未运行会返回清晰报错（退出码 2）。
 * - disconnect 强制带设备 ID，避免误断全部连接。
 * - 高危命令应交给 `tools/pre-execute` 的审批策略（部署侧配置），本插件只执行。
 *
 * @module @deepseek-ai/dsh-uuyc
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TerminalCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { UuycCli, isUuycShell, resolveCliPath } from './uuyc.ts'
import { execOnce, UuycTerminal } from './session.ts'
import type { UuycConfig, UuycLocalSessionId, UuycShell } from './types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

export const name = 'uuyc'
export const inject = ['tools']

/** 插件配置（由 cordis.yml 注入）。 */
export const Config = z.object({
  /** uuyc-cli.exe 的完整路径（Windows）。留空则由 resolveCliPath 在常见安装位置（D:\uu、D:\Netease、C:\Program Files\NetEase…）中查找。 */
  cliPath: z.string().default(''),
  /** 默认 Shell：powershell | cmd。 */
  defaultShell: z.string().default('powershell'),
  /** 单次远程命令执行超时（毫秒）。 */
  execTimeoutMs: z.number().default(120_000),
  /** 连接 / 列表等控制命令超时（毫秒）。 */
  controlTimeoutMs: z.number().default(15_000),
  /** 有状态会话空闲回收时间（毫秒）。 */
  sessionIdleTtlMs: z.number().default(600_000),
  /** 被控端锁屏时用于解锁的账户密码（可选）。仅锁屏设备需要；会进入 cordis.yml 与对话记录，用后建议改密码。 */
  password: z.string().default(''),
})

interface UuycToolArgs {
  action: 'list_devices' | 'connect' | 'disconnect' | 'exec' | 'open_session' | 'run_in_session' | 'kill_session' | 'list_sessions'
  target?: string
  command?: string
  shell?: string
  session_id?: string
  timeout_ms?: number
}

interface OpenSession {
  terminal: UuycTerminal
  target: string
  shell: UuycShell
  timer: NodeJS.Timeout
}

function validateArgs(args: UuycToolArgs): void {
  const needsTarget = ['connect', 'disconnect', 'exec', 'open_session', 'run_in_session', 'kill_session', 'list_sessions']
  if (needsTarget.includes(args.action) && (args.target === undefined || args.target.trim().length === 0)) {
    throw new Error(`action "${args.action}" 需要 target（设备名或设备 ID）`)
  }
  if ((args.action === 'exec' || args.action === 'run_in_session') && (args.command === undefined || args.command.trim().length === 0)) {
    throw new Error(`action "${args.action}" 需要 command`)
  }
  if ((args.action === 'run_in_session' || args.action === 'kill_session') && (args.session_id === undefined || args.session_id.trim().length === 0)) {
    throw new Error(`action "${args.action}" 需要 session_id`)
  }
  if (args.shell !== undefined && !isUuycShell(args.shell)) {
    throw new Error(`shell 必须是 powershell 或 cmd，收到 "${args.shell}"`)
  }
  if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) {
    throw new Error(`timeout_ms 必须为正数，收到 ${JSON.stringify(args.timeout_ms)}`)
  }
}

function renderUuyc(value: Record<string, unknown>): string {
  switch (value.action) {
    case 'list_devices': {
      const devices = (value.devices as Array<{ deviceName: string; deviceId: string; isOnline: boolean }>) ?? []
      if (devices.length === 0) return '未找到任何在线/离线设备（请确认 UU 远程已登录且账号下有设备）。'
      return devices
        .map((d) => `- ${d.deviceName} (${d.deviceId}) [${d.isOnline ? '在线' : '离线'}]`)
        .join('\n')
    }
    case 'exec':
    case 'run_in_session': {
      if (value.locked) {
        return '设备锁屏：被控端需要先解锁（或在插件配置 password 里提供账户密码）才能执行命令。请在远程 Windows 上解锁屏幕后重试，或换用已解锁/在线的设备。'
      }
      if (value.handshakeUnavailable) {
        return '终端握手失败：被控端可能没有活跃终端会话，或两端 UU 版本不匹配。请在远程 Windows 上打开一个 UU 终端窗口（P2P 刚重启则稍等），然后重试。'
      }
      const out = (value.stdout as string) ?? ''
      const code = value.exitCode
      const tag = value.timedOut ? ' [timeout]' : code === null ? '' : `\n[exit code: ${code}]`
      return `stdout:\n${out}${tag}`
    }
    case 'connect':
    case 'disconnect':
    case 'kill_session':
    case 'open_session':
    case 'list_sessions':
      return String(value.message ?? '')
    default:
      return JSON.stringify(value)
  }
}

function presentUuycCall(args: UuycToolArgs): TerminalCallView | { card: 'generic'; title: string; kind: 'execute'; content: { type: 'text'; text: string }[] } {
  if ((args.action === 'exec' || args.action === 'run_in_session') && args.command !== undefined) {
    return { card: 'terminal', title: args.command, description: `uuyc ${args.action} → ${args.target ?? ''}` }
  }
  return { card: 'generic', title: `uuyc ${args.action}`, kind: 'execute', content: [{ type: 'text', text: args.target ?? args.action }] }
}

function presentUuycResult(_args: unknown, result: { content: { type: 'text'; text: string }[]; isError: boolean }): ToolResultView | undefined {
  const block = result.content[0]
  if (block?.type !== 'text') return undefined
  if (result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, exitCode } = splitExitMarker(block.text)
  return { card: 'terminal', output: body, ...exitCode !== undefined ? { exitCode } : {} }
}

function splitExitMarker(text: string): { body: string; exitCode?: number } {
  const m = /\n\[exit code: (\d+)\]$/.exec(text)
  if (m?.[1] !== undefined) return { body: text.slice(0, m.index), exitCode: Number(m[1]) }
  return { body: text }
}

export function apply(ctx: Context, config: UuycConfig): void {
  const defaultShell = isUuycShell(config.defaultShell) ? config.defaultShell : 'powershell'
  const cliPath = resolveCliPath(config.cliPath)
  const cli = new UuycCli(cliPath)
  const sessions = new Map<string, OpenSession>()

  const clearSession = (id: string): void => {
    const entry = sessions.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    entry.terminal.kill()
    sessions.delete(id)
  }

  ctx.tools.register(defineTool({
    name: 'uuyc_terminal',
    description:
      '通过网易 UU 远程 (uuyc-cli) 控制远程 Windows 设备：列出/连接/断开设备，或在远程终端执行命令。'
      + ' target 为设备名或设备 ID（真实 ID 形如 aeawr2pspeamriqa，不以 uuyc 开头）。'
      + ' 注意：uuyc 的 term 仅支持 Windows 被控端；Linux 服务器请改用其他 SSH 通道。'
      + ' 被控端锁屏时需要先在远端解锁（或配置 password 由插件发送解锁密码）才能执行命令；'
      + ' 若报"终端握手失败/被控端版本过低"，通常是因为被控端没有活跃终端窗口，让用户在远端打开一个 UU 终端窗口后重试。'
      + ' 断开连接必须指定设备，避免误断全部连接。'
      + ' ⚠️ uuyc-cli 无原生文件传输能力，传文件请走 UU 远程客户端的 GUI 互传，不要尝试用本工具传文件。',
    parameters: {
      action: {
        type: 'string' as const,
        required: true,
        enum: ['list_devices', 'connect', 'disconnect', 'exec', 'open_session', 'run_in_session', 'kill_session', 'list_sessions'],
        description: '操作类型。',
      },
      target: { type: 'string', description: '设备名或设备 ID（真实 ID 形如 aeawr2pspeamriqa；exec/open/connect/disconnect/kill/list_sessions 必须）。' },
      command: { type: 'string', description: '要执行的命令（exec/run_in_session 必须）。' },
      shell: { type: 'string' as const, enum: ['powershell', 'cmd'], description: 'Shell 类型，默认 powershell。' },
      session_id: { type: 'string', description: '有状态会话 ID（run_in_session/kill_session 必须）。' },
      timeout_ms: { type: 'number', description: '超时毫秒数，覆盖默认 execTimeoutMs。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderUuyc(value as Record<string, unknown>) }],
    },
    // 返回类型标注为 any：公开版 @deepseek-ai/dsh-tools 的 defineTool 输出类型
    // (Record<string, JsonValue>) 不允许 undefined 可选属性，而本工具各 action 分支
    // 返回的对象形状不同、会产生 `?: undefined`，直接标 any 即可绕过该严格检查，运行时不变。
    async execute(args: UuycToolArgs, exec): Promise<any> {
      validateArgs(args)
      const timeoutMs = args.timeout_ms ?? config.execTimeoutMs
      const shell: UuycShell = args.shell !== undefined && isUuycShell(args.shell) ? args.shell : defaultShell
      try {
        switch (args.action) {
          case 'list_devices': {
            const devices = await cli.listDevices(config.controlTimeoutMs)
            return {
              action: 'list_devices',
              ok: true,
              devices: devices.map((d) => ({
                deviceId: d.deviceId,
                deviceName: d.deviceName,
                isOnline: d.isOnline,
                platform: d.platform,
              })),
            }
          }
          case 'connect': {
            const deviceId = await cli.resolveDeviceId(args.target as string, config.controlTimeoutMs)
            await cli.connect(deviceId, config.controlTimeoutMs)
            return { action: 'connect', ok: true, message: `已连接设备 ${deviceId}` }
          }
          case 'disconnect': {
            const deviceId = await cli.resolveDeviceId(args.target as string, config.controlTimeoutMs)
            await cli.disconnect(deviceId, config.controlTimeoutMs)
            return { action: 'disconnect', ok: true, message: `已断开设备 ${deviceId}` }
          }
          case 'exec': {
            const deviceId = await cli.resolveDeviceId(args.target as string, config.controlTimeoutMs)
            const result = await execOnce(cliPath, deviceId, shell, args.command as string, timeoutMs, config.password, exec.signal)
            return { ...result, action: 'exec', ok: !result.timedOut && !result.locked && !result.handshakeUnavailable }
          }
          case 'open_session': {
            const deviceId = await cli.resolveDeviceId(args.target as string, config.controlTimeoutMs)
            const terminal = new UuycTerminal(cliPath, deviceId, shell, config.password)
            const id = brandString<UuycLocalSessionId>(randomUUID())
            const timer = setTimeout(() => clearSession(id), config.sessionIdleTtlMs)
            sessions.set(id, { terminal, target: args.target as string, shell, timer })
            return { action: 'open_session', ok: true, session_id: id, message: `已开启会话 ${id}（空闲 ${config.sessionIdleTtlMs}ms 后自动回收）` }
          }
          case 'run_in_session': {
            const sessionId = args.session_id as string
            const entry = sessions.get(sessionId)
            if (entry === undefined) throw new Error(`会话 ${sessionId} 不存在或已回收`)
            clearTimeout(entry.timer)
            const result = await entry.terminal.run(args.command as string, timeoutMs, exec.signal)
            entry.timer = setTimeout(() => clearSession(sessionId), config.sessionIdleTtlMs)
            return { ...result, action: 'run_in_session', ok: !result.timedOut && !result.handshakeUnavailable, session_id: sessionId }
          }
          case 'kill_session': {
            clearSession(args.session_id as string)
            return { action: 'kill_session', ok: true, message: `已关闭会话 ${args.session_id}` }
          }
          case 'list_sessions': {
            const deviceId = await cli.resolveDeviceId(args.target as string, config.controlTimeoutMs)
            const text = await cli.listSessions(deviceId, config.controlTimeoutMs)
            return { action: 'list_sessions', ok: true, message: text }
          }
          default:
            throw new Error(`未知 action: ${(args as UuycToolArgs).action}`)
        }
      } catch (error) {
        // 把底层错误透传给模型，便于排错（主程序未运行、设备不存在等）。
        throw error
      }
    },
    presentCall: presentUuycCall,
    presentResult: presentUuycResult,
  }))
}

export default apply

// 对外暴露底层 API，便于嵌入其它模块或编写端到端测试。
export { UuycTerminal, execOnce } from './session.ts'
export {
  UuycCli,
  parseDeviceList,
  isUuycShell,
  resolveCliPath,
  UuycNotRunningError,
  UuycExitError,
  UuycDeviceNotFoundError,
  UuycLockedError,
  UuycBridgeUnavailableError,
  UuycHandshakeError,
  hasLockHint,
  hasHandshakeHint,
} from './uuyc.ts'
