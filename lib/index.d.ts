import { Branded } from "@deepseek-ai/dsh-brand";
import { Context } from "@deepseek-ai/cordis";

//#region src/types.d.ts
/** Opaque UU 远程设备 ID (形如 uuyc20260606)。 */
type UuycDeviceId = Branded<'UuycDeviceId'>;
/** 远程终端 Shell 类型。 */
type UuycShell = 'powershell' | 'cmd';
/** `device list` 返回的一台设备。 */
interface UuycDevice {
  deviceId: UuycDeviceId;
  deviceName: string;
  isOnline: boolean;
  platform: number;
}
/** 插件配置（由 cordis.yml 注入，schemastery 提供默认值）。 */
interface UuycConfig {
  /** uuyc-cli.exe 的完整路径（Windows）。留空则由 {@link resolveCliPath} 在常见安装位置中查找。 */
  cliPath: string;
  /** 默认 Shell 类型。 */
  defaultShell: UuycShell;
  /** 单次远程命令执行的超时（毫秒）。 */
  execTimeoutMs: number;
  /** 连接 / 列表等控制类命令的超时（毫秒）。 */
  controlTimeoutMs: number;
  /** 有状态会话的空闲回收时间（毫秒）。 */
  sessionIdleTtlMs: number;
  /**
   * 被控端锁屏时用于解锁的账户密码（可选）。仅当目标设备锁屏、需要密码才能建终端会话时
   * 才发送（作为 stdin 首行）。为空则锁屏设备直接报 UuycLockedError。
   * ⚠️ 该值会进入 cordis.yml 与对话记录，使用后应提醒用户修改密码。
   */
  password: string;
  /**
   * 终端握手失败（handshakeUnavailable）时的最大重试次数。握手失败通常是被控端
   * 没有活跃终端会话 / P2P 刚重启，退避重试往往能自愈。默认 1（即总共尝试 2 次）。
   */
  handshakeRetries: number;
  /** 握手重试的退避基数（毫秒），第 n 次重试等待 backoffMs * n。 */
  handshakeBackoffMs: number;
}
/** 一次远程命令执行的结果。 */
interface UuycExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** 被控端锁屏导致需要密码、命令未执行。 */
  locked?: boolean;
  /** 终端握手失败：被控端无活跃终端会话 / 版本不匹配 / P2P 未就绪，需用户在远端打开一个 UU 终端窗口。 */
  handshakeUnavailable?: boolean;
  /**
   * 远程终端桥不可用（terminal_bridge_unavailable）：多见于向不支持的 shell（如 cmd）
   * 发起会话。命中后工具层会自动回退到受支持的默认 shell（powershell）。
   */
  bridgeUnavailable?: boolean;
}
//#endregion
//#region src/session.d.ts
/**
 * One interactive `uuyc-cli term` session. Reusable across multiple
 * {@link run} calls; close it with {@link kill} (or let the plugin's idle TTL).
 */
declare class UuycTerminal {
  private readonly shell;
  /** 被控端锁屏解锁密码（可选）。若设置，连接后会作为 stdin 首行发送（对齐 UU_CLI_HANDOFF：密码走 stdin 第一行）。 */
  private readonly password;
  private readonly child;
  private buffer;
  private errBuffer;
  private found;
  private timedOut;
  private resolveWait;
  private timer;
  constructor(cliPath: string, /** 已解析的设备 ID（uuyc 真实 ID 形如 aeawr…），用 --device-id 连接。 */

  target: string, shell: UuycShell, /** 被控端锁屏解锁密码（可选）。若设置，连接后会作为 stdin 首行发送（对齐 UU_CLI_HANDOFF：密码走 stdin 第一行）。 */

  password?: string);
  /**
   * 追加哨兵回显，使输出可被机器解析。
   * PowerShell：快照前后 `$LASTEXITCODE` 区分「原生命令（改 $LASTEXITCODE）」与
   * 「cmdlet/builtin（不改）」，并以 `$?` 兜底，保证总能拿到数字退出码。
   * cmd：`%ERRORLEVEL%` 稳定反映上一条命令退出码。
   */
  private wrap;
  private tryResolve;
  private finish;
  /**
   * Send one command and resolve when its sentinel returns or the timeout fires.
   * Concurrent calls are rejected; open a new session for parallelism.
   */
  run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<UuycExecResult>;
  /** Terminate the underlying CLI process. */
  kill(): void;
  private settle;
}
/**
 * Ephemeral one-shot execution: open a session, run a single command, then kill
 * it. Convenient default for stateless remote command runs. Automatically
 * retries on handshake failure (see {@link runWithHandshakeRetry}).
 */
declare function execOnce(cliPath: string, target: string, shell: UuycShell, command: string, timeoutMs: number, password?: string, signal?: AbortSignal, maxRetries?: number, backoffMs?: number): Promise<UuycExecResult>;
//#endregion
//#region src/uuyc.d.ts
/** UU 远程主程序未运行或未登录（对应退出码 2）。 */
declare class UuycNotRunningError extends Error {
  constructor();
}
/** uuyc-cli 返回了非零退出码。 */
declare class UuycExitError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(code: number, stderr: string);
}
/** 设备离线或不存在。 */
declare class UuycDeviceNotFoundError extends Error {
  readonly target: string;
  readonly detail?: string | undefined;
  constructor(target: string, detail?: string | undefined);
}
/** 被控端锁屏，需要被控端账户密码才能建终端会话（uuyc 会交互式索要密码）。 */
declare class UuycLockedError extends Error {
  readonly target: string;
  constructor(target: string);
}
/** 被控端终端桥不可用（多见于 --shell cmd 不被远程桥支持）。 */
declare class UuycBridgeUnavailableError extends Error {
  readonly target: string;
  constructor(target: string);
}
/**
 * 终端握手失败：被控端没有活跃终端会话、两端版本不匹配、或 P2P 刚重启。
 * 真实 CLI 报错形如 `被控端版本过低` / `请升级主控端` / `Start peer connection failed`。
 * 这类失败不是锁屏，而是"远端需要先有人打开一个 UU 终端窗口"，可重试。
 */
