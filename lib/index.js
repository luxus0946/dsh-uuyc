import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { brandString } from "@deepseek-ai/dsh-brand";
//#region src/uuyc.ts
/**
* Thin wrapper around the UU 远程 CLI (`uuyc-cli.exe`). The CLI itself talks to
* the running UU 远程 main client; this module only spawns it locally, parses
* its JSON, and maps exit codes to typed errors. No network or auth lives here.
* @module @deepseek-ai/dsh-uuyc/uuyc
*/
const execFileAsync = promisify(execFile);
/** UU 远程主程序未运行或未登录（对应退出码 2）。 */
var UuycNotRunningError = class extends Error {
	constructor() {
		super("UU 远程主程序未运行或未登录：请先打开并登录 UU 远程客户端，再执行命令。");
		this.name = "UuycNotRunningError";
	}
};
/** uuyc-cli 返回了非零退出码。 */
var UuycExitError = class extends Error {
	code;
	stderr;
	constructor(code, stderr) {
		super(`uuyc-cli 退出码 ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
		this.code = code;
		this.stderr = stderr;
		this.name = "UuycExitError";
	}
};
/** 设备离线或不存在。 */
var UuycDeviceNotFoundError = class extends Error {
	target;
	detail;
	constructor(target, detail) {
		super(`未找到设备 "${target}"（离线或不存在，或 target 既非设备名也非设备 ID）。` + (detail ? ` ${detail}` : ""));
		this.target = target;
		this.detail = detail;
		this.name = "UuycDeviceNotFoundError";
	}
};
/** 被控端锁屏，需要被控端账户密码才能建终端会话（uuyc 会交互式索要密码）。 */
var UuycLockedError = class extends Error {
	target;
	constructor(target) {
		super(`设备 "${target}" 当前锁屏：uuyc 终端需要在被控端解锁（或提供账户密码）后才能执行命令。请在远程 Windows 上解锁屏幕，或换用一台已解锁/在线设备后重试。`);
		this.target = target;
		this.name = "UuycLockedError";
	}
};
/** 被控端终端桥不可用（多见于 --shell cmd 不被远程桥支持）。 */
var UuycBridgeUnavailableError = class extends Error {
	target;
	constructor(target) {
		super(`设备 "${target}" 的远程终端桥不可用（terminal_bridge_unavailable）。请改用默认 powershell，或确认远程设备终端服务可用。`);
		this.target = target;
		this.name = "UuycBridgeUnavailableError";
	}
};
/**
* 终端握手失败：被控端没有活跃终端会话、两端版本不匹配、或 P2P 刚重启。
* 真实 CLI 报错形如 `被控端版本过低` / `请升级主控端` / `Start peer connection failed`。
* 这类失败不是锁屏，而是"远端需要先有人打开一个 UU 终端窗口"，可重试。
*/
var UuycHandshakeError = class extends Error {
	target;
	constructor(target) {
		super(`设备 "${target}" 终端握手失败：被控端可能没有活跃终端会话、或两端版本不匹配。请在远程 Windows 上打开一个 UU 终端窗口（或在 P2P 重启后稍等），然后重试。`);
		this.target = target;
		this.name = "UuycHandshakeError";
	}
};
/** 锁屏密码提示 / 桥不可用的关键文本，命中即判定为需要交互或不可用。 */
const LOCK_HINTS = [
	"解锁密码",
	"锁屏",
	"请输入被控端",
	"terminal_bridge_unavailable"
];
function hasLockHint(text) {
	return LOCK_HINTS.some((h) => text.includes(h));
}
/** 终端握手失败的关键文本（被控端版本过低 / P2P 未就绪）。 */
const HANDSHAKE_HINTS = [
	"被控端版本过低",
	"请升级主控端",
	"Start peer connection failed"
];
function hasHandshakeHint(text) {
	return HANDSHAKE_HINTS.some((h) => text.includes(h));
}
/**
* 用系统 `where` 命令定位 PATH 上的 uuyc-cli.exe（Windows 才有效）。
* 仅作补充探测：命中即返回，不命中返回 undefined 由后续候选兜底。
*/
function tryWhere() {
	if (process.platform !== "win32") return void 0;
	try {
		const first = execFileSync("where", ["uuyc-cli.exe"], {
			windowsHide: true,
			timeout: 3e3
		}).toString("utf8").split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
		return first !== void 0 && existsSync(first) ? first : void 0;
	} catch {
		return;
	}
}
/**
* 通过正在运行的 GameViewer.exe 反查其安装目录，再拼出 `bin\uuyc-cli.exe`。
* 比静态候选更稳：只要 UU 远程主程序在跑，就能找到同目录下的 CLI（不受安装路径影响）。
*/
function tryGameViewerProcessPath() {
	if (process.platform !== "win32") return void 0;
	try {
		const out = execFileSync("powershell", [
			"-NoProfile",
			"-Command",
			"Get-Process GameViewer -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"
		], {
			windowsHide: true,
			timeout: 3e3
		}).toString("utf8").trim();
		if (out.length === 0) return void 0;
		const candidate = `${out.replace(/[^\\/]+$/, "")}bin\\uuyc-cli.exe`;
		return existsSync(candidate) ? candidate : void 0;
	} catch {
		return;
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
function resolveCliPath(configured) {
	if (configured !== void 0 && configured.length > 0 && existsSync(configured)) return configured;
	if (process.platform === "win32") {
		const where = tryWhere();
		if (where !== void 0) return where;
		const fromProcess = tryGameViewerProcessPath();
		if (fromProcess !== void 0) return fromProcess;
	}
	const candidates = [
		"D:\\uu\\GameViewer\\bin\\uuyc-cli.exe",
		"D:\\Netease\\GameViewer\\bin\\uuyc-cli.exe",
		"C:\\Program Files\\GameViewer\\bin\\uuyc-cli.exe",
		"C:\\Program Files\\NetEase\\GameViewer\\bin\\uuyc-cli.exe",
		"C:\\Program Files (x86)\\NetEase\\GameViewer\\bin\\uuyc-cli.exe"
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return configured ?? candidates[0] ?? "uuyc-cli.exe";
}
/**
* Local driver for `uuyc-cli`. Every method starts the main-client handshake
* via {@link ensureRunning} where the doc says the client must be up.
*/
var UuycCli = class {
	cliPath;
	deviceCacheTtlMs;
	deviceCache;
	constructor(cliPath, deviceCacheTtlMs = 6e4) {
		this.cliPath = cliPath;
		this.deviceCacheTtlMs = deviceCacheTtlMs;
	}
	/** Execute the CLI and normalize its outcome, including timeout/kill. */
	async run(args, timeoutMs) {
		let result;
		try {
			const { stdout, stderr } = await execFileAsync(this.cliPath, args, {
				timeout: timeoutMs,
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024
			});
			result = {
				stdout,
				stderr,
				code: 0
			};
		} catch (err) {
			const e = err;
			if (e.killed === true && e.signal === "SIGTERM") result = {
				stdout: e.stdout ?? "",
				stderr: e.stderr ?? "",
				code: 5
			};
			else {
				const code = typeof e.code === "number" ? e.code : 99;
				result = {
					stdout: e.stdout ?? "",
					stderr: e.stderr ?? "",
					code
				};
			}
		}
		if (args[0] === "term") {
			const combined = result.stdout + result.stderr;
			if (hasHandshakeHint(combined)) throw new UuycHandshakeError(String(args[1] ?? ""));
			if (hasLockHint(combined)) {
				if (combined.includes("terminal_bridge_unavailable")) throw new UuycBridgeUnavailableError(String(args[1] ?? ""));
				throw new UuycLockedError(String(args[1] ?? ""));
			}
		}
		return result;
	}
	/** `uuyc-cli echo` — returns false (code 2) when the main client is down. */
	async echo(controlTimeoutMs) {
		return (await this.run(["echo"], controlTimeoutMs)).code === 0;
	}
	/** Throw {@link UuycNotRunningError} unless the main client is reachable. */
	async ensureRunning(controlTimeoutMs) {
		if (!await this.echo(controlTimeoutMs)) throw new UuycNotRunningError();
	}
	/** Parse `device list` JSON into device summaries. */
	async listDevices(controlTimeoutMs, useCache = true) {
		const now = Date.now();
		if (useCache && this.deviceCache !== void 0 && now - this.deviceCache.at < this.deviceCacheTtlMs) return this.deviceCache.devices;
		await this.ensureRunning(controlTimeoutMs);
		const r = await this.run(["device", "list"], controlTimeoutMs);
		if (r.code !== 0) throw new UuycExitError(r.code, r.stderr);
		const devices = parseDeviceList(r.stdout);
		this.deviceCache = {
			devices,
			at: now
		};
		return devices;
	}
	/** Force-clear the cached device list (call after connect/disconnect changes state). */
	invalidateDeviceCache() {
		this.deviceCache = void 0;
	}
	/**
	* Resolve a target (device name or ID) to a device ID. 真实 uuyc 设备 ID 形如
	* `aeawr2pspeamriqa`，并不以 `uuyc` 开头；因此这里按「先精确匹配 deviceId，再匹配
	* deviceName，都没有再大小写不敏感子串模糊匹配」来解析，而不是用前缀猜测。
	* 模糊匹配若命中多台设备会给出候选清单，避免误连。
	*/
	async resolveDeviceId(target, controlTimeoutMs, useCache = true) {
		const devices = await this.listDevices(controlTimeoutMs, useCache);
		const t = target.trim();
		const tLower = t.toLowerCase();
		const byId = devices.find((d) => d.deviceId.toLowerCase() === tLower);
		if (byId !== void 0) return byId.deviceId;
		const byName = devices.find((d) => d.deviceName.toLowerCase() === tLower);
		if (byName !== void 0) return byName.deviceId;
		const fuzzy = devices.filter((d) => d.deviceName.toLowerCase().includes(tLower) || d.deviceId.toLowerCase().includes(tLower));
		if (fuzzy.length === 1) return fuzzy[0].deviceId;
		if (fuzzy.length > 1) throw new UuycDeviceNotFoundError(t, `命中多台设备，请更精确指定其一：${fuzzy.map((d) => `${d.deviceName} (${d.deviceId})`).join("、")}`);
		throw new UuycDeviceNotFoundError(t);
	}
	/** `device connect <id>` — requires an ID (never a bare name). */
	async connect(deviceId, controlTimeoutMs) {
		await this.ensureRunning(controlTimeoutMs);
		const r = await this.run([
			"device",
			"connect",
			deviceId
		], controlTimeoutMs);
		if (r.code !== 0) throw new UuycExitError(r.code, r.stderr);
		this.invalidateDeviceCache();
	}
	/**
	* `device disconnect <id>` — ALWAYS requires an ID. The bare form disconnects
	* every connection, so this method refuses to call it without one.
	*/
	async disconnect(deviceId, controlTimeoutMs) {
		await this.ensureRunning(controlTimeoutMs);
		const r = await this.run([
			"device",
			"disconnect",
			deviceId
		], controlTimeoutMs);
		if (r.code !== 0) throw new UuycExitError(r.code, r.stderr);
		this.invalidateDeviceCache();
	}
	/** `term <target> --list-sessions` — returns raw session list text. target 为已解析的设备 ID。 */
	async listSessions(target, controlTimeoutMs) {
		await this.ensureRunning(controlTimeoutMs);
		const r = await this.run([
			"term",
			"--device-id",
			target,
			"--list-sessions"
		], controlTimeoutMs);
		if (r.code !== 0) throw new UuycExitError(r.code, r.stderr);
		return r.stdout;
	}
	/** `term <target> --kill-session <id>`。 */
	async killSession(target, sessionId, controlTimeoutMs) {
		await this.ensureRunning(controlTimeoutMs);
		const r = await this.run([
			"term",
			"--device-id",
			target,
			"--kill-session",
			String(sessionId)
		], controlTimeoutMs);
		if (r.code !== 0) throw new UuycExitError(r.code, r.stderr);
	}
};
/**
* Parse设备列表输出。真实 CLI 有两种格式，必须都兼容：
*  - `device list` 子命令：JSON（带 UTF-8 BOM），结构 { data:{ devices:[ {deviceId,deviceName,isOnline,platform} ] }, success }。
*  - 顶层 `--list-devices` 标志：TSV，表头 NAME<TAB>DEVICE_ID<TAB>ONLINE。
* 这里优先按 JSON 解析（`device list`），解析失败再回退 TSV。
*/
function parseDeviceList(stdout) {
	let text = stdout.replace(/^\uFEFF/, "").trim();
	if (text.startsWith("{")) try {
		return (JSON.parse(text).data?.devices ?? []).filter((d) => typeof d.deviceId === "string" && d.deviceId.length > 0).map((d) => ({
			deviceId: brandString(d.deviceId),
			deviceName: d.deviceName ?? "",
			isOnline: d.isOnline === true,
			platform: typeof d.platform === "number" ? d.platform : 0
		}));
	} catch {
		return [];
	}
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	if (lines.length === 0) return [];
	const first = lines[0] ?? "";
	const start = /^NAME\b/i.test(first) ? 1 : 0;
	const devices = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		if (line === void 0) continue;
		const cols = line.split("	");
		if (cols.length < 3) continue;
		const [deviceName, deviceId, online] = cols;
		if (typeof deviceId !== "string" || deviceId.length === 0) continue;
		devices.push({
			deviceId: brandString(deviceId),
			deviceName: deviceName === void 0 ? "" : deviceName,
			isOnline: online === "true",
			platform: 0
		});
	}
	return devices;
}
/** Confirm `shell` is a supported value; used by the tool layer before spawn. */
function isUuycShell(value) {
	return value === "powershell" || value === "cmd";
}
//#endregion
//#region src/session.ts
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
const ANSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]|\x1b[=>]/g;
/** Strip ANSI/控制序列（CSI 私有模式、OSC 标题等）that the PTY injects. */
function stripAnsi(input) {
	return input.replace(ANSI_REGEX, "");
}
const SENTINEL = "__UUYCDONE__";
/**
* One interactive `uuyc-cli term` session. Reusable across multiple
* {@link run} calls; close it with {@link kill} (or let the plugin's idle TTL).
*/
var UuycTerminal = class {
	shell;
	password;
	child;
	buffer = "";
	errBuffer = "";
	found = false;
	timedOut = false;
	resolveWait;
	timer;
	constructor(cliPath, target, shell, password = "") {
		this.shell = shell;
		this.password = password;
		this.child = spawn(cliPath, [
			"term",
			"--device-id",
			target,
			"--shell",
			shell,
			"--new-session"
		], { windowsHide: true });
		this.child.stdout.setEncoding("utf8").on("data", (chunk) => {
			this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			this.tryResolve();
		});
		this.child.stderr.setEncoding("utf8").on("data", (chunk) => {
			this.errBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		});
		this.child.on("exit", () => this.tryResolve(true));
	}
	/**
	* 追加哨兵回显，使输出可被机器解析。
	* PowerShell：快照前后 `$LASTEXITCODE` 区分「原生命令（改 $LASTEXITCODE）」与
	* 「cmdlet/builtin（不改）」，并以 `$?` 兜底，保证总能拿到数字退出码。
	* cmd：`%ERRORLEVEL%` 稳定反映上一条命令退出码。
	*/
	wrap(command) {
		if (this.shell === "cmd") return `${command} & echo ${SENTINEL}%ERRORLEVEL%__`;
		const head = `$__uup=$LASTEXITCODE; ${command}; $__uul=$LASTEXITCODE; `;
		const mid = `if($__uul -is [int] -and $__uul -ne $__uup){$__uuc=$__uul}else{$__uuc=if($?){0}else{1}}; `;
		const tail = `Write-Output ("${SENTINEL}" + $__uuc + "__")`;
		return head + mid + tail;
	}
	tryResolve(force = false) {
		if (this.resolveWait === void 0) return;
		if (!force) {
			if (new RegExp(`${SENTINEL}(\\d+)__`).exec(this.buffer) !== null) {
				this.found = true;
				this.finish();
			}
		} else if (!this.found) {
			this.found = true;
			this.finish();
		}
	}
	finish() {
		if (this.timer !== void 0) clearTimeout(this.timer);
		const result = this.settle();
		this.resolveWait?.(result);
		this.resolveWait = void 0;
	}
	/**
	* Send one command and resolve when its sentinel returns or the timeout fires.
	* Concurrent calls are rejected; open a new session for parallelism.
	*/
	async run(command, timeoutMs, signal) {
		if (this.resolveWait !== void 0) throw new Error("UuycTerminal.run: 已有未完成的执行；请新建会话以并行");
		const onAbort = () => {
			this.timedOut = true;
			if (!this.found) this.found = true;
			this.finish();
			this.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		return new Promise((resolve) => {
			this.resolveWait = resolve;
			this.timer = setTimeout(() => {
				this.timedOut = true;
				if (!this.found) this.found = true;
				this.finish();
				this.kill();
			}, timeoutMs);
			if (this.password.length > 0) this.child.stdin.write(`${this.password}\r\n`);
			this.child.stdin.write(`${this.wrap(command)}\r\n`);
			this.tryResolve();
		}).finally(() => signal?.removeEventListener("abort", onAbort));
	}
	/** Terminate the underlying CLI process. */
	kill() {
		try {
			this.child.kill();
		} catch {}
	}
	settle() {
		const stripped = stripAnsi(this.buffer);
		const errStripped = stripAnsi(this.errBuffer);
		const combined = stripped + errStripped;
		if (combined.includes("terminal_bridge_unavailable")) return {
			stdout: stripped,
			stderr: errStripped,
			exitCode: null,
			timedOut: false,
			bridgeUnavailable: true
		};
		if (hasLockHint(combined)) return {
			stdout: stripped,
			stderr: errStripped,
			exitCode: null,
			timedOut: false,
			locked: true
		};
		if (hasHandshakeHint(combined)) return {
			stdout: stripped,
			stderr: errStripped,
			exitCode: null,
			timedOut: false,
			handshakeUnavailable: true
		};
		const firstSent = stripped.indexOf(SENTINEL);
		const re = new RegExp(`${SENTINEL}(\\d+)__`, "g");
		const matches = [...stripped.matchAll(re)];
		if (matches.length === 0) {
			let out = stripped;
			const newline = out.indexOf("\n");
			if (newline >= 0) out = out.slice(newline + 1);
			out = out.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
			return {
				stdout: out,
				stderr: "",
				exitCode: null,
				timedOut: this.timedOut,
				locked: false
			};
		}
		const real = matches[matches.length - 1];
		if (real === void 0) return {
			stdout: stripped,
			stderr: "",
			exitCode: null,
			timedOut: this.timedOut,
			locked: false
		};
		const realIdx = real.index;
		let out = stripped.slice(0, realIdx);
		const fle = out.indexOf("\n", firstSent);
		out = fle >= 0 ? out.slice(fle + 1) : out;
		out = out.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
		return {
			stdout: out,
			stderr: "",
			exitCode: Number(real[1]),
			timedOut: false,
			locked: false
		};
	}
};
/**
* Run a command with automatic handshake-failure retry. Handshake failures are
* usually transient (no active terminal session on the controlled end, or a
* freshly restarted P2P link), so recreating the terminal and waiting a bit
* often recovers. Returns both the final result and the (possibly recreated)
* terminal so the caller can keep using it for stateful sessions.
*/
async function runWithHandshakeRetry(make, command, timeoutMs, signal, maxRetries, backoffMs) {
	let terminal = make();
	let execResult = await terminal.run(command, timeoutMs, signal);
	for (let attempt = 0; attempt < maxRetries && execResult.handshakeUnavailable === true; attempt++) {
		terminal.kill();
		await sleep$1(backoffMs * (attempt + 1));
		terminal = make();
		execResult = await terminal.run(command, timeoutMs, signal);
	}
	return {
		execResult,
		terminal
	};
}
const sleep$1 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
* Ephemeral one-shot execution: open a session, run a single command, then kill
* it. Convenient default for stateless remote command runs. Automatically
* retries on handshake failure (see {@link runWithHandshakeRetry}).
*/
async function execOnce(cliPath, target, shell, command, timeoutMs, password = "", signal, maxRetries = 1, backoffMs = 1500) {
	const { execResult, terminal } = await runWithHandshakeRetry(() => new UuycTerminal(cliPath, target, shell, password), command, timeoutMs, signal, maxRetries, backoffMs);
	terminal.kill();
	return execResult;
}
//#endregion
//#region src/index.ts
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
const name = "uuyc";
const inject = ["tools"];
/** 插件配置（由 cordis.yml 注入）。 */
const Config = z.object({
	/** uuyc-cli.exe 的完整路径（Windows）。留空则由 resolveCliPath 在常见安装位置（D:\uu、D:\Netease、C:\Program Files\NetEase…）中查找。 */
	cliPath: z.string().default(""),
	/** 默认 Shell：powershell | cmd。 */
	defaultShell: z.string().default("powershell"),
	/** 单次远程命令执行超时（毫秒）。 */
	execTimeoutMs: z.number().default(12e4),
	/** 连接 / 列表等控制命令超时（毫秒）。 */
	controlTimeoutMs: z.number().default(15e3),
	/** 有状态会话空闲回收时间（毫秒）。 */
	sessionIdleTtlMs: z.number().default(6e5),
	/** 被控端锁屏时用于解锁的账户密码（可选）。仅锁屏设备需要；会进入 cordis.yml 与对话记录，用后建议改密码。 */
	password: z.string().default(""),
	/** 终端握手失败时的最大重试次数（默认 1，即总共尝试 2 次）。握手失败多因被控端无活跃终端/P2P 刚重启，退避重试常能自愈。 */
	handshakeRetries: z.number().default(1),
	/** 握手重试退避基数（毫秒），第 n 次重试等待 handshakeBackoffMs * n。 */
	handshakeBackoffMs: z.number().default(1500)
});
function validateArgs(args) {
	if ([
		"connect",
		"disconnect",
		"exec",
		"open_session",
		"run_in_session",
		"kill_session",
		"list_sessions"
	].includes(args.action) && (args.target === void 0 || args.target.trim().length === 0)) throw new Error(`action "${args.action}" 需要 target（设备名或设备 ID）`);
	if ((args.action === "exec" || args.action === "run_in_session") && (args.command === void 0 || args.command.trim().length === 0)) throw new Error(`action "${args.action}" 需要 command`);
	if ((args.action === "run_in_session" || args.action === "kill_session") && (args.session_id === void 0 || args.session_id.trim().length === 0)) throw new Error(`action "${args.action}" 需要 session_id`);
	if (args.shell !== void 0 && !isUuycShell(args.shell)) throw new Error(`shell 必须是 powershell 或 cmd，收到 "${args.shell}"`);
	if (args.timeout_ms !== void 0 && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) throw new Error(`timeout_ms 必须为正数，收到 ${JSON.stringify(args.timeout_ms)}`);
}
function renderUuyc(value) {
	switch (value.action) {
		case "list_devices": {
			const devices = value.devices ?? [];
			if (devices.length === 0) return "未找到任何在线/离线设备（请确认 UU 远程已登录且账号下有设备）。";
			return devices.map((d) => `- ${d.deviceName} (${d.deviceId}) [${d.isOnline ? "在线" : "离线"}]`).join("\n");
		}
		case "exec":
		case "run_in_session": {
			if (value.locked) return "设备锁屏：被控端需要先解锁（或在插件配置 password 里提供账户密码）才能执行命令。请在远程 Windows 上解锁屏幕后重试，或换用已解锁/在线的设备。";
			if (value.handshakeUnavailable) return "终端握手失败：被控端可能没有活跃终端会话，或两端 UU 版本不匹配。请在远程 Windows 上打开一个 UU 终端窗口（P2P 刚重启则稍等），然后重试。";
			if (value.bridgeUnavailable) return "终端桥不可用（terminal_bridge_unavailable）：当前 shell 不被远程终端桥支持。已自动回退到受支持的默认 shell（powershell）；若仍失败，请确认远程设备终端服务可用，或换用已解锁/在线设备。";
			const out = value.stdout ?? "";
			const code = value.exitCode;
			return `stdout:\n${out}${value.timedOut ? " [timeout]" : code === null ? "" : `\n[exit code: ${code}]`}`;
		}
		case "connect":
		case "disconnect":
		case "kill_session":
		case "open_session":
		case "list_sessions": return String(value.message ?? "");
		default: return JSON.stringify(value);
	}
}
function presentUuycCall(args) {
	if ((args.action === "exec" || args.action === "run_in_session") && args.command !== void 0) return {
		card: "terminal",
		title: args.command,
		description: `uuyc ${args.action} → ${args.target ?? ""}`
	};
	return {
		card: "generic",
		title: `uuyc ${args.action}`,
		kind: "execute",
		content: [{
			type: "text",
			text: args.target ?? args.action
		}]
	};
}
function presentUuycResult(_args, result) {
	const block = result.content[0];
	if (block?.type !== "text") return void 0;
	if (result.isError) return {
		card: "generic",
		content: [{
			type: "text",
			text: `\`\`\`console\n${block.text.replace(/\n+$/, "")}\n\`\`\``
		}]
	};
	const { body, exitCode } = splitExitMarker(block.text);
	return {
		card: "terminal",
		output: body,
		...exitCode !== void 0 ? { exitCode } : {}
	};
}
function splitExitMarker(text) {
	const m = /\n\[exit code: (\d+)\]$/.exec(text);
	if (m?.[1] !== void 0) return {
		body: text.slice(0, m.index),
		exitCode: Number(m[1])
	};
	return { body: text };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
* 执行并做 shell 自动回退：
* - 当首选 shell 为 cmd 且命中终端桥不可用（terminal_bridge_unavailable）时，回退到受支持的 powershell；
* - 当首选 shell 为 powershell 且握手失败（handshakeUnavailable）时，退避后回退到 cmd 再试一次
*   （部分设备/版本下 cmd 桥反而可用，作为尽力恢复）。
* 命中回退且备选 shell 成功（无 handshakeUnavailable / bridgeUnavailable）才采用备选结果。
*/
async function execWithShellFallback(cliPath, deviceId, shell, command, timeoutMs, password, signal, maxRetries, backoffMs) {
	let result = await execOnce(cliPath, deviceId, shell, command, timeoutMs, password, signal, maxRetries, backoffMs);
	const alternate = shell === "powershell" ? "cmd" : "powershell";
	if (shell === "cmd" && result.bridgeUnavailable === true || shell === "powershell" && result.handshakeUnavailable === true) {
		const alt = await execOnce(cliPath, deviceId, alternate, command, timeoutMs, password, signal, maxRetries, backoffMs);
		if (alt.handshakeUnavailable !== true && alt.bridgeUnavailable !== true) result = alt;
	}
	return result;
}
function apply(ctx, config) {
	const defaultShell = isUuycShell(config.defaultShell) ? config.defaultShell : "powershell";
	const cliPath = resolveCliPath(config.cliPath);
	const cli = new UuycCli(cliPath);
	const sessions = /* @__PURE__ */ new Map();
	const clearSession = (id) => {
		const entry = sessions.get(id);
		if (entry === void 0) return;
		clearTimeout(entry.timer);
		entry.terminal.kill();
		sessions.delete(id);
	};
	ctx.tools.register(defineTool({
		name: "uuyc_terminal",
		description: "通过网易 UU 远程 (uuyc-cli) 控制远程 Windows 设备：列出/连接/断开设备，或在远程终端执行命令。 target 为设备名或设备 ID（真实 ID 形如 aeawr2pspeamriqa，不以 uuyc 开头）。 注意：uuyc 的 term 仅支持 Windows 被控端；Linux 服务器请改用其他 SSH 通道。 被控端锁屏时需要先在远端解锁（或配置 password 由插件发送解锁密码）才能执行命令； 若报\"终端握手失败/被控端版本过低\"，通常是因为被控端没有活跃终端窗口，让用户在远端打开一个 UU 终端窗口后重试。 断开连接必须指定设备，避免误断全部连接。 终端握手失败会自动退避重试（次数由 handshakeRetries 控制），powershell 握手失败时还会回退到 cmd 再试； 用 cmd 触发 terminal_bridge_unavailable 时会自动回退到受支持的 powershell。target 支持名称/设备ID的模糊匹配。 ⚠️ uuyc-cli 无原生文件传输能力，传文件请走 UU 远程客户端的 GUI 互传，不要尝试用本工具传文件。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"list_devices",
					"connect",
					"disconnect",
					"exec",
					"open_session",
					"run_in_session",
					"kill_session",
					"list_sessions"
				],
				description: "操作类型。"
			},
			target: {
				type: "string",
				description: "设备名或设备 ID（真实 ID 形如 aeawr2pspeamriqa；exec/open/connect/disconnect/kill/list_sessions 必须）。"
			},
			command: {
				type: "string",
				description: "要执行的命令（exec/run_in_session 必须）。"
			},
			shell: {
				type: "string",
				enum: ["powershell", "cmd"],
				description: "Shell 类型，默认 powershell。"
			},
			session_id: {
				type: "string",
				description: "有状态会话 ID（run_in_session/kill_session 必须）。"
			},
			timeout_ms: {
				type: "number",
				description: "超时毫秒数，覆盖默认 execTimeoutMs。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					action: {
						type: "string",
						required: true
					},
					ok: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderUuyc(value)
			}]
		},
		async execute(args, exec) {
			validateArgs(args);
			const timeoutMs = args.timeout_ms ?? config.execTimeoutMs;
			const shell = args.shell !== void 0 && isUuycShell(args.shell) ? args.shell : defaultShell;
			try {
				switch (args.action) {
					case "list_devices": return {
						action: "list_devices",
						ok: true,
						devices: (await cli.listDevices(config.controlTimeoutMs)).map((d) => ({
							deviceId: d.deviceId,
							deviceName: d.deviceName,
							isOnline: d.isOnline,
							platform: d.platform
						}))
					};
					case "connect": {
						const deviceId = await cli.resolveDeviceId(args.target, config.controlTimeoutMs);
						await cli.connect(deviceId, config.controlTimeoutMs);
						return {
							action: "connect",
							ok: true,
							message: `已连接设备 ${deviceId}`
						};
					}
					case "disconnect": {
						const deviceId = await cli.resolveDeviceId(args.target, config.controlTimeoutMs);
						await cli.disconnect(deviceId, config.controlTimeoutMs);
						return {
							action: "disconnect",
							ok: true,
							message: `已断开设备 ${deviceId}`
						};
					}
					case "exec": {
						const result = await execWithShellFallback(cliPath, await cli.resolveDeviceId(args.target, config.controlTimeoutMs), shell, args.command, timeoutMs, config.password, exec.signal, config.handshakeRetries, config.handshakeBackoffMs);
						return {
							...result,
							action: "exec",
							ok: !result.timedOut && !result.locked && !result.handshakeUnavailable && !result.bridgeUnavailable
						};
					}
					case "open_session": {
						const deviceId = await cli.resolveDeviceId(args.target, config.controlTimeoutMs);
						const terminal = new UuycTerminal(cliPath, deviceId, shell, config.password);
						const id = brandString(randomUUID());
						const timer = setTimeout(() => clearSession(id), config.sessionIdleTtlMs);
						sessions.set(id, {
							terminal,
							target: args.target,
							deviceId,
							shell,
							timer
						});
						return {
							action: "open_session",
							ok: true,
							session_id: id,
							message: `已开启会话 ${id}（空闲 ${config.sessionIdleTtlMs}ms 后自动回收）`
						};
					}
					case "run_in_session": {
						const sessionId = args.session_id;
						const entry = sessions.get(sessionId);
						if (entry === void 0) throw new Error(`会话 ${sessionId} 不存在或已回收`);
						clearTimeout(entry.timer);
						const command = args.command;
						let result = await entry.terminal.run(command, timeoutMs, exec.signal);
						if (result.handshakeUnavailable === true) {
							let attempt = 0;
							while (result.handshakeUnavailable === true && attempt < config.handshakeRetries) {
								entry.terminal.kill();
								await sleep(config.handshakeBackoffMs * (attempt + 1));
								entry.terminal = new UuycTerminal(cliPath, entry.deviceId, entry.shell, config.password);
								result = await entry.terminal.run(command, timeoutMs, exec.signal);
								attempt++;
							}
							if (result.handshakeUnavailable === true && entry.shell === "powershell") {
								entry.terminal.kill();
								const altShell = "cmd";
								let altTerminal = new UuycTerminal(cliPath, entry.deviceId, altShell, config.password);
								let altResult = await altTerminal.run(command, timeoutMs, exec.signal);
								let a2 = 0;
								while (altResult.handshakeUnavailable === true && a2 < config.handshakeRetries) {
									altTerminal.kill();
									await sleep(config.handshakeBackoffMs * (a2 + 1));
									altTerminal = new UuycTerminal(cliPath, entry.deviceId, altShell, config.password);
									altResult = await altTerminal.run(command, timeoutMs, exec.signal);
									a2++;
								}
								if (altResult.handshakeUnavailable !== true && altResult.bridgeUnavailable !== true) {
									result = altResult;
									entry.shell = altShell;
								}
								entry.terminal = altTerminal;
							}
						}
						entry.timer = setTimeout(() => clearSession(sessionId), config.sessionIdleTtlMs);
						return {
							...result,
							action: "run_in_session",
							ok: !result.timedOut && !result.handshakeUnavailable && !result.bridgeUnavailable,
							session_id: sessionId
						};
					}
					case "kill_session":
						clearSession(args.session_id);
						return {
							action: "kill_session",
							ok: true,
							message: `已关闭会话 ${args.session_id}`
						};
					case "list_sessions": {
						const deviceId = await cli.resolveDeviceId(args.target, config.controlTimeoutMs);
						return {
							action: "list_sessions",
							ok: true,
							message: await cli.listSessions(deviceId, config.controlTimeoutMs)
						};
					}
					default: throw new Error(`未知 action: ${args.action}`);
				}
			} catch (error) {
				throw error;
			}
		},
		presentCall: presentUuycCall,
		presentResult: presentUuycResult
	}));
}
//#endregion
export { Config, UuycBridgeUnavailableError, UuycCli, UuycDeviceNotFoundError, UuycExitError, UuycHandshakeError, UuycLockedError, UuycNotRunningError, UuycTerminal, apply, execOnce, hasHandshakeHint, hasLockHint, inject, isUuycShell, name, parseDeviceList, resolveCliPath };
