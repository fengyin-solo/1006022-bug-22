// 极简测试运行器：用仓库已装的 esbuild 把 TS 测试文件打成 ESM，再交给 Node 执行。
// 纯前端项目没有引入 vitest/jest，避免新增依赖。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const entries = ['shuttle.test.ts', 'shuttle-service.test.ts'].map((name) =>
  path.join(root, 'test', name),
)

for (const entry of entries) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    alias: { '@': path.join(root, 'src') },
  })
  const code = result.outputFiles[0].text
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
  try {
    await import(dataUrl)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
