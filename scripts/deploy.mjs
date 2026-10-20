/**
 * scripts/deploy.mjs —— 把工作区里的这份代码「装上」到 dsh 的桌面 profile
 * ============================================================================
 * 用途：改完代码 → `node scripts/deploy.mjs` → 重启 dsh 生效。
 *   · 先备份到 `<profile>/node_modules/.dsh-bili-scroll.bak/`（只留最近一份）
 *   · 只同步插件自己的文件（不动 node_modules / .venv / 用户数据）
 *   · **不重启 dsh**（重启要你自己来：宿主半端和 client bundle 都得重新组装）
 *
 * 用法：
 *   node scripts/deploy.mjs                 # 部署到默认桌面 profile
 *   node scripts/deploy.mjs --profile web   # 部署到别的 profile
 */
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const profileArg = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : 'desktop'
const DST = join(homedir(), '.dsh', 'profiles', profileArg, 'node_modules', 'dsh-bili-scroll')

if (!existsSync(DST)) {
  console.error(`✗ 目标不存在：${DST}\n  先装一次插件：dsh plugin --profile ${profileArg} add github:FunnyMudXD/dsh-bili-scroll`)
  process.exit(1)
}

// 备份（只留最近一份，避免越堆越大）
const BAK = join(dirname(DST), '.dsh-bili-scroll.bak')
try {
  rmSync(BAK, { recursive: true, force: true })
  cpSync(DST, BAK, { recursive: true })
  console.log(`✓ 已备份到 ${BAK}`)
} catch (e) { console.log(`⚠️ 备份失败（不影响部署）：${e.message}`) }

// 同步：只认插件自己的这些（跟 package.json 的 files 对齐）
const KEEP = ['index.js', 'client.js', 'README.md', 'LICENSE', 'package.json', 'cordis.patch.yml', 'selfcheck.mjs', 'lib', 'prompts', 'vendor', 'docs']
let n = 0
for (const name of KEEP) {
  const from = join(SRC, name)
  if (!existsSync(from)) continue
  const to = join(DST, name)
  const st = statSync(from)
  try {
    if (st.isDirectory()) { cpSync(from, to, { recursive: true }); n += readdirSync(from).length }
    else { cpSync(from, to); n += 1 }
  } catch (e) { console.error(`✗ 拷 ${name} 失败：${e.message}`) }
}
console.log(`✓ 已部署 ${n} 项 → ${DST}`)
console.log('\n⚠️ 还要做一件事：**重启 dsh**（宿主半端与 client bundle 都要重新组装才生效）')
console.log('   只刷新页面没用；改的是 index.js / lib / vendor 里的东西必须重启。')
