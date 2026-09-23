/**
 * Thin wrapper around the UU 远程 CLI (`uuyc-cli.exe`). The CLI itself talks to
 * the running UU 远程 main client; this module only spawns it locally, parses
 * its JSON, and maps exit codes to typed errors. No network or auth lives here.
 * @module @deepseek-ai/dsh-uuyc/uuyc
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { UuycDevice, UuycDeviceId, UuycShell } from './types.ts'

const execFileAsync = promisify(execFile)

/** UU 远程主程序未运行或未登录（对应退出码 2）。 */
export class UuycNotRunningError extends Error {
  constructor() {
    super('UU 远程主程序未运行或未登录：请先打开并登录 UU 远程客户端，再执行命令。')
    this.name = 'UuycNotRunningError'
  }
}

/** uuyc-cli 返回了非零退出码。 */
export class UuycExitError extends Error {
  constructor(
    public readonly code: number,
    public readonly stderr: string,
  ) {
    super(`uuyc-cli 退出码 ${code}${stderr ? `: ${stderr.trim()}` : ''}`)
    this.name = 'UuycExitError'
  }
}

/** 设备离线或不存在。 */
export class UuycDeviceNotFoundError extends Error {
  constructor(public readonly target: string, public readonly detail?: string) {
    super(
      `未找到设备 "${target}"（离线或不存在，或 target 既非设备名也非设备 ID）。` +
      (detail ? ` ${detail}` : ''),
    )
    this.name = 'UuycDeviceNotFoundError'
  }
}

/** 被控端锁屏，需要被控端账户密码才能建终端会话（uuyc 会交互式索要密码）。 */
export class UuycLockedError extends Error {
  constructor(public readonly target: string) {
    super(
      `设备 "${target}" 当前锁屏：uuyc 终端需要在被控端解锁（或提供账户密码）后才能执行命令。` +
      `请在远程 Windows 上解锁屏幕，或换用一台已解锁/在线设备后重试。`,
    )
    this.name = 'UuycLockedError'
  }
}

/** 被控端终端桥不可用（多见于 --shell cmd 不被远程桥支持）。 */
export class UuycBridgeUnavailableError extends Error {
  constructor(public readonly target: string) {
    super(`设备 "${target}" 的远程终端桥不可用（terminal_bridge_unavailable）。请改用默认 powershell，或确认远程设备终端服务可用。`)
    this.name = 'UuycBridgeUnavailableError'
  }
}

/**
 * 终端握手失败：被控端没有活跃终端会话、两端版本不匹配、或 P2P 刚重启。
 * 真实 CLI 报错形如 `被控端版本过低` / `请升级主控端` / `Start peer connection failed`。
 * 这类失败不是锁屏，而是"远端需要先有人打开一个 UU 终端窗口"，可重试。
 */
export class UuycHandshakeError extends Error {
  constructor(public readonly target: string) {
    super(
      `设备 "${target}" 终端握手失败：被控端可能没有活跃终端会话、或两端版本不匹配。` +
      `请在远程 Windows 上打开一个 UU 终端窗口（或在 P2P 重启后稍等），然后重试。`,
    )
    this.name = 'UuycHandshakeError'
  }
}

/** 锁屏密码提示 / 桥不可用的关键文本，命中即判定为需要交互或不可用。 */
export const LOCK_HINTS = ['解锁密码', '锁屏', '请输入被控端', 'terminal_bridge_unavailable']
export function hasLockHint(text: string): boolean {
  return LOCK_HINTS.some((h) => text.includes(h))
}

/** 终端握手失败的关键文本（被控端版本过低 / P2P 未就绪）。 */
export const HANDSHAKE_HINTS = ['被控端版本过低', '请升级主控端', 'Start peer connection failed']
export function hasHandshakeHint(text: string): boolean {
  return HANDSHAKE_HINTS.some((h) => text.includes(h))
}

