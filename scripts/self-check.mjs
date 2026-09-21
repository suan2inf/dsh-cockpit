#!/usr/bin/env node
/**
 * 插件自身一致性检查（npm run check 的一部分）。
 *
 * 防的是 2026-09-22 事故：包名改成带 scope 的 @suan2inf/dsh-cockpit 后，
 * client.js 里的注册 id 没跟上，浏览器端 client-modules 加载器按包名查注册
 * 查不到，整个 Web 客户端白屏（宿主却完全正常，极难排查）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
let failures = 0

function check(label, ok, detail) {
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${label}${ok ? '' : `\n       ${detail}`}`)
  if (!ok) failures++
}

// 1. client 注册 id === npm 包名（含 scope）——白屏事故的根因检查
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
check(
  'client.js 注册 id 与包名一致',
  client.includes(`id: "${pkg.name}"`) || client.includes(`id: '${pkg.name}'`),
  `client.js 的 __ModuleLoader__.load id 必须是 "${pkg.name}"（包名含 scope）`,
)

// 2. cordis.patch.yml 的 insert name === 包名
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
check(
  'cordis.patch.yml insert name 与包名一致',
  patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`),
  `cordis.patch.yml 的 name 必须是 '${pkg.name}'`,
)

// 3. exports 里声明的文件都存在
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== 'string' || key === './package.json') continue
  let exists = true
  try { readFileSync(join(ROOT, target)) } catch { exists = false }
  check(`exports["${key}"] 文件存在: ${target}`, exists, '文件缺失')
}

// 4. bin 指向的文件存在且有 shebang（npm 会砍掉不合法的 bin）
for (const [cmd, target] of Object.entries(pkg.bin ?? {})) {
  let head = ''
  try { head = readFileSync(join(ROOT, target), 'utf8').slice(0, 40) } catch { /* 下面统一报 */ }
  check(`bin ${cmd} -> ${target} 存在且带 shebang`, head.startsWith('#!'), '文件缺失或缺 #!/usr/bin/env node')
}

process.exit(failures === 0 ? 0 : 1)
