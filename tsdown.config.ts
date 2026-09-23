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
  external: [/^@deepseek-ai\//, /^node:/],
})