/**
 * 用系统 `where` 命令定位 PATH 上的 uuyc-cli.exe（Windows 才有效）。
 * 仅作补充探测：命中即返回，不命中返回 undefined 由后续候选兜底。
 */
function tryWhere(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const out = execFileSync('where', ['uuyc-cli.exe'], { windowsHide: true, timeout: 3000 })
      .toString('utf8')
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
    return first !== undefined && existsSync(first) ? first : undefined
  } catch {
    return undefined
  }
}

/**
 * 通过正在运行的 GameViewer.exe 反查其安装目录，再拼出 `bin\uuyc-cli.exe`。
 * 比静态候选更稳：只要 UU 远程主程序在跑，就能找到同目录下的 CLI（不受安装路径影响）。
 */
function tryGameViewerProcessPath(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const ps = 'Get-Process GameViewer -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path'
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      timeout: 3000,
    })
      .toString('utf8')
      .trim()
    if (out.length === 0) return undefined
    const dir = out.replace(/[^\\/]+$/, '') // GameViewer.exe 所在目录
    const candidate = `${dir}bin\\uuyc-cli.exe`
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析 uuyc-cli.exe 路径，探测优先级：
 *   1. 配置值（存在即可）；
 *   2. PATH 上的 `where uuyc-cli.exe`；
 *   3. 反查正在运行的 GameViewer.exe 同目录 `bin\uuyc-cli.exe`；
 *   4. 常见静态安装位置（D:\uu / D:\Netease / C:\Program Files\NetEase …）。
 * 真实安装位置因机器而异：本机实测为 `D:\uu\GameViewer\bin\uuyc-cli.exe`，
 * 文档曾记录 `D:\Netease\...`，默认装在 `C:\Program Files\NetEase\...`，所以都试一遍。
 */
