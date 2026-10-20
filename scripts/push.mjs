/**
 * scripts/push.mjs —— 把工作区推到你自己的 GitHub 仓库（走 REST API，不吃 git 通道）
 * ============================================================================
 * 为什么不用 `git push`：这台机器上 `github.com` 的 git 通道被网络挡住（TLS 重置），
 * 但 `api.github.com` 是通的 ⇒ 用 Git Data API 建 blobs/tree/commit，再 force 更新 main。
 *
 * 用法：
 *   node scripts/push.mjs "提交说明"
 *   node scripts/push.mjs "提交说明" --root      # 重写成单个根提交（清历史）
 *
 * token 从哪来：默认读 Windows 凭据管理器里已存的 GitHub 登录
 *   （`git credential fill`）。也可以直接给环境变量 GH_TOK。
 *   仓库：默认 FunnyMudXD/dsh-bili-scroll（可用 GH_OWNER / GH_REPO 覆盖）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const MSG = argv.find((a) => !a.startsWith('--')) || 'chore: update'
const ROOT_MODE = argv.includes('--root')

function token() {
  if (process.env.GH_TOK) return process.env.GH_TOK
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    const m = /^password=(.*)$/m.exec(out)
    if (m) return m[1].trim()
  } catch { /* 没有就走下面 */ }
  console.error('✗ 拿不到 token：请先 gh auth login，或设环境变量 GH_TOK')
  process.exit(1)
}

const TOKEN = token()
const OWNER = process.env.GH_OWNER || 'FunnyMudXD'
const NAME = process.env.GH_REPO || 'dsh-bili-scroll'
const API = 'https://api.github.com'
const H = { Authorization: `token ${TOKEN}`, 'User-Agent': 'dsh-bili-scroll-workspace', Accept: 'application/vnd.github+json' }

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  let j = null
  try { j = t ? JSON.parse(t) : null } catch { /* 非 JSON */ }
  if (!r.ok) {
    const msg = (j && (j.message || j.errors)) || t.slice(0, 200)
    const e = new Error(`${method} ${path} → ${r.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
    e.status = r.status
    throw e
  }
  return j
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '__pycache__' || name === '.git' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else out.push({ path: relative(base, p).split('\\').join('/'), file: p })
  }
  return out
}

const files = walk(ROOT)
console.log(`本地 ${files.length} 个文件 → ${OWNER}/${NAME}`)

try { await api('GET', `/repos/${OWNER}/${NAME}`) } catch (e) {
  if (e.status !== 404) throw e
  await api('POST', '/user/repos', { name: NAME, private: false, has_issues: true, auto_init: false })
  console.log('新建了仓库')
}

// 空仓库要先有一个提交，Git Data API 才肯干活
try { await api('GET', `/repos/${OWNER}/${NAME}/contents/README.md`) } catch (e) {
  if (e.status !== 404) throw e
  await api('PUT', `/repos/${OWNER}/${NAME}/contents/README.md`, {
    message: 'chore: 初始化仓库', content: Buffer.from('# dsh-bili-scroll\n').toString('base64'),
  })
}

const tree = []
for (const f of files) {
  const blob = await api('POST', `/repos/${OWNER}/${NAME}/git/blobs`, {
    content: readFileSync(f.file).toString('base64'), encoding: 'base64',
  })
  tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha })
  process.stdout.write('.')
}
console.log(`\nblobs ${tree.length} 个`)

const newTree = await api('POST', `/repos/${OWNER}/${NAME}/git/trees`, { tree })

let headSha = null
try { headSha = (await api('GET', `/repos/${OWNER}/${NAME}/git/ref/heads/main`)).object.sha } catch { /* 空仓库 */ }
const parents = (ROOT_MODE || !headSha) ? [] : [headSha]

const commit = await api('POST', `/repos/${OWNER}/${NAME}/git/commits`, { message: MSG, tree: newTree.sha, parents })
if (headSha) await api('PATCH', `/repos/${OWNER}/${NAME}/git/refs/heads/main`, { sha: commit.sha, force: true })
else await api('POST', `/repos/${OWNER}/${NAME}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })

console.log(`\n✅ https://github.com/${OWNER}/${NAME}`)
console.log(`   提交 ${commit.sha.slice(0, 7)} · ${tree.length} 个文件`)
if (ROOT_MODE) console.log('   （已重写成单个根提交，历史被清空）')
