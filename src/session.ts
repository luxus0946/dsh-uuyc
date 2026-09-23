/**
 * Drives a UU 远程 `term` interactive session. `term` has no "run one command
 * and return" mode, so we open a session, send the command followed by a unique
 * sentinel echo, read until the sentinel appears, and parse the exit code from
 * it. Output is cleaned of ANSI escapes (incl. private-mode & OSC) and the
 * echoed command line.
 *
 * 真机联调结论（设备 便携，2026-09-20）：
 * - 连接横幅（`[系统]`/`[连接]`/`[提示]`）先于 shell 提示符出现，必须跳过。
 * - PTY 注入大量 CSI 私有模式（`\x1b[?25h` 等，带 `?`）与 OSC 标题（`\x1b]0;…\x07`），
 *   旧的正则 `/\x1b\[[0-9;]*[A-Za-z]/` 漏掉这些 → 必须加 `?` 与 OSC 分支。
 * - PowerShell 的 `echo` 是 cmdlet，不会改写 `$LASTEXITCODE`，会话初值为 `$null`；
 *   直接用 `$($LASTEXITCODE)` 会得到空串，故哨兵里没有数字。已改为「快照前后
 *   `$LASTEXITCODE` + 用 `$?` 兜底」的稳健写法。
 * - 被控端锁屏时 term 会交互式索要密码（`[系统] 请输入被控端解锁密码`），需快速失败。
 * @module @deepseek-ai/dsh-uuyc/session
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { UuycExecResult, UuycShell } from './types.ts'
import { hasLockHint, hasHandshakeHint } from './uuyc.ts'

// 覆盖：CSI（含 ? 私有模式）、OSC 标题（BEL 或 ST 结尾）、字符集切换、Keypad/Char mode。
const ANSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]|\x1b[=>]/g

/** Strip ANSI/控制序列（CSI 私有模式、OSC 标题等）that the PTY injects. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '')
}

const SENTINEL = '__UUYCDONE__'

/**
 * One interactive `uuyc-cli term` session. Reusable across multiple
 * {@link run} calls; close it with {@link kill} (or let the plugin's idle TTL).
 */
