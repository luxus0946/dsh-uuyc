// tsdown 在单入口 + dts 模式下会把声明文件命名为带 content-hash 的名字
// （如 index-r9qhy9is.d.ts），但 package.json 的 types/exports 指向固定的
// lib/index.d.ts。本脚本把那个带 hash 的 .d.ts 重命名为 index.d.ts，
// 让类型入口稳定可解析。
import { readdirSync, renameSync, existsSync } from 'node:fs'

const dir = 'lib'
if (!existsSync(dir)) {
  console.error('lib/ not found; run tsdown first')
  process.exit(1)
}

let renamed = false
for (const f of readdirSync(dir)) {
  if (/^index-.*\.d\.ts$/.test(f)) {
    renameSync(`${dir}/${f}`, `${dir}/index.d.ts`)
    console.log(`renamed ${f} -> index.d.ts`)
    renamed = true
  }
}

if (!renamed && !existsSync(`${dir}/index.d.ts`)) {
  console.error('no index.d.ts produced by tsdown')
  process.exit(1)
}
