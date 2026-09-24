---
description: "UU remote (uuyc-cli) Windows remote-control plugin for deepseek-harness: device management and remote terminal execution"
kind: "package"
---

# dsh-uuyc — UU Remote Windows Control Plugin

[English](#english) | [中文](#中文)

<a id="english"></a>

Control remote Windows machines through NetEase UU Remote's `uuyc-cli`: list / connect / disconnect devices and run commands in a remote terminal. This plugin only **spawns `uuyc-cli.exe` locally and parses its output**; authentication and networking are handled by the logged-in UU Remote desktop client.

> **Platform limitation**: `uuyc-cli`'s `term` remote terminal **only supports Windows controlled endpoints**. For remote Linux servers, use the harness's native SSH backend, not this plugin.

## Installation (as a DSH bundle)

Install it into your own DSH profile with one command:

```bash
dsh plugin --profile <your-profile> add github:luxus0946/dsh-uuyc
```

What happens: DSH clones this repo and mounts the `uuyc` plugin into the profile according to `cordis.patch.yml`. **No build step runs** — the compiled `lib/` is committed precisely so that a source install cannot fail (see the prerequisite below).

> **Prerequisite — a matching DSH host.** This plugin consumes host-provided peers: it needs a harness that supplies `@deepseek-ai/dsh-tools@^0.1.6-alpha.2`, `@deepseek-ai/dsh-brand@^0.1.6-alpha.2`, `@deepseek-ai/cordis@^4.0.2` and `@deepseek-ai/schemastery@^3.18.2`. The two DeepSeek packages are **not published on the public npm registry** (only `0.0.1-rc.1` is), so the plugin loads only inside a harness build that provides them — a harness source checkout or an internal build. Someone who only has the public `dsh` cannot use it.
>
> **Windows only**: `cordis.patch.yml` sets `disabled: !!js process.platform !== 'win32'`, so non-Windows hosts skip this plugin automatically (uuyc `term` only supports Windows controlled endpoints).

### Other distribution methods

- **npm**: `pnpm publish` (configured with `prepublishOnly` to build `lib/` first), then `dsh plugin add @deepseek-ai/dsh-uuyc`.
- **tarball**: `pnpm pack` produces `dsh-uuyc-*.tgz`, then `dsh plugin add ./dsh-uuyc-*.tgz`.

## Development: local build & end-to-end test

```bash
pnpm build          # tsdown: src/*.ts → single lib/index.js (ESM) + lib/index.d.ts
pnpm typecheck      # tsc --noEmit (requires the @deepseek-ai/* peers; see note)
```

> `pnpm install` cannot fetch the peers on its own — `@deepseek-ai/dsh-tools` and `dsh-brand` are not on the public registry. Point `node_modules/@deepseek-ai/` at a local harness (or use a workspace install) before running `typecheck`. `pnpm build` does not need them: the peers are marked external, so only `typecheck` depends on their type declarations.

End-to-end test against a real device (UU Remote installed & logged in, controlled device online):

```bash
pnpm build
UUY_CLI=D:/uu/GameViewer/bin/uuyc-cli.exe UUY_DEVICE=<device-id> node scripts/e2e-real.mjs
```

## Features

The model-visible tool `uuyc_terminal`, dispatched by `action`:

| action | description |
|---|---|
| `list_devices` | List devices under the account (name / device ID / online status) |
| `connect` | Connect to a device (requires device ID; name is resolved automatically) |
| `disconnect` | Disconnect (ID required — never disconnects everything by accident) |
| `exec` | One-shot session: open → run command → close, returns stdout / exit code |
| `open_session` | Open a stateful session, returns `session_id` (idle auto-recycle) |
| `run_in_session` | Run one command in a given session |
| `kill_session` | Close a given session |
| `list_sessions` | List uuyc terminal sessions of a device |

## Prerequisites (important)

- **UU Remote desktop client must be running and logged in**, otherwise `exec`/`connect` etc. return exit code 2 and this plugin reports a clear hint.
- `uuyc-cli.exe` is not in a fixed location: on the author's machine it is `D:\uu\GameViewer\bin\uuyc-cli.exe`; docs also recorded `D:\Netease\GameViewer\bin\uuyc-cli.exe`, and the default install is `C:\Program Files\NetEase\GameViewer\bin\uuyc-cli.exe`. **Leave `cliPath` empty** and the plugin probes the candidate list in order; if none exist, set it explicitly in cordis.yml.
- **⚠️ No native file transfer**: `uuyc-cli`'s command surface (`version/user/device/cloudpc/echo/term/lterm/input-diag`) has no file-transfer subcommand. The `--upload`/`--pycode` flags seen online belong to the upper-layer `uu.py` wrapper, and base64 line-wrapping is unreliable. Transfer files via UU Remote's GUI, not this tool.

## Configuration (cordis.yml / profile patch)

```yaml
- id: uuyc
  name: '@deepseek-ai/dsh-uuyc'
  disabled: !!js process.platform !== 'win32'   # enable only on Windows host
  config:
    cliPath: ''                  # empty → auto-detect via PATH (`where`), running GameViewer.exe, then known install dirs
    defaultShell: powershell      # powershell | cmd
    execTimeoutMs: 120000
    controlTimeoutMs: 15000
    sessionIdleTtlMs: 600000
    password: ''                 # optional: unlock password for locked devices, sent as first stdin line
    handshakeRetries: 1          # auto retry on handshake failure (total attempts = 1 + retries)
    handshakeBackoffMs: 1500     # backoff base (ms); nth retry waits backoffMs * n
```

### Workflow hardening (built in)

- **CLI auto-discovery** — when `cliPath` is empty, the plugin probes in order: explicit config → `where uuyc-cli.exe` on PATH → the `bin\uuyc-cli.exe` next to the running `GameViewer.exe` process → a list of well-known install directories (`D:\uu`, `D:\Netease`, `C:\Program Files\NetEase`, …). You usually never need to set `cliPath`.
- **Device-list cache + fuzzy matching** — `device list` results are cached for 60s; `target` accepts a device name or ID and matches case-insensitively, with a substring fuzzy match. If the fuzzy match hits more than one device, the plugin lists the candidates instead of guessing.
- **Handshake auto-retry** — on `handshakeUnavailable` the plugin backs off and retries up to `handshakeRetries` times (handshake failures are usually transient — no active terminal on the controlled end, or a just-restarted P2P link).
- **Shell auto-fallback** — if the default `powershell` keeps failing the handshake, the plugin retries once on `cmd`; if `cmd` triggers `terminal_bridge_unavailable`, it falls back to the supported `powershell`.

## Troubleshooting: locked screen / handshake failure

- **Locked screen**: when the controlled endpoint is locked, `term` interactively asks for the unlock password. Two options: (1) unlock the screen on the remote first; (2) set `password` in config and the plugin sends it as the first stdin line. If neither, uuyc waits for the password on the PTY and the plugin times out (no crash, retry-able) — this is the expected graceful failure.
- **Terminal handshake failure ("controlled endpoint version too low" / "Start peer connection failed")**: means the controlled endpoint has no active terminal session, or the two ends have mismatched UU versions. Ask the user to open a UU terminal window on the remote Windows (wait a moment after a P2P restart), then retry. The plugin scans both stdout and stderr for these keywords, returns `handshakeUnavailable`, and (by default) **auto-retries once with backoff** instead of hanging until timeout.
- **`terminal_bridge_unavailable`**: the chosen shell isn't supported by the remote terminal bridge — most often when `shell: cmd` is requested. The plugin auto-falls back to `powershell`. If you explicitly need `cmd`, confirm the controlled endpoint actually supports it.
- ⚠️ `password` appears in cordis.yml and conversation logs; remind the user to change it after use.

## Architecture

- `src/uuyc.ts` — `uuyc-cli` wrapper: health check, device-list parsing, connect/disconnect, exit-code mapping.
- `src/session.ts` — `term` interactive session driver: sentinel detection, output cleaning (ANSI / echo stripping), exit-code parsing.
- `src/index.ts` — plugin entry: registers the `uuyc_terminal` tool, maintains the stateful session table, wires cancellation signals and idle recycle.
- `cordis.patch.yml` — bundle mount declaration, applied by the host when `dsh plugin add` runs.

## Known Limitations and Deferred Work

- **`term` is a session-style PTY**: there is no native "run one command and return" semantics. `session.ts` uses the sentinel `__UUYCDONE__<code>__` to split output and strip echoed lines; the interactive prompt / echo / encoding varies by shell and locale and **must be tuned on real hardware** (especially `UuycTerminal.wrap`'s sentinel writing).
- **Depends on the UU Remote desktop client**: when the client is not running / logged in, all commands return exit code 2; the plugin can only report and guide, not bypass.
- **No Linux support**: uuyc `term` only supports Windows controlled endpoints; Linux terminal servers are out of scope (see Platform limitation above).
- **`disconnect` without ID is global**: underlying semantics risk; this plugin enforces an ID to avoid it, but it must be continuously covered in docs and tests.
- **No native file transfer**: the CLI has no file-transfer subcommand; use UU Remote's GUI (see Prerequisites).
- **Lock-screen password is optional**: the `password` config is only needed for locked devices; leave empty for unlocked ones; the send logic is "first stdin line" and should be verified once on a locked real device.
- **End-to-end test done on real hardware**: `listDevices` + `execOnce` (powershell / native command) passed on device `便携`; full typecheck passed; handshake-failure / lock-screen password injection still need verification on a locked real device.

---

<a id="中文"></a>

# dsh-uuyc — UU 远程远程 Windows 控制插件（中文）

通过 [网易 UU 远程](https://uuyc.163.com/) 的 `uuyc-cli` 控制远程 Windows 设备：列出/连接/断开设备，并在远程终端执行命令。本插件只负责**本地调起 `uuyc-cli.exe` 并解析其结果**，认证与网络由已登录的 UU 远程主客户端承担。

> **平台限制**：`uuyc-cli` 的 `term` 远程终端**仅支持 Windows 被控端**。远程 Linux 服务器请使用 harness 原生 SSH 后端，不要走本插件。

## 安装（作为 DSH 组合包 / bundle）

直接用一行命令装进自己的 DSH profile：

```bash
dsh plugin --profile <你的profile> add github:luxus0946/dsh-uuyc
```

安装过程：DSH 从 GitHub 拉取本仓库，按 `cordis.patch.yml` 把 `uuyc` 插件挂载进 profile。**不再执行任何构建**——编译产物 `lib/` 已随仓库提交，这样源安装就不会失败（前置条件见下）。

> **前置条件：宿主版本需匹配。** 本插件消费宿主提供的 peer，要求宿主提供 `@deepseek-ai/dsh-tools@^0.1.6-alpha.2`、`@deepseek-ai/dsh-brand@^0.1.6-alpha.2`、`@deepseek-ai/cordis@^4.0.2`、`@deepseek-ai/schemastery@^3.18.2`。其中 dsh-tools / dsh-brand **未发布到公共 npm**（公共源上只有 `0.0.1-rc.1`），因此本插件只能在提供这些包的 harness 构建内加载 —— 即 harness 源码检出或内部构建版本；仅有公共 `dsh` 的外部用户无法使用。
>
> **仅 Windows 生效**：`cordis.patch.yml` 里 `disabled: !!js process.platform !== 'win32'`，非 Windows 主控端会自动跳过本插件（uuyc `term` 只支持 Windows 被控端）。

### 其它分发方式

- **发到 npm**：`pnpm publish`（已配置 `prepublishOnly` 会先构建 `lib/`），之后 `dsh plugin add @deepseek-ai/dsh-uuyc`。
- **交付 tar 包**：`pnpm pack` 生成 `dsh-uuyc-*.tgz`，再 `dsh plugin add ./dsh-uuyc-*.tgz`。

## 开发者：本地构建与联调

```bash
pnpm build          # tsdown：src/*.ts → 单文件 lib/index.js（ESM）+ lib/index.d.ts
pnpm typecheck      # tsc --noEmit 类型检查（需要 @deepseek-ai/* peer，见下方说明）
```

> `pnpm install` 无法自行拉取这些 peer —— `@deepseek-ai/dsh-tools` 与 `dsh-brand` 未发布到公共 npm。跑 `typecheck` 前请把 `node_modules/@deepseek-ai/` 指向本地 harness（或改用 workspace 安装）。`pnpm build` 不需要它们：peer 被标记为 external，只有 `typecheck` 依赖它们的类型声明。

端到端真机联调（需本机装好并登录 UU 远程、被控端在线）：

```bash
pnpm build
UUY_CLI=D:/uu/GameViewer/bin/uuyc-cli.exe UUY_DEVICE=<设备ID> node scripts/e2e-real.mjs
```

## 功能

模型可见工具 `uuyc_terminal`，按 `action` 分发：

| action | 说明 |
|---|---|
| `list_devices` | 列出账号下设备（名称 / 设备 ID / 在线状态） |
| `connect` | 连接设备（需设备 ID；名称会自动解析） |
| `disconnect` | 断开设备（**强制带 ID**，绝不误断全部） |
| `exec` | 一次性会话：开会话 → 执行命令 → 关闭，返回 stdout / exit code |
| `open_session` | 开启有状态会话，返回 `session_id`（空闲自动回收） |
| `run_in_session` | 在指定会话中执行一条命令 |
| `kill_session` | 关闭指定会话 |
| `list_sessions` | 列出某设备的 uuyc 终端会话 |

## 运行前提（重要）

- **UU 远程主客户端必须已运行并登录**，否则 `exec`/`connect` 等返回退出码 2，本插件会给出明确指引。
- `uuyc-cli.exe` 不在固定位置：本机实测为 `D:\uu\GameViewer\bin\uuyc-cli.exe`，文档也曾记录 `D:\Netease\GameViewer\bin\uuyc-cli.exe`，默认安装在 `C:\Program Files\Netease\GameViewer\bin\uuyc-cli.exe`。**配置 `cliPath` 留空即可**，插件会按这份候选清单依次查找第一个存在的路径；若都不存在再在 cordis.yml 显式指定。
- **⚠️ 无原生文件传输**：`uuyc-cli` 的命令面（`version/user/device/cloudpc/echo/term/lterm/input-diag`）不包含任何文件传输子命令，网上流传的 `--upload`/`--pycode` 都是上层 `uu.py` 封装的参数，且 base64 折行不可靠。传文件请走 UU 远程客户端的 GUI 互传，不要尝试用本工具传文件。

## 配置（cordis.yml / profile patch）

```yaml
- id: uuyc
  name: '@deepseek-ai/dsh-uuyc'
  disabled: !!js process.platform !== 'win32'   # 仅 Windows 主控端启用
  config:
    cliPath: ''                  # 留空→依次探测 PATH(`where`)、运行中的 GameViewer.exe 同目录、常见安装目录
    defaultShell: powershell      # powershell | cmd
    execTimeoutMs: 120000
    controlTimeoutMs: 15000
    sessionIdleTtlMs: 600000
    password: ''                 # 可选：被锁屏设备的解锁密码，作为 stdin 首行发送
    handshakeRetries: 1          # 握手失败时自动重试次数（总尝试 = 1 + 该值）
    handshakeBackoffMs: 1500     # 退避基数（毫秒），第 n 次重试等待 backoffMs * n
```

### 内置的工作流加固

- **CLI 路径自动发现**：`cliPath` 留空时，插件按序探测：显式配置 → PATH 上的 `where uuyc-cli.exe` → 正在运行的 `GameViewer.exe` 同目录 `bin\uuyc-cli.exe` → 一堆常见安装目录（`D:\uu`、`D:\Netease`、`C:\Program Files\NetEase` 等）。多数情况下无需手动配置 `cliPath`。
- **设备列表缓存 + 模糊匹配**：`device list` 结果缓存 60s；`target` 接受设备名或设备 ID，大小写不敏感，并支持子串模糊匹配。若模糊匹配命中多台设备，插件会列出候选清单而非盲目猜测。
- **握手自动重试**：命中 `handshakeUnavailable` 时，插件按退避策略重试最多 `handshakeRetries` 次（握手失败多为瞬态——被控端无活跃终端，或 P2P 刚重启）。
- **Shell 自动回退**：若默认 `powershell` 持续握手失败，插件会用 `cmd` 回退重试一次；若 `cmd` 触发 `terminal_bridge_unavailable`，则回退到受支持的 `powershell`。

## 被锁屏 / 握手失败的排错

- **锁屏**：被控端锁屏时 `term` 会交互式索要解锁密码。两种方式：(1) 先在远端解锁屏幕；(2) 在配置里填 `password`，插件会把密码作为 stdin 首行发送。若既未解锁也未配 `password`，uuyc 会在 PTY 上一直等密码，本插件表现为**执行超时**（不崩溃，可重试）——这是预期的优雅失败。
- **终端握手失败（"被控端版本过低" / "Start peer connection failed"）**：说明被控端当前没有活跃终端会话，或两端 UU 版本不匹配。让用户在远程 Windows 上打开一个 UU 终端窗口（P2P 刚重启则稍等片刻），再重试即可。插件会扫描 stdout + stderr 中的这些关键词，命中即返回 `handshakeUnavailable`，并（默认）**按退避自动重试一次**，无需等到超时。
- **`terminal_bridge_unavailable`**：所选 shell 不被远程终端桥支持——多见于显式指定 `shell: cmd`。插件会自动回退到 `powershell`；若确实需要 `cmd`，请先确认被控端确实支持。
- ⚠️ `password` 会出现在 cordis.yml 与对话记录里，使用后应提醒用户修改密码。

## 架构位置

- `src/uuyc.ts` — `uuyc-cli` 封装：健康检查、设备列表解析、连接/断开、退出码映射。
- `src/session.ts` — `term` 交互式会话驱动：哨兵串检测、输出清洗（ANSI/回显剥离）、退出码解析。
- `src/index.ts` — 插件入口：注册 `uuyc_terminal` 工具、维护有状态会话表、接入取消信号与空闲回收。
- `cordis.patch.yml` — 组合包挂载声明，`dsh plugin add` 时由宿主应用。

## 已知限制与待办工作

- **`term` 为会话式 PTY**：没有原生"执行一条命令并返回"语义。`session.ts` 用哨兵串 `__UUYCDONE__<code>__` 切分输出并剥离回显行；交互式终端的提示符/回显/编码因 shell 与区域而异，**必须在真机上调优**（尤其 `UuycTerminal.wrap` 的哨兵写法）。
- **依赖 UU 远程主程序**：主程序未运行/未登录时全部命令退出码 2，插件只能报错指引，无法绕过。
- **Linux 不支持**：uuyc `term` 仅支持 Windows 被控端，Linux 服务器终端不在本插件范围（见上方平台限制）。
- **`disconnect` 无 ID 即全局**：底层语义风险，本插件已强制带 ID 规避，但需在文档与测试中持续显式覆盖。
- **无原生文件传输**：CLI 无文件传输子命令，传文件请走 UU 客户端 GUI 互传（见运行前提）。
- **锁屏密码为可选特性**：`password` 配置项仅在被锁屏设备需要，未锁屏设备留空即可；发送逻辑为"作为 stdin 首行"，需在真机（锁屏态）验证一次。
- **已做端到端真机联调**：在设备`便携`上跑通 `listDevices` + `execOnce`（powershell / 原生命令），全量 `typecheck` 通过；握手失败/锁屏密码注入需在锁屏真机进一步验证。