export function resolveCliPath(configured?: string): string {
  if (configured !== undefined && configured.length > 0 && existsSync(configured)) {
    return configured
  }
  if (process.platform === 'win32') {
    const where = tryWhere()
    if (where !== undefined) return where
    const fromProcess = tryGameViewerProcessPath()
    if (fromProcess !== undefined) return fromProcess
  }
  const candidates = [
    'D:\\uu\\GameViewer\\bin\\uuyc-cli.exe',
    'D:\\Netease\\GameViewer\\bin\\uuyc-cli.exe',
    'C:\\Program Files\\GameViewer\\bin\\uuyc-cli.exe',
    'C:\\Program Files\\NetEase\\GameViewer\\bin\\uuyc-cli.exe',
    'C:\\Program Files (x86)\\NetEase\\GameViewer\\bin\\uuyc-cli.exe',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // 都找不到时返回配置值（或首个候选），交由后续调用报错指引。
  return configured ?? candidates[0] ?? 'uuyc-cli.exe'
}

interface CliResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Local driver for `uuyc-cli`. Every method starts the main-client handshake
 * via {@link ensureRunning} where the doc says the client must be up.
 */
export class UuycCli {
  private deviceCache: { devices: UuycDevice[]; at: number } | undefined

  constructor(
    private readonly cliPath: string,
    /** 设备列表缓存有效期（毫秒），避免每次 resolveDeviceId 都重新拉取。默认 60s。 */
    private readonly deviceCacheTtlMs = 60_000,
  ) {}

  /** Execute the CLI and normalize its outcome, including timeout/kill. */
  private async run(args: readonly string[], timeoutMs: number): Promise<CliResult> {
    let result: CliResult
    try {
      const { stdout, stderr } = await execFileAsync(this.cliPath, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
      result = { stdout, stderr, code: 0 }
    } catch (err: unknown) {
      const e = err as {
        code?: string | number
        stdout?: string
        stderr?: string
        killed?: boolean
        signal?: string
      }
      // execFileAsync sets killed + signal on timeout; uuyc maps timeout to exit 5.
      if (e.killed === true && e.signal === 'SIGTERM') {
        result = { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: 5 }
      } else {
        const code = typeof e.code === 'number' ? e.code : 99
        result = { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code }
      }
    }
    // term 类命令若命中锁屏 / 桥不可用 / 握手失败提示，立即抛明确错误（否则会干等到超时）。
    if (args[0] === 'term') {
      const combined = result.stdout + result.stderr
      if (hasHandshakeHint(combined)) {
        throw new UuycHandshakeError(String(args[1] ?? ''))
      }
      if (hasLockHint(combined)) {
        if (combined.includes('terminal_bridge_unavailable')) {
          throw new UuycBridgeUnavailableError(String(args[1] ?? ''))
        }
        throw new UuycLockedError(String(args[1] ?? ''))
      }
    }
    return result
  }

  /** `uuyc-cli echo` — returns false (code 2) when the main client is down. */
  async echo(controlTimeoutMs: number): Promise<boolean> {
    const r = await this.run(['echo'], controlTimeoutMs)
    return r.code === 0
  }

  /** Throw {@link UuycNotRunningError} unless the main client is reachable. */
  async ensureRunning(controlTimeoutMs: number): Promise<void> {
    if (!(await this.echo(controlTimeoutMs))) throw new UuycNotRunningError()
  }

  /** Parse `device list` JSON into device summaries. */
  async listDevices(controlTimeoutMs: number, useCache = true): Promise<UuycDevice[]> {
    const now = Date.now()
    if (useCache && this.deviceCache !== undefined && now - this.deviceCache.at < this.deviceCacheTtlMs) {
      return this.deviceCache.devices
    }
    await this.ensureRunning(controlTimeoutMs)
    const r = await this.run(['device', 'list'], controlTimeoutMs)
    if (r.code !== 0) throw new UuycExitError(r.code, r.stderr)
    const devices = parseDeviceList(r.stdout)
    this.deviceCache = { devices, at: now }
    return devices
  }

  /** Force-clear the cached device list (call after connect/disconnect changes state). */
  invalidateDeviceCache(): void {
    this.deviceCache = undefined
  }

  /**
   * Resolve a target (device name or ID) to a device ID. 真实 uuyc 设备 ID 形如
   * `aeawr2pspeamriqa`，并不以 `uuyc` 开头；因此这里按「先精确匹配 deviceId，再匹配
   * deviceName，都没有再大小写不敏感子串模糊匹配」来解析，而不是用前缀猜测。
   * 模糊匹配若命中多台设备会给出候选清单，避免误连。
   */
  async resolveDeviceId(target: string, controlTimeoutMs: number, useCache = true): Promise<UuycDeviceId> {
    const devices = await this.listDevices(controlTimeoutMs, useCache)
    const t = target.trim()
    const tLower = t.toLowerCase()
    // 1) 精确匹配设备 ID（大小写不敏感，真实 ID 全小写）。
    const byId = devices.find((d) => d.deviceId.toLowerCase() === tLower)
    if (byId !== undefined) return byId.deviceId
    // 2) 精确匹配设备名（大小写不敏感）。
    const byName = devices.find((d) => d.deviceName.toLowerCase() === tLower)
    if (byName !== undefined) return byName.deviceId
    // 3) 模糊子串匹配（设备名或 ID 包含 target，大小写不敏感）。
    const fuzzy = devices.filter(
      (d) => d.deviceName.toLowerCase().includes(tLower) || d.deviceId.toLowerCase().includes(tLower),
    )
    if (fuzzy.length === 1) return fuzzy[0]!.deviceId
    if (fuzzy.length > 1) {
      const list = fuzzy.map((d) => `${d.deviceName} (${d.deviceId})`).join('、')
      throw new UuycDeviceNotFoundError(
        t,
        `命中多台设备，请更精确指定其一：${list}`,
      )
    }
    throw new UuycDeviceNotFoundError(t)
  }

  /** `device connect <id>` — requires an ID (never a bare name). */
  async connect(deviceId: UuycDeviceId, controlTimeoutMs: number): Promise<void> {
    await this.ensureRunning(controlTimeoutMs)
    const r = await this.run(['device', 'connect', deviceId], controlTimeoutMs)
    if (r.code !== 0) throw new UuycExitError(r.code, r.stderr)
    this.invalidateDeviceCache()
  }

  /**
   * `device disconnect <id>` — ALWAYS requires an ID. The bare form disconnects
   * every connection, so this method refuses to call it without one.
   */
  async disconnect(deviceId: UuycDeviceId, controlTimeoutMs: number): Promise<void> {
    await this.ensureRunning(controlTimeoutMs)
    const r = await this.run(['device', 'disconnect', deviceId], controlTimeoutMs)
    if (r.code !== 0) throw new UuycExitError(r.code, r.stderr)
    this.invalidateDeviceCache()
  }

  /** `term <target> --list-sessions` — returns raw session list text. target 为已解析的设备 ID。 */
  async listSessions(target: string, controlTimeoutMs: number): Promise<string> {
    await this.ensureRunning(controlTimeoutMs)
    const r = await this.run(['term', '--device-id', target, '--list-sessions'], controlTimeoutMs)
    if (r.code !== 0) throw new UuycExitError(r.code, r.stderr)
    return r.stdout
  }

  /** `term <target> --kill-session <id>`。 */
  async killSession(target: string, sessionId: number, controlTimeoutMs: number): Promise<void> {
    await this.ensureRunning(controlTimeoutMs)
    const r = await this.run(['term', '--device-id', target, '--kill-session', String(sessionId)], controlTimeoutMs)
    if (r.code !== 0) throw new UuycExitError(r.code, r.stderr)
  }
}

/**
 * Parse设备列表输出。真实 CLI 有两种格式，必须都兼容：
 *  - `device list` 子命令：JSON（带 UTF-8 BOM），结构 { data:{ devices:[ {deviceId,deviceName,isOnline,platform} ] }, success }。
 *  - 顶层 `--list-devices` 标志：TSV，表头 NAME<TAB>DEVICE_ID<TAB>ONLINE。
 * 这里优先按 JSON 解析（`device list`），解析失败再回退 TSV。
 */
export function parseDeviceList(stdout: string): UuycDevice[] {
  let text = stdout.replace(/^\uFEFF/, '').trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as {
        data?: { devices?: Array<{ deviceId?: string; deviceName?: string; isOnline?: boolean; platform?: number }> }
      }
      const raw = parsed.data?.devices ?? []
      return raw
        .filter((d) => typeof d.deviceId === 'string' && d.deviceId.length > 0)
        .map((d) => ({
          deviceId: brandString<UuycDeviceId>(d.deviceId as string),
          deviceName: d.deviceName ?? '',
          isOnline: d.isOnline === true,
          platform: typeof d.platform === 'number' ? d.platform : 0,
        }))
    } catch {
      return []
    }
  }
  // TSV 回退：NAME<TAB>DEVICE_ID<TAB>ONLINE
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const first = lines[0] ?? ''
  const start = /^NAME\b/i.test(first) ? 1 : 0
  const devices: UuycDevice[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const cols = line.split('\t')
    if (cols.length < 3) continue
    const [deviceName, deviceId, online] = cols
    if (typeof deviceId !== 'string' || deviceId.length === 0) continue
    devices.push({
      deviceId: brandString<UuycDeviceId>(deviceId),
      deviceName: deviceName === undefined ? '' : deviceName,
      isOnline: online === 'true',
      platform: 0, // TSV 不含 platform 字段，默认 0（Windows 被控端）
    })
  }
  return devices
}

/** Confirm `shell` is a supported value; used by the tool layer before spawn. */
export function isUuycShell(value: string): value is UuycShell {
  return value === 'powershell' || value === 'cmd'
}

/** Re-export the brand type for downstream consumers. */
export type { Branded }
