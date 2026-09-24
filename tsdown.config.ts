import { defineConfig } from 'tsdown'

/**
 * 独立 bundle 构建：把插件自己的 src/*.ts 打包成单个 lib/index.js（ESM），
 * 运行时宿主（deepseek-harness）提供的 @deepseek-ai/* 包一律 external，
 * 避免 cordis / dsh-tools 出现重复实例（cordis 插件系统要求单一实例）。
 * 同时生成 lib/index.d.ts 类型声明。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  // 强制输出 .js / .d.ts（而非 ESM 默认的 .mjs / .d.mts），
  // 与 package.json 的 main/types 约定保持一致，避免宿主按 lib/index.js 解析失败。
  outExtensions() {
    return { js: '.js', dts: '.d.ts' }
  },
  external: [/^@deepseek-ai\//, /^node:/],
})
