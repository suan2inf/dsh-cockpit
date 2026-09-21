/**
 * dsh-cockpit 命令行入口：node cli.mjs（或 npx dsh-cockpit） [选项]
 *
 *   --online            额外做 git fetch 和 GitHub release 查询
 *   --json              输出结构化 JSON（供 agent / 脚本消费）
 *   --gate              只输出更新门禁结论；退出码 0=安全 1=有风险或有 error 级问题
 *   --fixes             列出全部修复项及当前是否需要修
 *   --fix <id> [--yes]  执行一个修复（moderate 风险的需要 --yes）
 *
 * 普通模式退出码：0 = 无 error；1 = 存在 error 级检查项。修复模式退出码：0 = 修复成功。
 */
import { runCockpit } from './core/cockpit-core.mjs'
import { assessAllFixes, applyFix, getFixMeta } from './core/cockpit-fixes.mjs'

const args = process.argv.slice(2)
const online = args.includes('--online')
const asJson = args.includes('--json')
const gateOnly = args.includes('--gate')
const fixIndex = args.indexOf('--fix')
const fixId = fixIndex !== -1 ? args[fixIndex + 1] : null

if (args.includes('--fixes')) {
  const fixes = await assessAllFixes()
  for (const f of fixes) {
    console.log(`${f.needed ? '[需要]' : '[ -- ]'} ${f.id}  ${f.title}`)
    console.log(`        ${f.note}${f.description ? `\n        ${f.description}` : ''}`)
  }
  process.exit(fixes.some((f) => f.needed) ? 1 : 0)
}

if (fixId) {
  const meta = getFixMeta(fixId)
  if (!meta) {
    console.error(`未知修复项: ${fixId}。用 --fixes 查看可用列表。`)
    process.exit(2)
  }
  if (meta.risk === 'moderate' && !args.includes('--yes')) {
    console.error(`${meta.title} 是 ${meta.risk} 风险操作：${meta.description}`)
    console.error('确认后加 --yes 再执行。')
    process.exit(2)
  }
  console.log(`执行修复: ${meta.title} ...`)
  const result = await applyFix(fixId)
  console.log(result.ok ? `[ OK ] ${result.message}` : `[FAIL] ${result.message}`)
  if (result.details) console.log(result.details)
  process.exit(result.ok ? 0 : 1)
}

const report = await runCockpit({ online })

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const ICON = { ok: '[ OK ]', info: '[INFO]', warn: '[WARN]', error: '[FAIL]' }
  const color = process.stdout.isTTY
    ? { ok: (s) => `[32m${s}[0m`, info: (s) => `[36m${s}[0m`, warn: (s) => `[33m${s}[0m`, error: (s) => `[31m${s}[0m` }
    : { ok: (s) => s, info: (s) => s, warn: (s) => s, error: (s) => s }

  console.log('')
  console.log('==================================================')
  console.log('  DSH Cockpit - 体检报告')
  console.log(`  版本: ${report.dshVersion ?? '?'}   时间: ${report.startedAt}`)
  console.log(`  仓库: ${report.repo}`)
  console.log('==================================================')
  console.log('')

  if (!gateOnly) {
    for (const c of report.checks) {
      console.log(color[c.level](`${ICON[c.level] ?? '[????]'} ${c.title}`))
      if (c.detail && c.level !== 'ok' && c.level !== 'info') {
        for (const line of String(c.detail).split('\n')) console.log(`       ${line}`)
      }
      if (c.remedy && (c.level === 'warn' || c.level === 'error')) {
        for (const line of String(c.remedy).split('\n')) console.log(color.warn(`       -> ${line}`))
      }
    }
    console.log('')
    console.log(`  汇总: ${report.summary.ok} 通过 / ${report.summary.info} 提示 / ${report.summary.warn} 警告 / ${report.summary.error} 失败`)
    console.log('')
  }

  console.log(color[report.gate.level]('--------------------------------------------------'))
  console.log(color[report.gate.level](`  更新门禁: ${report.gate.title}`))
  if (report.gate.detail) {
    for (const line of String(report.gate.detail).split('\n')) console.log(color[report.gate.level](`  ${line}`))
  }
  console.log(color[report.gate.level]('--------------------------------------------------'))
}

process.exit(gateOnly
  ? (report.gate.level === 'ok' && report.summary.error === 0 ? 0 : 1)
  : (report.summary.error > 0 ? 1 : 0))
