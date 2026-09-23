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

This repository is a **self-contained installable bundle**. Others don't need to clone the source or pull the whole deepseek-harness monorepo — they install it into their own DSH profile with one command:

```bash
dsh plugin --profile <your-profile> add github:luxus0946/dsh-uuyc
```

What happens: DSH clones this repo → runs `pnpm install` → runs the `prepare` script (tsdown) to compile `src/` into a self-contained `lib/` → mounts the `uuyc` plugin into the profile according to `cordis.patch.yml`.

> **pnpm ≥ 10 requires build-script approval**: pnpm 10 blocks dependency `prepare`/build scripts by default. If you see "ignored build scripts" on first install, grant `allowBuilds` for `@deepseek-ai/*` and this package, otherwise `lib/` won't be generated and the plugin won't load.
>
> **Windows only**: `cordis.patch.yml` sets `disabled: !!js process.platform !== 'win32'`, so non-Windows hosts skip this plugin automatically (uuyc `term` only supports Windows controlled endpoints).

### Other distribution methods

- **npm**: `pnpm publish` (configured with `prepublishOnly` to build `lib/` first), then `dsh plugin add @deepseek-ai/dsh-uuyc`.
- **tarball**: `pnpm pack` produces `dsh-uuyc-*.tgz`, then `dsh plugin add ./dsh-uuyc-*.tgz`.

## Development: local build & end-to-end test

```bash
pnpm install        # install @deepseek-ai/* runtime (peers, provided by host; here only for build/typecheck)
pnpm build          # tsdown: src/*.ts → single lib/index.js (ESM) + lib/index.d.ts
pnpm typecheck      # tsc --noEmit
```

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
    cliPath: ''                  # empty → auto-detect D:\uu / D:\Netease / C:\Program Files\Netease etc.
    defaultShell: powershell      # powershell | cmd
    execTimeoutMs: 120000
    controlTimeoutMs: 15000
    sessionIdleTtlMs: 600000
    password: ''                 # optional: unlock password for locked devices, sent as first stdin line
```

## Troubleshooting: locked screen / handshake failure

- **Locked screen**: when the controlled endpoint is locked, `term` interactively asks for the unlock password. Two options: (1) unlock the screen on the remote first; (2) set `password` in config and the plugin sends it as the first stdin line. If neither, uuyc waits for the password on the PTY and the plugin times out (no crash, retry-able) — this is the expected graceful failure.
- **Terminal handshake failure ("controlled endpoint version too low" / "Start peer connection failed")**: means the controlled endpoint has no active terminal session, or the two ends have mismatched UU versions. Ask the user to open a UU terminal window on the remote Windows (wait a moment after a P2P restart), then retry. The plugin scans both stdout and stderr for these keywords and returns `handshakeUnavailable` instead of hanging until timeout.
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

本仓库是一个**自包含的可安装 bundle**：别人无需克隆源码、无需把整个 deepseek-harness monorepo 拉下来，直接用一行命令装进自己的 DSH profile：

```bash
dsh plugin --profile <你的profile> add github:luxus0946/dsh-uuyc
```

安装过程：DSH 会从 GitHub 拉取本仓库 → 执行 `pnpm install` → 跑 `prepare` 脚本（即 `tsdown`）把 `src/` 编译成自包含的 `lib/` → 按 `cordis.patch.yml` 把 `uuyc` 插件挂载进 profile。

> **pnpm ≥ 10 需授权构建脚本**：pnpm 10 默认禁止自动执行依赖的 `prepare`/构建脚本。首次安装若提示 "ignored build scripts"，请对 `@deepseek-ai/*` 与本项目授予 `allowBuilds`（或在安装时按提示选择允许），否则 `lib/` 不会生成、插件加载会失败。
>
> **仅 Windows 生效**：`cordis.patch.yml` 里 `disabled: !!js process.platform !== 'win32'`，非 Windows 主控端会自动跳过本插件（uuyc `term` 只支持 Windows 被控端）。

### 其它分发方式

- **发到 npm**：`pnpm publish`（已配置 `prepublishOnly` 会先构建 `lib/`），之后 `dsh plugin add @deepseek-ai/dsh-uuyc`。
- **交付 tar 包**：`pnpm pack` 生成 `dsh-uuyc-*.tgz`，再 `dsh plugin add ./dsh-uuyc-*.tgz`。

## 开发者：本地构建与联调

```bash
pnpm install        # 安装 @deepseek-ai/* 运行时（peer，由宿主提供；此处仅为构建/类型检查）
pnpm build          # tsdown：src/*.ts → 单文件 lib/index.js（ESM）+ lib/index.d.ts
pnpm typecheck      # tsc --noEmit 类型检查
```

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
    cliPath: ''                  # 留空→自动查找 D:\uu / D:\Netease / C:\Program Files\Netease 等
    defaultShell: powershell      # powershell | cmd
    execTimeoutMs: 120000
    controlTimeoutMs: 15000
    sessionIdleTtlMs: 600000
    password: ''                 # 可选：被锁屏设备的解锁密码，作为 stdin 首行发送
```

## 被锁屏 / 握手失败的排错

- **锁屏**：被控端锁屏时 `term` 会交互式索要解锁密码。两种方式：(1) 先在远端解锁屏幕；(2) 在配置里填 `password`，插件会把密码作为 stdin 首行发送。若既未解锁也未配 `password`，uuyc 会在 PTY 上一直等密码，本插件表现为**执行超时**（不崩溃，可重试）——这是预期的优雅失败。
- **终端握手失败（"被控端版本过低" / "Start peer connection failed"）**：说明被控端当前没有活跃终端会话，或两端 UU 版本不匹配。让用户在远程 Windows 上打开一个 UU 终端窗口（P2P 刚重启则稍等片刻），再重试即可。插件会扫描 stdout + stderr 中的这些关键词，命中即返回 `handshakeUnavailable`，无需等到超时。
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