export class UuycTerminal {
  private readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private errBuffer = ''
  private found = false
  private timedOut = false
  private resolveWait: ((result: UuycExecResult) => void) | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    cliPath: string,
    /** 已解析的设备 ID（uuyc 真实 ID 形如 aeawr…），用 --device-id 连接。 */
    target: string,
    private readonly shell: UuycShell,
    /** 被控端锁屏解锁密码（可选）。若设置，连接后会作为 stdin 首行发送（对齐 UU_CLI_HANDOFF：密码走 stdin 第一行）。 */
    private readonly password = '',
  ) {
    this.child = spawn(cliPath, ['term', '--device-id', target, '--shell', shell, '--new-session'], {
      windowsHide: true,
    })
    this.child.stdout.setEncoding('utf8').on('data', (chunk: Buffer | string) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.tryResolve()
    })
    // 锁屏 / 握手失败的诊断往往写到 stderr（如"被控端版本过低""请输入被控端解锁密码"），
    // 必须一并纳入提示检测，否则会漏判为"空输出"。
    this.child.stderr.setEncoding('utf8').on('data', (chunk: Buffer | string) => {
      this.errBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    this.child.on('exit', () => this.tryResolve(true))
  }

  /**
   * 追加哨兵回显，使输出可被机器解析。
   * PowerShell：快照前后 `$LASTEXITCODE` 区分「原生命令（改 $LASTEXITCODE）」与
   * 「cmdlet/builtin（不改）」，并以 `$?` 兜底，保证总能拿到数字退出码。
   * cmd：`%ERRORLEVEL%` 稳定反映上一条命令退出码。
   */
  private wrap(command: string): string {
    if (this.shell === 'cmd') {
      return `${command} & echo ${SENTINEL}%ERRORLEVEL%__`
    }
    const head = `$__uup=$LASTEXITCODE; ${command}; $__uul=$LASTEXITCODE; `
    const mid =
      `if($__uul -is [int] -and $__uul -ne $__uup){$__uuc=$__uul}else{$__uuc=if($?){0}else{1}}; `
    const tail = `Write-Output ("${SENTINEL}" + $__uuc + "__")`
    return head + mid + tail
  }

  private tryResolve(force = false): void {
    if (this.resolveWait === undefined) return
    if (!force) {
      const match = new RegExp(`${SENTINEL}(\\d+)__`).exec(this.buffer)
      if (match !== null) {
        this.found = true
        this.finish()
      }
    } else if (!this.found) {
      this.found = true
      this.finish()
    }
  }

  private finish(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    const result = this.settle()
    this.resolveWait?.(result)
    this.resolveWait = undefined
  }

  /**
   * Send one command and resolve when its sentinel returns or the timeout fires.
   * Concurrent calls are rejected; open a new session for parallelism.
   */
  async run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<UuycExecResult> {
    if (this.resolveWait !== undefined) {
      throw new Error('UuycTerminal.run: 已有未完成的执行；请新建会话以并行')
    }
    const onAbort = (): void => { this.timedOut = true; if (!this.found) this.found = true; this.finish(); this.kill() }
    signal?.addEventListener('abort', onAbort, { once: true })
    return new Promise<UuycExecResult>((resolve) => {
      this.resolveWait = resolve
      this.timer = setTimeout(() => {
        this.timedOut = true
        if (!this.found) this.found = true
        this.finish()
        this.kill()
      }, timeoutMs)
      // 若提供了解锁密码，按 UU_CLI_HANDOFF 的经验：密码作为 stdin 第一行发送，
      // 然后再发真正的命令。未锁屏设备多写这一行无害（会被回显并作为命令执行，但其
      // 输出位于首个哨兵之前，settle 会被剥离）；锁屏设备则靠它解锁。
      if (this.password.length > 0) {
        this.child.stdin.write(`${this.password}\r\n`)
      }
      this.child.stdin.write(`${this.wrap(command)}\r\n`)
      this.tryResolve()
    }).finally(() => signal?.removeEventListener('abort', onAbort))
  }

  /** Terminate the underlying CLI process. */
  kill(): void {
    try {
      this.child.kill()
    } catch {
      // ignore — process may already be gone
    }
  }

  private settle(): UuycExecResult {
    const stripped = stripAnsi(this.buffer)
    const errStripped = stripAnsi(this.errBuffer)
    const combined = stripped + errStripped
    // 终端桥不可用：多见于向不支持的 shell（如 cmd）发起会话，应回退 powershell。
    // 必须在锁屏判断之前，因为 'terminal_bridge_unavailable' 也出现在 LOCK_HINTS。
    if (combined.includes('terminal_bridge_unavailable')) {
      return { stdout: stripped, stderr: errStripped, exitCode: null, timedOut: false, bridgeUnavailable: true }
    }
    // 锁屏：未等到哨兵，但命中提示 → 明确失败，不干等。
    if (hasLockHint(combined)) {
      return { stdout: stripped, stderr: errStripped, exitCode: null, timedOut: false, locked: true }
    }
    // 握手失败：被控端无活跃终端 / 版本不匹配 / P2P 未就绪（如"被控端版本过低""Start peer connection failed"）。
    if (hasHandshakeHint(combined)) {
      return { stdout: stripped, stderr: errStripped, exitCode: null, timedOut: false, handshakeUnavailable: true }
    }
    const firstSent = stripped.indexOf(SENTINEL)
    const re = new RegExp(`${SENTINEL}(\\d+)__`, 'g')
    const matches = [...stripped.matchAll(re)]
    if (matches.length === 0) {
      // 无哨兵（异常 / 桥未就绪）：回退为「丢弃首行」的尽力解析。
      let out = stripped
      const newline = out.indexOf('\n')
      if (newline >= 0) out = out.slice(newline + 1)
      out = out.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '')
      return { stdout: out, stderr: '', exitCode: null, timedOut: this.timedOut, locked: false }
    }
    // 取最后一个哨兵（真实输出行）；首个哨兵在被回显的命令行里（无数字，不会被 \d+ 命中）。
    const real = matches[matches.length - 1]
    if (real === undefined) {
      return { stdout: stripped, stderr: '', exitCode: null, timedOut: this.timedOut, locked: false }
    }
    const realIdx = real.index as number
    let out = stripped.slice(0, realIdx)
    // 丢弃首个哨兵所在行之前的所有内容（连接横幅 + 提示符 + 被回显的命令行）。
    const fle = out.indexOf('\n', firstSent)
    out = fle >= 0 ? out.slice(fle + 1) : out
    out = out.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '')
    return { stdout: out, stderr: '', exitCode: Number(real[1]), timedOut: false, locked: false }
  }
}

/**
 * Run a command with automatic handshake-failure retry. Handshake failures are
 * usually transient (no active terminal session on the controlled end, or a
 * freshly restarted P2P link), so recreating the terminal and waiting a bit
 * often recovers. Returns both the final result and the (possibly recreated)
 * terminal so the caller can keep using it for stateful sessions.
 */
async function runWithHandshakeRetry(
  make: () => UuycTerminal,
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  maxRetries: number,
  backoffMs: number,
): Promise<{ execResult: UuycExecResult; terminal: UuycTerminal }> {
  let terminal = make()
  let execResult = await terminal.run(command, timeoutMs, signal)
  for (let attempt = 0; attempt < maxRetries && execResult.handshakeUnavailable === true; attempt++) {
    terminal.kill()
    await sleep(backoffMs * (attempt + 1))
    terminal = make()
    execResult = await terminal.run(command, timeoutMs, signal)
  }
  return { execResult, terminal }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ephemeral one-shot execution: open a session, run a single command, then kill
 * it. Convenient default for stateless remote command runs. Automatically
 * retries on handshake failure (see {@link runWithHandshakeRetry}).
 */
export async function execOnce(
  cliPath: string,
  target: string,
  shell: UuycShell,
  command: string,
  timeoutMs: number,
  password = '',
  signal?: AbortSignal,
  maxRetries = 1,
  backoffMs = 1500,
): Promise<UuycExecResult> {
  const { execResult, terminal } = await runWithHandshakeRetry(
    () => new UuycTerminal(cliPath, target, shell, password),
    command,
    timeoutMs,
    signal,
    maxRetries,
    backoffMs,
  )
  terminal.kill()
  return execResult
}