declare class UuycHandshakeError extends Error {
  readonly target: string;
  constructor(target: string);
}
declare function hasLockHint(text: string): boolean;
declare function hasHandshakeHint(text: string): boolean;
/**
 * 解析 uuyc-cli.exe 路径，探测优先级：
 *   1. 配置值（存在即可）；
 *   2. PATH 上的 `where uuyc-cli.exe`；
 *   3. 反查正在运行的 GameViewer.exe 同目录 `bin\uuyc-cli.exe`；
 *   4. 常见静态安装位置（D:\uu / D:\Netease / C:\Program Files\NetEase …）。
 * 真实安装位置因机器而异：本机实测为 `D:\uu\GameViewer\bin\uuyc-cli.exe`，
 * 文档曾记录 `D:\Netease\...`，默认装在 `C:\Program Files\NetEase\...`，所以都试一遍。
 */
declare function resolveCliPath(configured?: string): string;
/**
 * Local driver for `uuyc-cli`. Every method starts the main-client handshake
 * via {@link ensureRunning} where the doc says the client must be up.
 */
declare class UuycCli {
  private readonly cliPath;
  /** 设备列表缓存有效期（毫秒），避免每次 resolveDeviceId 都重新拉取。默认 60s。 */
  private readonly deviceCacheTtlMs;
  private deviceCache;
  constructor(cliPath: string, /** 设备列表缓存有效期（毫秒），避免每次 resolveDeviceId 都重新拉取。默认 60s。 */

  deviceCacheTtlMs?: number);
  /** Execute the CLI and normalize its outcome, including timeout/kill. */
  private run;
  /** `uuyc-cli echo` — returns false (code 2) when the main client is down. */
  echo(controlTimeoutMs: number): Promise<boolean>;
  /** Throw {@link UuycNotRunningError} unless the main client is reachable. */
  ensureRunning(controlTimeoutMs: number): Promise<void>;
  /** Parse `device list` JSON into device summaries. */
  listDevices(controlTimeoutMs: number, useCache?: boolean): Promise<UuycDevice[]>;
  /** Force-clear the cached device list (call after connect/disconnect changes state). */
  invalidateDeviceCache(): void;
  /**
   * Resolve a target (device name or ID) to a device ID. 真实 uuyc 设备 ID 形如
   * `aeawr2pspeamriqa`，并不以 `uuyc` 开头；因此这里按「先精确匹配 deviceId，再匹配
   * deviceName，都没有再大小写不敏感子串模糊匹配」来解析，而不是用前缀猜测。
   * 模糊匹配若命中多台设备会给出候选清单，避免误连。
   */
  resolveDeviceId(target: string, controlTimeoutMs: number, useCache?: boolean): Promise<UuycDeviceId>;
  /** `device connect <id>` — requires an ID (never a bare name). */
  connect(deviceId: UuycDeviceId, controlTimeoutMs: number): Promise<void>;
  /**
   * `device disconnect <id>` — ALWAYS requires an ID. The bare form disconnects
   * every connection, so this method refuses to call it without one.
   */
  disconnect(deviceId: UuycDeviceId, controlTimeoutMs: number): Promise<void>;
  /** `term <target> --list-sessions` — returns raw session list text. target 为已解析的设备 ID。 */
  listSessions(target: string, controlTimeoutMs: number): Promise<string>;
  /** `term <target> --kill-session <id>`。 */
  killSession(target: string, sessionId: number, controlTimeoutMs: number): Promise<void>;
}
/**
 * Parse设备列表输出。真实 CLI 有两种格式，必须都兼容：
 *  - `device list` 子命令：JSON（带 UTF-8 BOM），结构 { data:{ devices:[ {deviceId,deviceName,isOnline,platform} ] }, success }。
 *  - 顶层 `--list-devices` 标志：TSV，表头 NAME<TAB>DEVICE_ID<TAB>ONLINE。
 * 这里优先按 JSON 解析（`device list`），解析失败再回退 TSV。
 */
declare function parseDeviceList(stdout: string): UuycDevice[];
/** Confirm `shell` is a supported value; used by the tool layer before spawn. */
declare function isUuycShell(value: string): value is UuycShell;
//#endregion
//#region src/index.d.ts
declare const name = "uuyc";
declare const inject: string[];
/** 插件配置（由 cordis.yml 注入）。 */
declare const Config: any;
declare function apply(ctx: Context, config: UuycConfig): void;
//#endregion
export { Config, UuycBridgeUnavailableError, UuycCli, UuycDeviceNotFoundError, UuycExitError, UuycHandshakeError, UuycLockedError, UuycNotRunningError, UuycTerminal, apply, execOnce, hasHandshakeHint, hasLockHint, inject, isUuycShell, name, parseDeviceList, resolveCliPath };