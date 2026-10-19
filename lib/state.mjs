/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩（抄 whale_craft）：**配置、凭证、报告、日志都放插件自己的家** ——
 * `$DSH_HOME/bili-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendored 的 `mcp_server.py` 里，凭证路径是
 * `Path(__file__).parent / "bili_credential.json"` —— 所以**运行时要把脚本拷到家目录里再跑**，
 * 这样凭证才会落在家的目录，而不是插件包里。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * ⭐ 官方口径（2026-09-10 起的新定价）：**高峰 = 工作日 9:00–12:00 与 14:00–18:00，其余全是谷时**
 *    ⇒ 12:00–14:00（夹在两个高峰之间）✓、18:00 之后的一整晚 ✓、以及**整个周末** ✓ 都便宜。
 * ⚠️ 我们原来写的 00:30–08:30 是 DeepSeek **早年**的错峰优惠时段，**已经过时** ✗
 *    —— 2026-10-14 使用者在"陌生人验收"里问「晚上峰谷真的是12点半才开始的吗」才查出来 ✓。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * ⭐ 2026-10-14 真机上踩到的坑（dsh 只留一句 `warning: 1 entry did not activate` + 堆栈）：
 *    `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`（whale_craft 就是这么用的）。
 *    我一开始当字符串用（`String(p)`），路径就成了「函数源码 + \bili-duty」⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-duty')                       // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * ⭐ 家目录可改（2026-10-19 用户要求："可以更改默认文件目录（它的地盘）"）
 * ============================================================================
 * 为什么要分两个目录：
 *   · **bootDir**（`$DSH_HOME/bili-duty`）—— 永远放 `config.json`。它是**启动时唯一能读到的文件**，
 *     家目录写在这里面；家目录要是也装 config，搬完就没人读得到它了 ⇒ 启动即失忆 ✗。
 *   · **dataDir**（用户可改）—— venv / 凭证 / 报告 / 日志 / 判重表 / 模型缓存都在这儿。
 *
 * 校验规矩（宁可不改，也别把家指到一个用不了的地方）：
 *   ① 必须是**绝对路径**（相对路径会跟着进程 cwd 漂，等于埋雷）；
 *   ② 不能指向插件包目录（升级会覆盖）；
 *   ③ 不能和 bootDir 互相包含（搬家的两端纠缠在一起会搬出半套数据）；
 *   ④ 建得出来、写得进去。
 * 任何一条不过 ⇒ 返回 `{ ok:false, reason }`，调用方保持原样并把原因说给用户。
 */
export function normalizeHomeDir(bootDir, raw, { pluginDir = '' } = {}) {
  const text = String(raw ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  if (!text) return { ok: true, dir: bootDir, custom: false, reason: '' }   // 空 = 用默认
  if (!isAbsolute(text)) return { ok: false, dir: bootDir, custom: false, reason: '要填绝对路径（比如 D:\\bili-duty）' }
  let dir
  try { dir = resolve(text) } catch (e) { return { ok: false, dir: bootDir, custom: false, reason: `路径看不懂：${e?.message ?? e}` } }
  const same = (a, b) => a.toLowerCase() === b.toLowerCase()
  if (same(dir, bootDir)) return { ok: true, dir: bootDir, custom: false, reason: '' }
  if (pluginDir && (same(dir, resolve(pluginDir)))) {
    return { ok: false, dir: bootDir, custom: false, reason: '不能放进插件自己的目录（升级会被覆盖）' }
  }
  const inside = (child, parent) => {
    const c = child.toLowerCase().replace(/[\\/]+$/, '')
    const p = parent.toLowerCase().replace(/[\\/]+$/, '')
    return c === p || c.startsWith(p + '\\') || c.startsWith(p + '/')
  }
  if (inside(dir, bootDir) || inside(bootDir, dir)) {
    return { ok: false, dir: bootDir, custom: false, reason: '新家不能和默认目录互相包含（搬家会搬乱）' }
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.write-test'), 'ok', 'utf8')
    rmSync(join(dir, '.write-test'), { force: true })
  } catch (e) {
    return { ok: false, dir: bootDir, custom: false, reason: `建不出来 / 写不进去：${e?.message ?? e}` }
  }
  return { ok: true, dir, custom: true, reason: '' }
}

/** 家里那些**必须预先存在**的目录（值是「沙箱只让写启动前就有的目录」这条老规矩） */
export function ensureDataDirs(dataDir, extra = []) {
  const dirs = [dataDir, join(dataDir, 'out'), join(dataDir, 'digest'), join(dataDir, 'tmp', 'asr'), join(dataDir, 'bin'), ...extra]
  for (const d of dirs) { try { mkdirSync(d, { recursive: true }) } catch { /* 建不了别拦着插件加载 */ } }
}

/** 临时产物名（搬家时跳过；也是登录二维码的落盘名，见 lib/qr.mjs） */
export const QR_TMP_NAMES = ['qrcode_login.png']

/**
 * 搬家：把老家**能搬的那部分**复制到新家（**不搬 venv**）。
 * ⚠️ 为什么 venv 不搬：Windows 的 venv 里钉着**绝对路径**（`pyvenv.cfg`、Scripts/*.exe 里嵌的解释器路径、
 *    site-packages 的 .pth）—— 复制过去看着有 `python.exe`，一跑就找错解释器 / 找不到包 ✗
 *    （2026-10-19 实测确认过，别再"顺手 cpSync 一下就完事"）。
 *    ⇒ 搬完设置页会显示「环境未就绪」，让用户点一次「装主依赖」重建（几十秒，走国内镜像）。
 * ⚠️ 只复制、**不删**老家的东西：用户自己确认没用了再删，我们不动手。
 */
export function migrateData(fromDir, toDir, log = () => {}) {
  const copied = []
  if (!fromDir || !toDir) return copied
  let sameDir = false
  try { sameDir = resolve(fromDir).toLowerCase() === resolve(toDir).toLowerCase() } catch { sameDir = false }
  if (sameDir) return copied
  // ⚠️ 这几个**不搬**：
  //   .venv / .venv-asr / bin —— venv 与 uv.exe 都钉着绝对路径（见上面的解释）
  //   config.json           —— 它是**启动入口**，必须留在 bootDir；搬一份到新家只会变成诱饵 ✗
  //   qrcode_login.png      —— 一次性产物，搬过去就是一张过期二维码
  const skip = new Set(['.venv', '.venv-asr', 'bin', 'config.json', QR_TMP_NAMES[0], '.write-test'])
  let entries = []
  try { entries = readdirSync(fromDir, { withFileTypes: true }) }
  catch (e) { log(`搬家：读不了老家 ${fromDir}（${e?.message ?? e}）`); return copied }
  for (const ent of entries) {
    if (skip.has(ent.name)) continue
    const src = join(fromDir, ent.name)
    const dst = join(toDir, ent.name)
    try {
      if (ent.isDirectory()) {
        cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
      } else {
        if (existsSync(dst)) continue                    // 新家已有的不覆盖（宁可留着新的）
        cpSync(src, dst, { force: false, errorOnExist: false })
      }
      copied.push(ent.name)
    } catch (e) { log(`搬家：${ent.name} 没搬成（${e?.message ?? e}）`) }
  }
  if (copied.length) log(`搬家：从 ${fromDir} 复制 ${copied.length} 项到 ${toDir}（${copied.slice(0, 8).join('、')}${copied.length > 8 ? '…' : ''}）`)
  else log(`搬家：${fromDir} 里没有可搬的东西（或全被跳过了）`)
  return copied
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 首次运行：把 vendored 的脚本拷进家里（脚本变了就覆盖）。章程不在这里 —— 它走下面的 ensureCharter */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const copies = [
    [join(pluginDir, 'vendor', 'bilibili-mcp', 'mcp_server.py'), join(stateDir, 'mcp_server.py'), true],
    [join(pluginDir, 'lib', 'asr.py'), join(stateDir, 'asr.py'), true],
  ]
  for (const [from, to, overwrite] of copies) {
    try {
      if (!existsSync(from)) { log(`缺文件：${from}`); continue }
      if (!overwrite && existsSync(to)) continue
      if (overwrite && existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) continue
      copyFileSync(from, to)
      log(`已铺好：${to}`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
}

/**
 * 值班章程（prompts/duty.md）放在哪一份 —— 家里那份优先，没有才用插件里那份。
 * （家里那份由下面的 ensureCharter 保证铺好）
 */
export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  try { if (existsSync(home)) return home } catch { /* 兜底：用插件里那份 */ }
  return join(pluginDir, 'prompts', 'duty.md')
}

/**
 * ⭐ 值班章程怎么升级 —— 2026-10-17 审查里的 M6 就是这里。
 *    老规矩（index.js 里比 mtime）：家里那份比 shipped 新 ⇒ 听使用者的。听着合理，实际是一把**单向锁**：
 *    使用者只要改过章程一个字，家里那份就永远比 shipped 新 ⇒ 插件后续版本改进的章程
 *    （0.1.5 的注入防护、空输出定义恰好就写在章程里）**永远进不来** ✗。
 *    改成记账制 —— 上次铺的是哪一版（sha256）记在 charter.sha256：
 *      · 家里那份 === 我们上次铺的 ⇒ 他没动过 ⇒ 直接用 shipped 覆盖（升级 ✓）
 *      · 家里那份变过      ⇒ 他改过 ⇒ **一个字都不动**，新版另存 duty.md.new 让他自己合 ✓
 *      · 没有账本（带账本的第一个版本刚跑起来）⇒ 分不清「没改只是版本旧」和「改过」，
 *        按「改过」处理 —— 宁可让他手动合一次，也不能偷偷吃掉他的改动 ✓
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {                              // 家里那份就是最新版（他可能只是没动过）
      if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8')
      return
    }
    if (!hLast || hHome !== hLast) {                    // 他改过（或没账本、分不清）⇒ 只另存新版
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')   // 他没动过 ⇒ 直接升级
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 'HH:MM' → 当天的分钟数 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，比如 23:00–02:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

