// 端到端真机联调：直接调用【构建后的插件代码】lib/index.js，对真实设备跑通。
// 验证：(1) listDevices 的 TSV 解析；(2) execOnce 的完整帧解析（ANSI 剥离 + 退出码捕获）。
//
// 用法（需在本机已装好 UU 远程客户端并登录、且被控端在线）：
//   UUY_CLI=D:/uu/GameViewer/bin/uuyc-cli.exe UUY_DEVICE=<设备ID> node scripts/e2e-real.mjs
// 不传则使用默认值；设备 ID 请从 `uuyc-cli device list` 或 DSH 的 list_devices 获取。
import { UuycCli, execOnce } from '../lib/index.js'

const cliPath = process.env.UUY_CLI || 'D:/uu/GameViewer/bin/uuyc-cli.exe'
const deviceId = process.env.UUY_DEVICE || ''

const cli = new UuycCli(cliPath)

async function main() {
  console.log('--- listDevices (TSV parse) ---')
  try {
    const devices = await cli.listDevices(15000)
    console.log('device count:', devices.length)
    if (deviceId) {
      const b = devices.find((d) => d.deviceId === deviceId)
      console.log('target found:', JSON.stringify(b))
    }
  } catch (e) {
    console.log('listDevices ERROR:', e?.message ?? e)
  }

  if (!deviceId) {
    console.log('（未设置 UUY_DEVICE，跳过 exec 验证）')
    return
  }

  console.log('--- execOnce (powershell cmdlet) ---')
  try {
    const r1 = await execOnce(cliPath, deviceId, 'powershell', 'echo e2e_hello', 30000)
    console.log('cmdlet ->', JSON.stringify(r1))
  } catch (e) {
    console.log('exec cmdlet ERROR:', e?.message ?? e)
  }

  console.log('--- execOnce (native exit code) ---')
  try {
    const r2 = await execOnce(cliPath, deviceId, 'powershell', 'cmd /c exit /b 7', 30000)
    console.log('native ->', JSON.stringify(r2))
  } catch (e) {
    console.log('exec native ERROR:', e?.message ?? e)
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
