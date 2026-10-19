/**
 * dsh-bili-scroll —— host 半端
 * ============================================================================
 * 它是什么：每天替你刷一轮 B站 的插件版。
 *   1. **插件内部起那份 Python MCP**（`vendor/bilibili-mcp/mcp_server.py`），把它的能力
 *      注册成 dsh 工具（搜 / 字幕 / 评论 / 发评论 @ 人 / 登录检查）—— 用户不用再手改 profile。
 *   2. **谷时定时器**：中午 12:00–14:00、夜间 00:30–08:30（`lib/state.mjs` 里的 `WINDOWS`），
 *      开了哪个窗口才在哪个窗口自动跑；「定量刷」的数字是**每天总量上限**。
 *   3. **跑一轮** = 起一个 `dsh --profile headless <prompt>`（跟老方案同一条路，已被验证过），
 *      把 `duty.md` 交给它，报告写进 `<家>/out/<日期>.md`。
 *   4. **设置页**（`client.js`）通过 `/api/bili-duty/*` 读写配置、看状态、扫码登录。
 *
 * 家里（`$DSH_HOME/bili-duty/`）都有什么：`config.json` / `mcp_server.py`（从 vendor 铺过来，
 * 这样凭证 `bili_credential.json` 落在家里而不是插件包里）/ `duty.md` / `out/` / `duty.log`。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因（2026-10-16 用户递来的完整报告 + 本机复现）：它们是 optional peer，
//    桌面版 profile 是 `autoInstallPeers: false` ⇒ 永远不装 ⇒ **裸 import 会让整条插件不激活** ✗。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { McpClient } from './lib/mcp.mjs'
import { verifyRecent, appendVerifyToReport } from './lib/verify.mjs'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, dayKey,
  normalizeHomeDir, ensureDataDirs, migrateData } from './lib/state.mjs'
import { loginStart, loginPoll, saveCredential } from './lib/login.mjs'
import { renderQr } from './lib/qr.mjs'
import { readInteracted, appendInteracted, tripledCountOn, findTripled } from './lib/interact.mjs'
import { scanReplies, recordReplied } from './lib/replies.mjs'
import { classifyVideo, kindLabel } from './lib/classify.mjs'
import { ensureUv } from './lib/uvfetch.mjs'

export const name = 'bili-scroll'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。另外两个条件是：
 *    **loader entry 的 id 必须等于命名空间名**（我们 patch 里就是 `bili-scroll`）+ **本模块导出 Config**。
 */
// ⚠️ schemastery 彻底拿不到时，这里会是 undefined —— **插件照常加载**，只是设置页降级
//    （宁可少一个设置页，也不能因为一个 import 让整条插件不激活 ✗）
export const Config = !z ? undefined : z.object({
  /**
   * ⭐ 总开关（2026-10-19 加）：**刷B站服务**的电源。
   *   ⚠️ 名字故意不叫 `enabled` —— 那是 cordis patch 里"插件装没装"的字段，同名容易混。
   *   关掉时：谷时定时器不跑、手动「跑一轮」拒绝、`bili_reply` 拒绝（除非 force）；
   *   但仍然**读得到**状态 / 设置 / 日志（不然关了就再也打不开了 ✗）。
   */
  serviceOn: z.boolean().default(true).extra('volatile', true),
  /** 定量刷：每天最多挑几条（**全天总量**） */
  perDay: z.natural().default(5).extra('volatile', true),
  /** ⭐ 一轮最多挑几条（**单轮上限**；0 = 不单独限制，用当天剩余额度）。
   *  2026-10-19 用户要求：「一轮挑几条」和「一天挑几条」分开配 —— 自动轮频繁跑时，
   *  用 perRound 控单轮节奏（比如一天 20 条、每轮 5 条），而 perDay 守全天总量。 */
  perRound: z.natural().default(0).extra('volatile', true),
  /** 峰谷自动刷（总开关） */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 / 晚上 */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /** 自动评论 @ 使用者（默认关 —— 会拿用户的号说话，必须他自己开） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /* ⭐ 顺手三连（2026-10-19 加）—— **一律默认关**：会花硬币、会动别人的视频。
   *    tripleOn          总开关（关着时提示词里连"三连"两个字都不出现）
   *    tripleCoin        每条投几枚币（1 或 2）
   *    triplePerDay      每天最多三连几条（**独立配置**，0 = 不三连）
   *    tripleFavMediaId  收藏到哪个收藏夹（0 = 默认收藏夹；>0 时自动改走分步）
   *    tripleSay         评论里要不要说明已三连（只在真的成功时才说） */
  tripleOn: z.boolean().default(false).extra('volatile', true),
  tripleCoin: z.natural().default(1).extra('volatile', true),
  triplePerDay: z.natural().default(5).extra('volatile', true),
  tripleFavMediaId: z.natural().default(0).extra('volatile', true),
  tripleSay: z.boolean().default(true).extra('volatile', true),
  /** ⭐ 私信投递：off=只发评论（现状）· only=只私信（完全不公开评论）· both=评论 + 私信 */
  dmMode: z.string().default('off').extra('volatile', true),
  /** ⭐ 私信发给谁的 UID（数字）。要在 dmMode 不是 off 时填 */
  dmUid: z.natural().default(0).extra('volatile', true),
  /** 本地转写（没字幕的视频用 Whisper 转；默认关，要下模型） */
  transcribe: z.boolean().default(false).extra('volatile', true),
  /** 本地转写用哪个 Whisper 模型（tiny / base / small / medium） */
  asrModel: z.string().default('small').extra('volatile', true),
  /** ⭐ 每轮最多发几条评论（每条里 @ 一次下面那个人）；**有效范围 0–20，口径见 clampPatch**（0 = 不发评论）
   *  ⚠️ 这里故意**不加 `.max(20)`**：schema 校验不过 ⇒ cordis 拒收这条 entry ⇒ **整条插件不激活** ✗
   *     （跟 schemastery 拿不到时的降级同一个道理）—— 范围一律由 clampPatch 在**写**和**读**两头钳。 */
  commentPerRound: z.natural().default(1).extra('volatile', true),
  /** ⭐ 要 @ 谁（B站 昵称，**单个**）—— 老字段，留着兼容旧配置；新配置请用 `mentionNames` */
  mentionName: z.string().default('').extra('volatile', true),
  /** ⭐⭐ 要 @ 的**多个人**（B站 昵称列表）。非空时**以它为准**，`mentionName` 只是兜底。
   *  B站 的 @ 是纯文本：正文里写 `@某人` 就会真的圈到人 ⇒ 多个人 = 正文里写多个 @  */
  mentionNames: z.array(z.string()).default([]).extra('volatile', true),
  /** ⭐ 这一轮用哪个模型（provider）。空 = 跟 profile 默认（不写 overlay） */
  modelProvider: z.string().default('').extra('volatile', true),
  /** ⭐ 这一轮用哪个模型（model id）。必须和 `modelProvider` 一起填 */
  modelName: z.string().default('').extra('volatile', true),
  /** 关注关键词（空了用章程里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** Python：指向 venv 里的那个最好 */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** dsh 的 bin.js（不填就试自动探测，再退化成 shell 里的 dsh） */
  dshBin: z.string().default('').extra('volatile', true),
  /** headless 那一轮用哪个 profile */
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** 给那一轮叠一份插件自己的 patch（把 B站 MCP 挂上）—— 用户 profile 一个字都不用改 */
  overlayMcp: z.boolean().default(true).extra('volatile', true),
  /** 跑 headless 时的工作目录 */
  workspace: z.string().default('').extra('volatile', true),
  /** ⭐ 它的"地盘"：插件数据家目录（空 = 默认 `$DSH_HOME/bili-duty`）。
   *  放 venv / 凭证 / 报告 / 日志 / 判重表；**config.json 不跟着搬**（留在 bootDir，见 index.js 顶部注释） */
  home: z.string().default('').extra('volatile', true),
  /** 日报形态：full=完整（现状）· brief=每条一两行 · off=不写报告（只发评论） */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** 回复评论：默认关。开了之后只回「直接回复到它那条评论下面的人」 */
  replyToComments: z.boolean().default(false).extra('volatile', true),
  /** 每轮最多回几条 */
  replyPerRound: z.number().default(1).extra('volatile', true),
  /* ⭐ 回复的发现方式（2026-10-19 改）：宿主按天数窗口**全量扫**自己发过的评论，
   *    再按规则打分 ⇒ 只有 ≥ minScore 的才进"待回复清单"，模型只负责写正文。
   *    · replyLookbackDays 只看最近几天的评论（默认 7）
   *    · replyMinScore    回复线（默认 3：至少"像提问"或"跟插件有关 + 轻互动"） */
  /** ⭐ 只评论娱乐视频（不评论学习/技术型）；默认开 —— 见 lib/classify.mjs */
  funOnly: z.boolean().default(true).extra('volatile', true),
  /** ⭐ 标签规则（2026-10-19 加）：命中白名单 = 一定评论；命中黑名单 = 一定不评论（都比分区/关键词优先） */
  funTagsAllow: z.array(z.string()).default([]).extra('volatile', true),
  funTagsBlock: z.array(z.string()).default([]).extra('volatile', true),
  replyLookbackDays: z.natural().default(7).extra('volatile', true),
  replyMinScore: z.natural().default(3).extra('volatile', true),
})

/**
 * ⭐ 给所有 Python 子进程统一 UTF-8。
 * 起因（2026-10-16，用户在评论区反馈）：Windows 上 Python 默认按 GBK 编解码，
 * 我们的脚本 / 内置 MCP 都会往管道里打中文与 emoji（`✅`、`—` 之类），一进管道就可能
 * 报 UnicodeDecodeError / 乱码或直接中断。**编码这种环境差异，插件该自己钉死，不该让用户碰。**
 */
/**
 * ⭐ 子进程输出解码（2026-10-19，合并上游 0.1.11）
 * ============================================================================
 * 起因：`cmd.exe` 自己吐的中文错误信息是 **GBK** ——
 *   直接按 UTF-8 写进 duty.log 就变成一堆方块/替换符（用户看到的就是"乱码"，
 *   明明日志里写着原因，却没人看得懂）。
 * 规矩：**先按 UTF-8 解，出现替换符（U+FFFD）再回退 GBK**；两个都解不出来就用 UTF-8 那份。
 */
const decodeOut = (buf) => {
  if (!Buffer.isBuffer(buf)) return String(buf ?? '')
  const u = buf.toString('utf8')
  if (!u.includes('\uFFFD')) return u
  try { return new TextDecoder('gbk').decode(buf) } catch { return u }
}

const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  ...extra,
})

/**
 * ⭐ uv 的缓存目录必须钉在插件家里（2026-10-19，合并上游 0.1.11）
 * ============================================================================
 * 起因：uv 默认把缓存写 `%LOCALAPPDATA%\uv\cache`；那地方一旦没权限
 *   （企业策略 / 杀软 / 别的用户建过）就 `error: Could not acquire lock` / `failed to open file`，
 *   而「装转写依赖」会直接 exit 2 —— 这是**环境差异，不该让用户去碰** ✗
 * ⇒ 所有 uv 调用统一带这几个变量，缓存/工具/Python 全放 `<家>\uv-*`（那儿一定有写权限）。
 */
const uvEnv = (stateDir, extra = {}) => ({
  UV_CACHE_DIR: join(stateDir, 'uv-cache'),
  UV_TOOL_DIR: join(stateDir, 'uv-tools'),
  UV_PYTHON_INSTALL_DIR: join(stateDir, 'uv-python'),
  ...extra,
})

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  // ⭐ 自己的版本号（从 package.json 读，设置页要显示它）
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }
  // ⭐ 两个目录（2026-10-19：家目录要能改，见 lib/state.mjs 的 normalizeHomeDir）：
  //    bootDir = $DSH_HOME/bili-duty —— 只放 config.json（+ 搬家账本），**永远不动**
  //    stateDir = 用户可改的"地盘" —— venv / 凭证 / 报告 / 日志 / 判重表都在这儿
  //    ⚠️ config.json 必须留在 bootDir：它是**启动时唯一确定读得到**的文件，
  //       要是跟着家目录一起搬，搬完就没人知道新家在哪儿 ⇒ 启动即失忆 ✗
  const bootDir = stateDirOf(ctx)
  const cfgFile = join(bootDir, 'config.json')
  let stateDir = bootDir
  // 下面这些路径**跟着家目录走** ⇒ 一律 let，由 syncHomePaths() 统一重算
  let logFile = join(stateDir, 'duty.log')
  let outDir = join(stateDir, 'out')
  let installLogFile = join(stateDir, 'install.log')
  let asrDir = join(stateDir, '.venv-asr')
  let asrLogFile = join(stateDir, 'asr-install.log')
  let asrTmp = join(stateDir, 'tmp', 'asr')
  let seenFile = join(stateDir, 'seen.md')
  let digestDir = join(stateDir, 'digest')
  let dutyStateFile = join(stateDir, 'state.json')

  // ⭐ "就绪"必须检查依赖真的装上了，不能只看目录存不存在
  //    （2026-10-15：只看目录，害一位真实用户"显示就绪但其实装失败"白折腾 ✗）
  const sitePkgs = (venvRoot) => {
    const win = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(win)) return win
    try {
      const lib = join(venvRoot, 'lib')
      for (const d of readdirSync(lib)) {
        if (!d.startsWith('python')) continue
        const p = join(lib, d, 'site-packages')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
    return win
  }
  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
  }
  /** `<venv>/Scripts/python.exe` / `<venv>/bin/python` → `<venv>` */
  const venvRootOf = (py) => { try { return join(dirname(String(py)), '..') } catch { return '' } }
  /**
   * 环境就绪没有 —— ⚠️ 2026-10-19 补（用户换了地盘之后界面报"环境未就绪"）：
   *   底盘搬家**不搬 venv**，但旧 venv 里钉的是它**自己那个绝对路径**，所以它**照样能用** ✓
   *   ⇒ 只要「家目录里的 venv」或「配置里指的那个 python」有一个装了 `bilibili_api`，就算就绪。
   *   老代码只看家目录里的 venv ⇒ 换完地盘立刻谎报"未就绪"，还把人骗去白装一遍 ✗
   */
  const venvReadyNow = () => {
    if (existsSync(venvPython()) && hasPkg(join(stateDir, '.venv'), 'bilibili_api')) return true
    const py = String(cfg?.pythonPath || '').trim()
    if (py && (py.includes('\\') || py.includes('/')) && existsSync(py)) {
      const root = venvRootOf(py)
      if (root && hasPkg(root, 'bilibili_api')) return true
    }
    return false
  }
  const asrReadyNow = () => existsSync(asrPython()) && hasPkg(asrDir, 'faster_whisper')

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[bili-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  // 宿主依赖是从哪儿取的（桌面版那次事故的排查看这里：duty.log 里会写明白）
  for (const n of hostDeps.notes) log(n)

  /**
   * ⚠️ 2026-10-14 事故（第一次挂上就炸了整个 DSH，见当天的 lesson）：
   *   `apply(ctx, config)` 传进来的那个 `config`，字段值**不保证是标量** —— 我们的 `config.pythonPath`
   *   是个**对象**、`config.keywords` 也不是数组（日志里打成 `[object Object]`）。对象是"真值"，
   *   于是 `if (!cfg.peakValley) return` 这类守卫全部失效，一路走到 `cfg.keywords.filter(...)`
   *   抛 TypeError —— 而那是在**定时器回调**里，没人接 ⇒ **整个 dsh 进程被带走** ✗✗。
   *   ⇒ 两条规矩：
   *     ① 逐字段按默认值的类型挑一遍（拿不准就用默认值），再叠自己的 `config.json`；
   *     ② **定时器回调里绝不让异常外冒**（见 tick）—— 未捕获异常会杀掉整个宿主进程。
   */
  const DEFAULTS = {
    serviceOn: true,   // ⭐ 总开关（刷B站服务的电源；默认开）
    tripleOn: false, tripleCoin: 1, triplePerDay: 5, tripleFavMediaId: 0, tripleSay: true,   // ⭐ 三连：默认关
    perDay: 5, perRound: 0, peakValley: false, noon: true, night: true, autoComment: false, transcribe: false, asrModel: 'small',
    dmMode: 'off', dmUid: 0,
    keywords: [], commentPerRound: 1, mentionName: '', mentionNames: [], modelProvider: '', modelName: '',
    pythonPath: 'python', dshBin: '', headlessProfile: 'headless', overlayMcp: true, workspace: '', reportLevel: 'full', replyToComments: false, replyPerRound: 1, funOnly: true, funTagsAllow: [], funTagsBlock: [], replyLookbackDays: 7, replyMinScore: 3,
    home: '',   // ⭐ 它的"地盘"（空 = 默认 $DSH_HOME/bili-duty）
  }
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }
  /* ── 配置从哪来：DSH 自带的「插件设置」页 > 插件自己的 config.json > 默认值 ──
   * 老代码是 `normalize(readJson(cfgFile, {}), normalize(config, DEFAULTS))` —— config.json 一刀切盖住宿主，
   * 后果：用户在 DSH 自带的插件设置页里改了值，插件照旧读 config.json 的旧值 ⇒ **静默不生效** ✗。
   * 判据用 describe() 给的 `user` 层（= 用户在原生设置页**显式设过**的键）：
   *   设过的键 ⇒ 听宿主的；没设过 ⇒ 还是 config.json 说了算（老用户零回归 ✓）。
   * 拿不到设置服务就完全退回老行为。
   */
  /* ⭐ 「设置里能写什么范围」收在一处 —— HTTP 接口、bili_config 工具、**读配置**三处都走它，
   *    所以 perDay 0–50 / commentPerRound 0–20 这些数字**只有这一份**（schema 里不再写一遍）。
   *    （2026-10-16 审查修：原来只有 HTTP 路径钳制，工具路径连 perDay 都能写任意值；
   *      commentPerRound 两条路径都没钳，直接 POST 能写 9999）
   *    （2026-10-17 复查补：DSH 原生设置页那条路我们钳不到**写** —— 用户能在那儿直接填 9999 ⇒
   *      loadCfg 读回来也过一遍，写进去和读出来一个口径） */
  const clampPatch = (patch) => {
    const p = { ...patch }
    if ('serviceOn' in p) p.serviceOn = Boolean(p.serviceOn)
    if ('tripleOn' in p) p.tripleOn = Boolean(p.tripleOn)
    if ('tripleSay' in p) p.tripleSay = Boolean(p.tripleSay)
    if ('tripleCoin' in p) p.tripleCoin = (Number(p.tripleCoin) >= 2 ? 2 : 1)
    if ('triplePerDay' in p) p.triplePerDay = Math.max(0, Math.min(Number(p.triplePerDay) || 0, 50))
    if ('tripleFavMediaId' in p) p.tripleFavMediaId = Math.max(0, Math.min(Number(p.tripleFavMediaId) || 0, Number.MAX_SAFE_INTEGER))
    if ('perDay' in p) p.perDay = Math.max(0, Math.min(Number(p.perDay) || 0, 50))
    if ('perRound' in p) p.perRound = Math.max(0, Math.min(Number(p.perRound) || 0, 50))
    if ('reportLevel' in p) p.reportLevel = ['full', 'brief', 'off'].includes(String(p.reportLevel)) ? String(p.reportLevel) : 'full'
    if ('replyToComments' in p) p.replyToComments = Boolean(p.replyToComments)
    if ('replyPerRound' in p) p.replyPerRound = Math.max(1, Math.min(Number(p.replyPerRound) || 1, 10))
    if ('funOnly' in p) p.funOnly = Boolean(p.funOnly)
    for (const k of ['funTagsAllow', 'funTagsBlock']) {
      if (!(k in p)) continue
      const raw = Array.isArray(p[k]) ? p[k] : String(p[k] ?? '').split(/[,，\\n]/)
      const seen = new Set()
      p[k] = raw.map((s) => String(s ?? '').trim().replace(/^#+/, '')).filter((s) => {
        if (!s || seen.has(s)) return false
        seen.add(s)
        return true
      }).slice(0, 30)
    }
    if ('replyLookbackDays' in p) p.replyLookbackDays = Math.max(1, Math.min(Number(p.replyLookbackDays) || 7, 30))
    if ('replyMinScore' in p) p.replyMinScore = Math.max(0, Math.min(Number(p.replyMinScore) || 0, 20))
    if ('commentPerRound' in p) p.commentPerRound = Math.max(0, Math.min(Number(p.commentPerRound) || 0, 20))
    // ⭐ home 只做字符串整理；**合法性与搬家由 changeHome() 负责**（clampPatch 是纯函数，不能建目录）
    if ('home' in p) p.home = String(p.home ?? '').trim()
    // ⭐ 多 @：去空白、去重、限 8 个（B站 一条评论里塞太多 @ 也不像人话）
    if ('mentionNames' in p) {
      const list = Array.isArray(p.mentionNames) ? p.mentionNames : []
      const seen = new Set()
      p.mentionNames = list.map((s) => String(s ?? '').trim().replace(/^@+/, '')).filter((s) => {
        if (!s) return false
        const k = s.toLowerCase()
        if (seen.has(k)) return false
        seen.add(k)
        return true
      }).slice(0, 8)
    }
    if ('mentionName' in p) p.mentionName = String(p.mentionName ?? '').trim().replace(/^@+/, '')
    // ⭐ 模型：只允许 id 里常见的字符，别把奇怪的字符写进 YAML
    if ('modelProvider' in p) p.modelProvider = String(p.modelProvider ?? '').trim().replace(/[^A-Za-z0-9._:\/-]/g, '')
    if ('modelName' in p) p.modelName = String(p.modelName ?? '').trim().replace(/[^A-Za-z0-9._:\/-]/g, '')
    return p
  }

  /**
   * 宿主"生效值"从哪来 —— 🔴 2026-10-19 修的真 bug（用户："设置里的开关打开后自动关闭了"）
   * ============================================================================
   * 老代码这里用 `normalize(config, DEFAULTS)`，把 **apply(ctx, config) 收到的那个对象**当生效值。
   * 但实测（本机 0.1.7 + 桌面版）**它不是就地更新的**：volatile 字段写进设置后，
   * 宿主换的是 fiber 上那份，我们手里这个 `config` 引用还停在启动时的快照 ⇒
   *   · 设置页把 replyToComments 打开 → 写进 profile patch + config.json ✓
   *   · 下一次 /status 走 loadCfg：`user` 层有这个键 ⇒ 取"宿主生效值" ⇒ **拿到旧的 false**
   *   · 前端 5 秒轮询把开关刷回 false（用户看到的就是"打开后自动关闭"）✗
   *   · 同一处还让"换地盘"白换：cfg.home 被读回 '' ⇒ followHome() 立刻把家搬回默认 ✗
   * ⇒ 生效值必须取 `describe()` 的 `value` 层（宿主自己算好的、含默认值），
   *   `config` 只当兜底（拿不到 value 时用）。
   */
  const hostCfg = (row) => normalize({ ...config, ...(row?.value && typeof row.value === 'object' ? row.value : {}) }, { ...DEFAULTS })
  const savedCfg = () => normalize(readJson(cfgFile, {}), { ...DEFAULTS })
  /**
   * ⭐ "用户在插件面板里存过的键"（2026-10-19，合并上游 0.1.9–0.1.11）
   * ============================================================================
   * 起因：DSH 0.2.x 某些启动方式下 `ctx.settings.update` **不报错、但也没生效**
   *   ⇒ 我们读回宿主那份旧值 ⇒ 用户点一个开关，几秒后又被压回原状，
   *     表现成"开一个、另一个像被关掉"（上游两位用户实测反馈）。
   * 现在：存过的键记进 `config.json._set`，读配置时**这些键一律以插件这份为准**；
   *   没存过的键仍然听宿主（DSH 原生设置页还是正当入口）。
   * ⚠️ 老配置没有 `_set` ⇒ 第一次按"和默认值不一样"反推一遍，免得升级上来又被弹回。
   */
  const touchedKeys = (() => {
    const raw = readJson(cfgFile, {})
    if (Array.isArray(raw?._set)) return new Set(raw._set)
    return new Set(Object.keys(DEFAULTS).filter((k) => k in (raw || {}) && JSON.stringify(raw[k]) !== JSON.stringify(DEFAULTS[k])))
  })()
  const CFG_SIG = ['perDay', 'mentionName', 'replyToComments', 'overlayMcp']   // 靠这几个键认出"哪一行是我们"
  let settingsRow = { at: 0, row: null }
  /** ⭐ 写完设置立刻作废缓存：否则紧接着的 /status 还会把旧值报回去（3 秒窗口足够让开关"弹回来"） */
  const invalidateSettingsRow = () => { settingsRow = { at: 0, row: null } }
  /**
   * 我们那一行设置表单（拿不到就返回 null ⇒ 一切按 config.json 来）。
   * ⚠️ DSH 自带的「插件设置」页**不需要注册** —— 老代码那句 `ctx.settings.register(...)` 是个不存在的方法，
   *    每次都抛 TypeError、被 catch 吞掉（2026-10-17 读宿主源码 @deepseek-ai/dsh-settings 才明白）：
   *    describe() 自己扫 profile 里**带 volatile 字段**的条目列出来（lib/index.js:413-452），
   *    命名空间 ns **等于 loader 条目的 id**（我们 cordis.patch.yml 里是 `bili-scroll`，不是老注释写的 bili-duty）。
   * 另外两条同样要紧（都是读宿主源码得来的，别再想当然）：
   *    ① `apply(ctx, config)` 收到的 config 就是 fiber.config 本体，volatile 字段一改宿主**就地**改它
   *       （cordis-plugin-loader/src/config/entry.ts：`this.fiber._config = …` + `_commitVolatile()`）⇒
   *       启动时快照的 cfg 永远看不到设置页的改动，用之前得 refreshCfg()。
   *    ② describe() 每行给三层：value（生效值）/ base（继承层）/ user（用户在设置页显式设过的那层）。
   */
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row   // 挡 UI 轮询：describe() 要扫所有条目
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && CFG_SIG.every((k) => k in r.value)) || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响跑）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }
  const loadCfg = () => {
    const saved = savedCfg()
    const row = settingsDesc()
    // ⭐ 读回来统一过一遍范围：原生设置页那边我们是钳不到写的（见 clampPatch 的注释）
    if (!row) return clampPatch(saved)
    const user = row.user || {}
    // ⭐ 生效值取 describe 的 value 层（见 hostCfg 上面的血泪注释）；没有就退到 config 快照
    const out = hostCfg(row)
    // ⭐ 优先级：插件面板存过的键 > DSH 原生设置 > config 快照（上游 0.1.9–0.1.11 的修，2026-10-19 合并）
    for (const k of Object.keys(DEFAULTS)) {
      if (touchedKeys.has(k)) { out[k] = saved[k]; continue }
      if (user[k] !== undefined) { out[k] = user[k]; continue }
      out[k] = saved[k]
    }
    return clampPatch(out)
  }
  const cfg = loadCfg()
  // ⭐ 配置是"随时可能被设置页就地改掉"的东西 ⇒ 每个入口用之前重算一遍（cfg 这个对象要一直指向同一份）
  //    ⚠️ 2026-10-19 补：`home` 可能被**原生设置页**改掉（我们钳不到写）⇒ 每跳都要核一遍家目录，
  //       不然改了 home 却还往旧家写（表现："我改了目录，报告还在老地方" ✗）
  const refreshCfg = () => { Object.assign(cfg, loadCfg()); followHome() }
  const saveCfg = (patch) => {
    Object.assign(cfg, normalize(patch, cfg))
    // ⭐ 记下「这些键由插件面板说了算」（与上游 0.1.11 对齐）：读配置时它们不再被宿主旧值压回
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) touchedKeys.add(k)
    writeJson(cfgFile, { ...cfg, _set: [...touchedKeys] })
  }
  /**
   * ⭐ 同时写一份到宿主：不写的话会出现死结 —— 某个键一旦在原生设置页设过就由宿主说了算，
   *    插件页再改那个键就成了"改了没反应" ✗。写失败不算致命（config.json 那份还在），把话带回给用户。
   */
  const saveCfgHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof ctx.settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）'), { noForm: true })
      }
      await ctx.settings.update(row.ns, patch, row.revision)
      return row.ns
    }
    try { return { ok: true, ns: await attempt(false) } }
    catch (e) {
      if (!e?.noForm) {   // revision 过期（刚有别人改过）⇒ 重取一次再写
        try { return { ok: true, ns: await attempt(true), retried: true } } catch (e2) { e = e2 }
      }
      log(`写 DSH 设置失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }
  /**
   * ⭐ 落配置的**唯一入口**：插件自己那份 config.json + DSH 原生设置页那份，钳完范围一起写。
   *    （2026-10-17 复查修：`saveCfg` + `await saveCfgHost` 这对义务原来在三个调用点各抄一遍 ——
   *      漏掉任何一处，正好就是「设置页改了没反应」那个 bug 本身 ⇒ 收成一个函数。）
   *    ⚠️ 2026-10-19：写完**必须**作废 settingsRow 缓存，否则紧接着的 /status 在 3 秒缓存窗口里
   *       还会把旧值报回去 —— 前端轮询一刷，开关就"自己关掉"了 ✗
   */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    const host = await saveCfgHost(clean)
    invalidateSettingsRow()
    // ⭐ 设置一变就把 --patch overlay 重写一遍（跑那一轮时直接用它）
    try { ensureOverlay() } catch (e) { log(`写 overlay 失败（不影响设置）：${e?.message ?? e}`) }
    return { clean, host }
  }

  /* ─────────────── "地盘"（家目录）可改 ───────────────
   * 2026-10-19 用户要求：文件目录要能改。设计见 lib/state.mjs 的 normalizeHomeDir。
   *   · config.json 永远留在 bootDir（启动时唯一读得到的东西）；
   *   · `cfg.home` 为空 = 用默认（$DSH_HOME/bili-duty），非空 = 用户指定的**绝对路径**；
   *   · 换家时把能搬的搬过去（**不搬 venv**，理由见 state.mjs 的 migrateData），
   *     并把指进旧家的 `pythonPath` 重置 —— 否则会拿一个已经不存在的解释器去跑 ✗。
   * ⚠️ 换家之后**必须**重新 syncHomePaths() + ensureHomeLayout()：报告/日志/判重表的路径
   *    全是启动时按老目录算的（沙箱还要求"目录先存在"），漏了就会往旧家写 ✗。
   */

  const SEEN_TEMPLATE = [
    '# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）',
    '',
    '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
    '',
    '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
    '| --- | --- | --- | --- | --- |',
    '',
    '## 看过的视频',
    '',
  ].join('\n')

  function syncHomePaths() {
    logFile = join(stateDir, 'duty.log')
    outDir = join(stateDir, 'out')
    installLogFile = join(stateDir, 'install.log')
    asrDir = join(stateDir, '.venv-asr')
    asrLogFile = join(stateDir, 'asr-install.log')
    asrTmp = join(stateDir, 'tmp', 'asr')
    seenFile = join(stateDir, 'seen.md')
    digestDir = join(stateDir, 'digest')
    dutyStateFile = join(stateDir, 'state.json')
  }

  /** 家里那些**必须先存在**的目录与文件（沙箱只让写启动前就有的目录） */
  function ensureHomeLayout() {
    ensureDataDirs(stateDir)
    try { if (!existsSync(seenFile)) writeFileSync(seenFile, SEEN_TEMPLATE, 'utf8') } catch { /* 建不了也别拦着插件加载 */ }
  }

  /** 启动时按 cfg.home 定家（不搬家，只解析 + 建目录） */
  function applyHomeFromConfig() {
    const want = String(cfg.home || '').trim()
    const r = normalizeHomeDir(bootDir, want, { pluginDir })
    if (!r.ok) log(`「家目录」这项配置用不了（${want || '空'}）：${r.reason} ⇒ 继续用默认 ${bootDir}`)
    stateDir = r.dir
    lastHomeWanted = r.ok ? want : null
    syncHomePaths()
    ensureHomeLayout()
  }

  /**
   * ⭐ 跟随配置里的 home（原生设置页改了 home 之后，下一跳就得生效）。
   *    · 只认**合法**的新路径；不合法就留在原地并记一句日志（别把家搬到半路上）；
   *    · 这里**不搬家**（搬家只发生在用户点「应用」那次 changeHome 里）——
   *      定时器每分钟一跳，要是在这儿搬家会把文件反复复制 ✗。
   */
  let lastHomeWarn = ''
  let lastHomeWanted = null      // ⭐ 上一次真正核过的 home 原文：没变就**一格都不写盘**（status 每 5 秒轮询一次）
  function followHome() {
    const want = String(cfg.home || '').trim()
    // 先比字符串：绝大多数调用都在这儿返回 —— normalizeHomeDir 会真的去建目录/写探针，不能每 5 秒跑一遍
    if (want === lastHomeWanted) return
    const r = normalizeHomeDir(bootDir, want, { pluginDir })
    if (!r.ok) {
      if (r.reason !== lastHomeWarn) { lastHomeWarn = r.reason; log(`「家目录」配置无效（${want}）：${r.reason} ⇒ 留在 ${stateDir}`) }
      return
    }
    lastHomeWanted = want
    lastHomeWarn = ''
    if (r.dir === stateDir) return
    stateDir = r.dir
    syncHomePaths()
    ensureHomeLayout()
    ensureHomeFiles(pluginDir, stateDir, log)
    ensureCharter(pluginDir, stateDir, log)
    try { mcp?.stop?.() } catch { /* 收摊失败不影响 */ }
    mcp = null; mcpKey = ''
    log(`家目录跟随配置变了：→ ${stateDir}`)
  }

  /**
   * 换家（设置页 / bili_config 都走这儿）。
   * @returns {Promise<{ok:boolean, home:string, from:string, copied?:string[], error?:string, host?:object, note?:string}>}
   */
  const changeHome = async (raw, { migrate = true } = {}) => {
    const want = String(raw ?? '').trim()
    const r = normalizeHomeDir(bootDir, want, { pluginDir })
    if (!r.ok) return { ok: false, home: stateDir, from: stateDir, error: r.reason }
    const from = stateDir
    let copied = []
    let pythonReset = false
    if (r.dir !== from) {
      if (migrate) copied = migrateData(from, r.dir, log)
      stateDir = r.dir
      syncHomePaths()
      ensureHomeLayout()
      // ⭐ 新家可能缺 mcp_server.py / asr.py / 章程（没搬家、或搬的时候个别文件失败）⇒ 补铺一遍
      ensureHomeFiles(pluginDir, stateDir, log)
      ensureCharter(pluginDir, stateDir, log)
      // ⭐ pythonPath 只在**它真的没了**的时候才重置。
      //    ⚠️ 2026-10-19 修：老逻辑是"只要指在旧家里就重置" —— 错的。
      //       搬家**不搬 venv**，所以旧 venv 还待在原地、里面钉的是它自己的绝对路径 ⇒ **照样能用** ✓。
      //       重置成裸 `python` 反而把好环境弄坏（用户看到"环境未就绪"、MCP 也起不来）✗
      const py = String(cfg.pythonPath || '').trim()
      let pyMissing = false
      if (py && (py.includes('\\') || py.includes('/'))) { try { pyMissing = !existsSync(py) } catch { pyMissing = false } }
      if (pyMissing) { cfg.pythonPath = 'python'; pythonReset = true }
      // ⭐ MCP 子进程的 cwd 是老家 ⇒ 必须重启，不然凭证还会读到老家那份
      try { mcp?.stop?.() } catch { /* 收摊失败不影响换家 */ }
      mcp = null; mcpKey = ''
      log(`换家：${from} → ${r.dir}（搬了 ${copied.length} 项${pythonReset ? '，pythonPath 原来的解释器已不存在 ⇒ 重置为 python' : ''}）`)
    }
    const { host } = await persistCfg({ home: want ? r.dir : '', ...(pythonReset ? { pythonPath: 'python' } : {}) })
    lastHomeWanted = String(cfg.home || '').trim() || null   // ⭐ 别让下一跳 followHome 再重复核一遍
    return {
      ok: true, home: stateDir, from, copied, host,
      venvReady: venvReadyNow(),
      note: r.dir === from
        ? '家目录没变'
        : (migrate
          ? (venvReadyNow()
            ? '已换家；原来的 venv 还能用（它按自己的绝对路径跑）—— 想把它也建到新家，点一次「装主依赖」'
            : '已换家；新家还没有 venv ⇒ 请点一次「装主依赖」重建环境')
          : '已换家（没搬文件，新家是空的）'),
    }
  }

  /** 画二维码时按优先级试这些 python（Node 侧 qrcode 拿不到才用得上） */
  const pythonCandidates = () => [venvPython(), String(cfg.pythonPath || '').trim(), 'python']

  /**
   * ⭐ 这一轮要 @ 谁 —— **唯一出口**（2026-10-19 加多人 @）
   *   优先级：`mentionNames`（数组，多个）> `mentionName`（老的单个字段，兼容用）
   *   去空白、去掉用户手打的 `@`、去重（不区分大小写）、最多 8 个。
   *   ⚠️ B站 的 @ 是**纯文本**：正文里写 `@昵称` 就会圈到人 ⇒ 多个人 = 正文里写多个 @。
   */
  const mentionsNow = () => {
    const arr = Array.isArray(cfg.mentionNames) ? cfg.mentionNames : []
    const list = arr.map((s) => String(s ?? '').trim().replace(/^@+/, '')).filter(Boolean)
    const legacy = String(cfg.mentionName || '').trim().replace(/^@+/, '')
    if (!list.length && legacy) list.push(legacy)
    const seen = new Set(); const out = []
    for (const n of list) {
      const k = n.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k); out.push(n)
    }
    return out.slice(0, 8)
  }

  /** ⭐ 这一轮用哪个模型（没有就返回 null = 跟 profile 默认） */
  const modelNow = () => {
    const provider = String(cfg.modelProvider || '').trim()
    const model = String(cfg.modelName || '').trim()
    return provider && model ? { provider, model } : null
  }

  // ⭐ 先把"家"定下来（cfg.home 可能是用户改过的），再往里铺文件 —— 顺序错了会铺到旧家
  applyHomeFromConfig()
  ensureHomeFiles(pluginDir, stateDir, log)

  // ⭐ 值班章程单独记账（跟 mcp_server.py 不一样：用户改过就得留着 —— 见 state.mjs 的 ensureCharter）
  ensureCharter(pluginDir, stateDir, log)

  /* ─────────────── MCP（内部起那个 Python MCP） ─────────────── */

  let mcp = null
  let mcpKey = ''
  const mcpKeyNow = () => `${cfg.pythonPath}|${join(stateDir, 'mcp_server.py')}`

  const ensureMcp = async () => {
    if (mcp?.running && mcpKey === mcpKeyNow()) return mcp
    if (mcp) { mcp.stop(); mcp = null }
    const script = join(stateDir, 'mcp_server.py')
    if (!existsSync(script)) throw new Error(`家里没有 mcp_server.py（应有 ${script}）—— 装上插件后重启一次 dsh 会自动铺好`)
    mcpKey = mcpKeyNow()
    mcp = new McpClient({
      command: cfg.pythonPath || 'python',
      args: [script],
      cwd: stateDir,                     // 凭证落在家里 ✓
      // ⭐ 这个内置的 Python MCP 会往 stdout 打中文（ensure_ascii=False）；
      //    Windows 默认 GBK 的话，中文/emoji 一进管道就可能炸 ⇒ 钉死 UTF-8
      env: pyEnv(),
      log,
    })
    return mcp
  }

  const call = async (toolName, args, opts) => {
    const client = await ensureMcp()
    return client.call(toolName, args, opts)
  }

  const hasCredential = () => existsSync(join(stateDir, 'bili_credential.json'))

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /**
   * 工具返回值一律过一遍这里：**宿主只吃"无损 JSON"**，塞进去任何函数/循环引用/类实例都会报
   * `value is not lossless JSON`（2026-10-14 第一次挂上就撞了一次）。
   */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'bili_whoami',
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。第一次用要先在「刷B站」设置页里扫码登录。',
    parameters: {},
    async execute() {
      if (!hasCredential()) {
        return { ok: false, loggedIn: false, hint: '还没登录：去 dsh 设置页的「刷B站」里点「扫码登录」（凭证会存在插件自己的家目录里）' }
      }
      const r = await call('bili_check_credential', {})
      return { ok: true, ...(typeof r === 'object' ? r : { raw: r }) }
    },
  })

  tool({
    name: 'bili_search',
    description: '搜 B站 视频（可排序）。返回标题 / BV号 / 播放量 / UP / 时长 等。\n'
      + '⚠️ 刷一轮的用法：搜近 7 天的、按播放或最新都行，然后**读字幕原文**再判断（别看摘要下结论）。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ click=播放 / pubdate=最新 / dm=弹幕' },
    },
    async execute(args) {
      return call('bili_search', {
        keyword: String(args.keyword ?? ''),
        num: Math.max(1, Math.min(Number(args.num) || 10, 50)),
        order: String(args.order || 'totalrank'),
      })
    },
  })

  tool({
    name: 'bili_subtitle',
    description: '取一个视频的字幕（AI 字幕）全文。**判断内容就靠它** —— 没有字幕时，'
      + '若设置里开了「本地转写」再想别的办法，否则直接跳过这条。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) { return call('bili_subtitle', { bvid: String(args.bvid ?? '') }) },
  })

  tool({
    name: 'bili_comments',
    description: '取一个视频的热门评论（含点赞/回复数）。刷一轮时顺手翻一眼，看值不值得占用使用者一次注意力。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) {
      return call('bili_comments', { bvid: String(args.bvid ?? ''), num: Math.max(1, Number(args.num) || 30) })
    },
  })

  /**
   * ⭐ 这个视频我们**已经发过顶层评论**了吗？（2026-10-19 加硬闸）
   * ============================================================================
   * 原来"同一个视频不留第二条评论"**只是提示词里的一句话**（duty.md + 判重表），
   * 没有任何代码拦得住 —— 模型漏看、或两轮并跑，就会在同一个视频下发两条 ✗
   * 现在：读判重表的「评论记录」表格，只要有这个 BV 且 rpid 那一格不是空，就算发过。
   * ⚠️ 只拦**顶层评论**（rpid=0）；`rpid>0` 是"回复别人"，那是允许的。
   * ⚠️ 记录里写「未取到 rpid」也算发过（有这一行就说明发过）。
   */
  const postedOn = (bvid) => {
    const bv = String(bvid || '').trim().toLowerCase()
    if (!bv) return ''
    try {
      const text = readFileSync(seenFile, 'utf8')
      const re = /^\|\s*(BV[0-9A-Za-z]{10})\s*\|\s*([^|]*)\|/gm
      let m
      while ((m = re.exec(text))) {
        if (m[1].toLowerCase() !== bv) continue
        const rpid = String(m[2] || '').trim()
        if (rpid) return rpid
      }
    } catch { /* 判重表读不到就当没有 —— 别因此拦住整轮 */ }
    return ''
  }

  /** 把发出去的顶层评论补记进判重表（模型忘了写也不至于下轮重复发） */
  const recordComment = (bvid, rpid, text) => {
    try {
      const cur = readFileSync(seenFile, 'utf8')
      const rid = String(rpid || '').trim() || '未取到 rpid'
      if (cur.includes(`| ${bvid} | ${rid}`)) return          // 已经有同一行，不重复写
      const prefix = String(text || '').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim().slice(0, 20)
      const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
      const row = `| ${bvid} | ${rid} | | ${when} | ${prefix} |`
      const lines = cur.split('\n')
      const i = lines.findIndex((l) => /^\|\s*---/.test(l))
      if (i >= 0) lines.splice(i + 1, 0, row)
      else lines.push(row)
      writeFileSync(seenFile, lines.join('\n'), 'utf8')
      log(`已把评论自动记进判重表：${bvid} rpid=${rid}`)
    } catch (e) { log(`自动记判重表失败（不影响评论）：${e?.message ?? e}`) }
  }

  tool({
    name: 'bili_reply',
    description: '在视频下发评论（或回复某条评论）。这就是"@ 本人"那一下：短、干净、纯文本 @ 写在正文里。\n'
      + '🔴 安全闸：设置页的「自动评论并 @ 你」**默认是关的**；关着的时候这个工具会拒绝 —— '
      + '除非本人当场让你发（那时传 force: true）。\n'
      + '🔴 去重闸：**同一个视频的顶层评论只发一次**（判重表里有记录就拒），除非传 force: true。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      text: { type: 'string', description: '评论正文（短、干净、纯文本 @；别写敏感词）' },
      rpid: { type: 'number', description: '要回复的评论 id（0/不填 = 发新评论）' },
      root: { type: 'number', description: '楼中楼的根评论 id（回复别人时传；宿主用它记"这一楼回过了"）' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过"自动评论关着"与去重两道闸' },
    },
    async execute(args) {
      refreshCfg()
      // ⭐ 总开关关着 ⇒ 这个号不说话（读 / 搜 还能用，只是不发东西）
      if (!cfg.serviceOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: '「刷B站服务」总开关关着 —— 打开之后才会替你说话。确实要发就传 force: true。',
        }
      }
      // dmMode==='only' 时本轮根本不该发公开评论 —— 在工具层也一并挡掉（除非当场 force）
      const commentOn = Boolean(cfg.autoComment && mentionsNow().length && cfg.dmMode !== 'only')
      if (!commentOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: cfg.dmMode === 'only'
            ? '现在是「只私信」模式（dmMode=only）—— 规定不发公开评论，改成用 bili_send_message 私信。确实要发时传 force: true。'
            : '要发评论得同时满足两条：设置里开着「自动评论并 @ 你」、并且填了「要 @ 谁」。或者本人当场让你发时传 force: true。',
        }
      }
      // ⭐ 去重闸：顶层评论同一视频只发一次
      const isTopLevel = !(Number(args.rpid) > 0)
      const bvid = String(args.bvid ?? '')
      // ⭐ 类型闸（2026-10-19）：只评论娱乐视频 —— 学习/技术型的顶层评论直接拒
      if (isTopLevel && !args.force && cfg.funOnly) {
        const k = await videoKind(bvid)
        if (k.kind === 'tech') {
          log(`拦下技术型视频的评论：${bvid}（${k.why.join('；')}）`)
          return {
            ok: false,
            blocked: true,
            kind: 'tech',
            hint: `${bvid} 是${kindLabel(k.kind)}（${k.why.join('；')}）—— 现在设置成「只评论娱乐视频」，这条只写进报告、不发评论。确实要发就传 force: true。`,
          }
        }
      }
      if (isTopLevel && !args.force) {
        const prev = postedOn(bvid)
        if (prev) {
          log(`拦下重复评论：${bvid} 已经发过（rpid ${prev}）`)
          return {
            ok: false,
            blocked: true,
            duplicate: true,
            hint: `${bvid} 已经评论过了（rpid ${prev}）—— 同一个视频不留第二条顶层评论。换一条视频，或者确实要发就传 force: true。`,
          }
        }
      }
      const replyTo = Number(args.rpid) || 0
      const rootId = Number(args.root) || 0
      const r = await call('bili_reply', {
        bvid,
        text: String(args.text ?? ''),
        rpid: replyTo,
        root: rootId,
      })
      // ⭐ 发成功就自动记账（模型漏写判重表也不会重复发）
      try {
        const obj = typeof r === 'string' ? JSON.parse(r) : r
        if (isTopLevel && obj && obj.success !== false) {
          recordComment(bvid, obj.rpid ?? obj.rpid_str, args.text)
        }
        // ⭐ 回别人：记进 replied.jsonl，下一轮扫描时就不再把他算进"待回复"
        if (!isTopLevel && obj && obj.success !== false) {
          recordReplied(stateDir, { root: rootId || replyTo, source: replyTo, bv: bvid })
          replyCache = { at: 0, data: null }   // 清单失效，下次重新扫
        }
      } catch { /* 回执不是 JSON 就算了 */ }
      return r
    },
  })

  /**
   * ⭐ 顺手三连（2026-10-19 加）：给挑中的视频点赞 + 投币 + 收藏。
   * 三道闸（缺一不可）：总开关开着 / 今天没超上限 / 这个视频没三连过。
   * ⚠️ 它是**花钱**的动作（投币），所以：默认关、日上限独立配、同一视频只花一次钱。
   */
  tool({
    name: 'bili_interact',
    description: '给这条视频三连（点赞 + 投币 + 收藏）。**发评论之前**先调它。\n'
      + '🔴 开关关着 / 今天额度用完 / 这个视频三连过 ⇒ 会直接拒绝（不花硬币）。\n'
      + '返回里 like / coin / favorite 每项是 ok / already / fail；只有三项都不是 fail 才算成功。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
    },
    async execute(args) {
      refreshCfg()
      if (!cfg.serviceOn) return { ok: false, blocked: true, hint: '「刷B站服务」总开关关着 —— 先把它打开' }
      if (!cfg.tripleOn) return { ok: false, blocked: true, hint: '「顺手三连」开关关着 —— 这一轮不三连' }
      const bv = String(args.bvid ?? '').trim()
      if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) return { ok: false, error: `BV号不对：${bv}` }
      const prev = findTripled(stateDir, bv)
      if (prev) return { ok: true, repeated: true, ...prev, hint: '这个视频之前三连过了（不重复花币）' }
      // ⭐ 类型闸（2026-10-19）：只评论娱乐视频 ⇒ 技术型的也别三连（币是钱，别花在不会被评论的视频上）
      if (cfg.funOnly) {
        const k = await videoKind(bv)
        if (k.kind === 'tech') {
          return { ok: false, blocked: true, kind: 'tech', hint: `${bv} 是${kindLabel(k.kind)}（${k.why.join('；')}）—— 「只评论娱乐视频」模式下不三连` }
        }
      }
      const cap = Math.max(0, Number(cfg.triplePerDay) || 0)
      const done = tripledCountOn(stateDir, dayKey())
      if (cap <= 0 || done >= cap) {
        return { ok: false, blocked: true, hint: `今天三连额度用完了（${done}/${cap} 条）` }
      }
      const favId = Math.max(0, Number(cfg.tripleFavMediaId) || 0)
      const coin = Math.min(2, Math.max(1, Number(cfg.tripleCoin) || 1))
      const mode = favId > 0 ? 'manual' : 'triple'
      let obj
      try {
        const r = await call('bili_triple', { bvid: bv, coin, mode, fav_media_id: favId })
        obj = (typeof r === 'string') ? JSON.parse(r) : r
      } catch (e) {
        obj = { ok: false, like: 'fail', coin: 'fail', favorite: 'fail', errors: [String(e?.message ?? e)] }
      }
      const row = {
        day: dayKey(), bvid: bv, at: new Date().toISOString(),
        ok: obj?.ok === true,
        like: obj?.like || 'fail', coin: obj?.coin || 'fail', favorite: obj?.favorite || 'fail',
        folder: Number(obj?.folder) || 0, coinCount: coin, mode,
        errors: Array.isArray(obj?.errors) ? obj.errors.slice(0, 3) : [],
      }
      appendInteracted(stateDir, row)
      log(`三连 ${bv}：赞=${row.like} 币=${row.coin} 藏=${row.favorite}${row.ok ? '（成功）' : '（失败）'}`
        + (row.errors.length ? ' ' + row.errors[0] : ''))
      return { ...row, ok: row.ok }
    },
  })

  /**
   * ⭐ 问一下"这条视频是娱乐还是学习/技术"（2026-10-19）：
   *    模型发评论 / 三连之前可以先问，省得撞上宿主的闸。
   */
  tool({
    name: 'bili_video_kind',
    description: '看这条视频是**娱乐型**还是**学习/技术型**（按分区 + 标题/标签粗筛）。'
      + '开了「只评论娱乐视频」时，tech 的不发评论、也不三连。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
    },
    async execute(args) {
      refreshCfg()
      const k = await videoKind(String(args.bvid ?? '').trim())
      return { ok: true, ...k, label: kindLabel(k.kind), funOnly: Boolean(cfg.funOnly) }
    },
  })

  tool({
    name: 'bili_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、登录过没有、下次窗口什么时候开。',
    parameters: {},
    async execute() {
      refreshCfg()
      const st = readJson(join(stateDir, 'state.json'), {})
      const now = new Date()
      return {
        ok: true,
        serviceOn: Boolean(cfg.serviceOn),   // ⭐ 总开关（侧栏那盏灯 / 页面胶囊看的就是它）
        tripledToday: tripledCountOn(stateDir, dayKey(now)),
        repliesPending: replyCache.data?.items?.length ?? null,   // ⭐ 宿主扫出来的待回复（null = 还没扫过）
        today: dayKey(now),
        ranToday: st.day === dayKey(now) ? Number(st.count || 0) : 0,
        pickedToday: countPickedToday(now),
        perDay: cfg.perDay,
        windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, {
          label: w.label, start: w.start, end: w.end,
          switchOn: Boolean(cfg[k]),
          opening: inWindow(now, w),
        }])),
        peakValley: cfg.peakValley,
        autoComment: cfg.autoComment,
        dmMode: cfg.dmMode,
        dmUid: Number(cfg.dmUid) || 0,
        transcribe: cfg.transcribe,
        loggedIn: hasCredential(),
        home: stateDir,
        report: join(outDir, `${dayKey(now)}.md`),
      }
    },
  })

  tool({
    name: 'bili_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。'
      + '适合"我现在就想看一份"的场合。',
    parameters: {},
    async execute() { const r = await runDuty('manual'); return { ...r, ok: r.started === true } },
  })

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：出二维码（画成 PNG 存在插件家目录里，返回路径）和一个 key。\n'
      + '用法：拿到 PNG 后用 `present` 把它推给本人（手机 B站 → 我的 → 扫一扫），再用 `bili_login_poll` 轮询。\n'
      + '⚠️ 二维码大约 180 秒有效，出码要马上递过去；手机上确认时选「记住我」那种长期登录。',
    parameters: {},
    async execute() {
      const { key, url } = await loginStart()
      const qr = await renderQr({ url, stateDir, pythonCandidates: pythonCandidates(), log })
      return {
        ok: true, key, url, png: qr.png, via: qr.via,
        ...(qr.png ? {} : { errors: qr.errors }),
        hint: qr.png
          ? `用 present 把这张 PNG 推给本人扫；扫完调 bili_login_poll（渲染方式：${qr.via}）`
          : '没画出二维码。真实原因：' + qr.errors.join('；'),
      }
    },
  })

  tool({
    name: 'bili_login_poll',
    description: '查扫码结果：waiting 还没扫 / scanned 扫了待确认 / ok 成功 / expired 过期。'
      + '成功时会自动把凭证写进插件家目录的 `bili_credential.json`（MCP 认的那四个字段）。',
    parameters: { key: { type: 'string', description: 'bili_login_start 给的那个 key' } },
    async execute(args) {
      const r = await loginPoll(String(args.key ?? ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return { ok: true, state: 'ok', file }
      }
      return { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message }
    },
  })

  tool({
    name: 'bili_setup',
    description: '给刷B站装运行环境：在插件家目录建一个**独立 venv**、装上那个 Python MCP 的依赖，装完自动把 `pythonPath` 指过去。\n'
      + '**第一次用之前跑一次**。⭐ 它**起完就返回、不等装完**（几分钟的活），进度看家目录里的 `install.log`。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'bili_config',
    description: '读 / 改「刷B站」的设置。不给 `patch` 就是读；给了就改（只认 schema 里的字段）。\n'
      + '例：`{"perDay":20,"perRound":5,"peakValley":true,"noon":true,"night":true,"autoComment":false,"transcribe":false,"keywords":["DeepSeek Harness"]}`'
      + '（`perDay` = 每天最多挑几条；`perRound` = 一轮最多挑几条，0 = 不单独限制、用当天剩余额度）。\n'
      + '⭐ 总开关：`{"serviceOn":false}` = 整个「刷B站服务」停机（自动轮 / 手动轮 / 发评论全停，只保留读状态与改设置）。\n'
      + '私信投递：`{"dmMode":"only","dmUid":12345678}`（dmMode = off / only / both）。\n'
      + '⭐ 改「要 @ 谁」：`{"mentionNames":["甲","乙"]}`（**多个**，正文里会分别 @；最多 8 个；老的单个字段 `mentionName` 仍兼容）。\n'
      + '⭐ 换这一轮用的模型：`{"modelProvider":"deepseek-official","modelName":"deepseek-flash"}`（两个都填才生效；'
      + '都填空字符串 = 跟 profile 默认）。\n'
      + '⭐ 换它的「地盘」（数据目录）：`{"home":"D:\\\\bili-duty"}` —— 填**绝对路径**，空字符串 = 回到默认；'
      + '会把凭证/报告/日志/判重表复制过去；旧 venv 留在原地也能继续用（想重建到新家就跑一次 `bili_setup`）。',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      let homeNote = ''
      const patch = args?.patch
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
        const p = { ...patch }
        if ('home' in p) {
          const r = await changeHome(p.home, { migrate: p.migrate !== false })
          delete p.home; delete p.migrate
          if (!r.ok) return { ok: false, error: r.error, home: stateDir, defaultHome: bootDir, config: cfg }
          host = r.host; homeNote = r.note || ''
        }
        if (Object.keys(p).length) {
          // ⭐ 设置页显式设过的键以宿主为准 ⇒ 必须跟着写一份，否则"改了没反应"（钳范围也在这里）
          const r2 = await persistCfg(p)
          host = r2.host
        }
      }
      return {
        ok: true, config: cfg, windows: WINDOWS,
        home: stateDir, defaultHome: bootDir, homeCustom: stateDir !== bootDir,
        ...(homeNote ? { homeNote } : {}),
        venvReady: venvReadyNow(), host,
      }
    },
  })

  /* ─────────────── 跑一轮（跟老方案同一条路：dsh --profile headless <prompt>） ─────────────── */

  // dutyStateFile 在文件上方按家目录算好了（syncHomePaths）
  const bumpState = (patch) => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    if (st.day !== today) { st.day = today; st.count = 0; st.picked = 0; st.windows = {} }
    writeJson(dutyStateFile, { ...st, ...patch })
    return st
  }

  /* ⭐ 「定量刷」承诺的是**每天挑几条**（2026-10-16 审查修 H1：原来 st.count 从没自增过，
   *   tick 那道 `count >= perDay` 的闸形同虚设 ⇒ noon + night 两个窗口各跑满一轮，
   *   后一轮还会把前一轮的报告覆盖掉）。
   *   数哪儿？数**今天的报告**里那些 `### BV号` 标题行（章程写死了这个格式）。
   *   ⚠️ 为什么不数「报告里出现的所有 BV」（2026-10-17 复查修的）：报告里还会出现**没挑中**的 BV ——
   *     「因无字幕跳过 N 条」那行、评论区里别人问起的视频、"判重表读不到"的说明 —— 全算进去的话，
   *     perDay 默认 5 ⇒ 一轮里出现 5 个 BV 就把当天额度吃光 ⇒ **傍晚那轮直接不跑** ✗。
   *   ⚠️ 围栏 ``` 里的内容一律不看：那一轮没写报告时 stubReportIfMissing 会把 duty.log 尾部贴进报告，
   *     那里面的 BV 是"看过的"，不是"挑出来的"。
   *   ⚠️ 数不出来（章程那条格式没照做）就当 0 条 —— 宁可少算（顶多多跑一轮、额度也写在提示词里），
   *     也别把"提到过"算成"挑中"（那会让使用者当天再也拿不到内容）✓。 */
  const PICK_RE = /^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm
  const reportFileOf = (now = new Date()) => join(outDir, `${dayKey(now)}.md`)
  const countPicks = (file) => {
    try {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
      const ids = new Set()
      for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
      return ids.size
    } catch { return 0 }
  }
  // 报告是事实来源；state 兜住"报告被删 / 手改"那一下（取两者里大的）
  const countPickedToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0
    return Math.max(fromState, countPicks(reportFileOf(now)))
  }
  const roundsToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey(now) ? Number(st.count || 0) : 0
  }

  // ⭐ 一键升级：由宿主自己跑 `dsh plugin --profile web add dsh-bili-scroll`
  //    ⚠️ 装完必须重启 dsh 才生效；⚠️ Windows 上"替换正在运行的插件"可能被文件占用挡住（我们踩过）
  let upgrading = false
  const runUpgrade = () => {
    if (upgrading) return { ok: true, busy: true, log: installLogFile, hint: '正在升级，别重复点' }
    upgrading = true
    appendInstall('\n=== ' + new Date().toISOString() + ' 开始升级（add dsh-bili-scroll）===\n')
    ;(async () => {
      try {
        const dsh = resolveDsh()
        // ⭐ 找不到 dsh 就不硬跑（合并上游 0.1.11）：直接说清楚该去哪儿填
        if (dsh?.notFound) {
          appendInstall('⚠️ 找不到 dsh —— 请到「环境与账号」里把「dsh 路径」指到 dsh 的 bin.js（或 .cmd）再点一次\n')
          return
        }
        // ⭐ 照抄那一轮的形状：resolveDsh 返回 { command, args, shell }，统一过 dshSpawn（会处理 .cmd 与带空格的路径）
        const plan = dshSpawn(dsh, ['plugin', '--profile', 'web', 'add', 'dsh-bili-scroll'])
        appendInstall('$ ' + plan.cmd + ' ' + plan.args.join(' ') + '\n')
        const code = await spawnTo(plan.cmd, plan.args, { sink: appendInstall, verbatim: plan.verbatim })
        if (code === 0) appendInstall('=== 升级完成 —— 重启一次 dsh 才生效 ===\n')
        else appendInstall('=== 升级没成功（exit ' + code + '）。可以自己手动跑一次：dsh plugin --profile web add dsh-bili-scroll ===\n')
      } catch (e) { appendInstall('升级崩了：' + (e?.stack ?? e) + '\n') } finally { upgrading = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在升级 —— 完成后重启一次 dsh 才生效' }
  }

  const resolveDsh = () => {    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit], shell: false }
    // 常见的全局安装位置（Windows 的 npm 前缀 / POSIX 的 lib）
    const guesses = [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    // ⭐ 2026-10-16（issue #5 / #6 / #7）：**桌面版是 Electron 安装包，不是 npm -g 装的** ⇒ 上面几条全找不到
    //    ⇒ 老逻辑退到 `dsh`（PATH 里没有这个命令）⇒ 那一轮必败、而且只留下一句 exit 1 ✗
    //    桌面版把 dsh 打在应用里 ⇒ 按 `process.resourcesPath` 猜几个位置（找到就用；找不到就**明说**）
    if (process.resourcesPath) {
      // ⭐ 2026-10-19 修：桌面版真正的命令行入口是 `resources/runtime/cli/bin/dsh.cmd`
      //    （它就是 `DeepSeek Harness.exe --expose-internals …/dsh-desktop-host/lib/cli.js` 的包装）。
      //    老逻辑只找 `@deepseek-ai/dsh/lib/bin.js` —— 桌面版里根本没有这个文件 ⇒ 每次都报"找不到 dsh"✗
      for (const rel of [
        ['runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'],
        ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) {
        const p = join(process.resourcesPath, ...rel)
        if (existsSync(p)) {
          const isCmd = /\.(cmd|bat)$/i.test(p)
          // .cmd/.bat 必须过 cmd.exe；纯 .js 用 electron 当 node 跑（ELECTRON_RUN_AS_NODE 由 runDuty 补）
          return isCmd
            ? { command: p, args: [], shell: true }
            : { command: process.execPath, args: [p], shell: false }
        }
      }
    }
    for (const g of guesses) if (existsSync(g)) return { command: process.execPath, args: [g], shell: false }
    // ⚠️ 走到这儿就是真找不到 —— 一定要出声（静默失败比报错更坏）
    log('⚠️ 找不到 dsh：桌面版多半不是 npm 全局安装的 ⇒ 请在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js，或改用 npm 装的 dsh')
    return { command: 'dsh', args: [], shell: true, notFound: true }
  }

  /**
   * 把一次 dsh 调用变成**可以直接 spawn 的** `{ cmd, args, verbatim }`。
   * ============================================================================
   * 🔴 2026-10-19 两个坑（用户报告：跑一轮秒退，日志里一句乱码「文件名、目录名或卷标语法不正确」）：
   *   ① 桌面版的 dsh 是 `.cmd`（`resources/runtime/cli/bin/dsh.cmd`）⇒ 必须过 cmd.exe；
   *   ② **Node 的 spawn 会给参数加 Windows 转义**（`"` 变成 `\"`），而 cmd.exe 不认这种转义
   *      ⇒ `cmd /c "\"D:\\…\\dsh.cmd\""` 直接被当成非法路径 ✗
   *   ③ 还有 cmd 的 `/c` 引号规则：命令以 `"` 开头时，cmd 会**吃掉首尾两个引号** ⇒ 得整体再包一层。
   * ⭐ 正确姿势（本机实测 exit=0）：整条命令行**自己拼好**、当**一个参数**给 cmd，并带
   *   `windowsVerbatimArguments: true`（不让 Node 再转义）：`cmd.exe /c ""<dsh>" --profile … "-"`。
   * ⭐ 另外：**提示词不再走命令行**（几千字，还可能带引号/换行）—— 走 stdin（task 传 `-`）。
   *   本机实测：带引号、反斜杠的提示词都能完整送进去 ✓
   */
  const qArg = (s) => {
    const t = String(s)
    return /[\s"&|<>^]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const dshSpawn = (dsh, rest) => {
    const base = Array.isArray(dsh?.args) ? dsh.args : []
    if (!dsh?.shell) return { cmd: dsh.command, args: [...base, ...rest], verbatim: false }
    if (process.platform === 'win32') {
      // ⭐ 整体再包一层引号：`cmd /c ""<cmd>" args…"`
      const line = '"' + [`"${dsh.command}"`, ...base.map(qArg), ...rest.map(qArg)].join(' ') + '"'
      return { cmd: 'cmd.exe', args: ['/c', line], verbatim: true }
    }
    const line = [dsh.command, ...base, ...rest].map((s) => `"${String(s).replace(/"/g, '\\"')}"`).join(' ')
    return { cmd: '/bin/sh', args: ['-c', line], verbatim: false }
  }

  const promptFor = (why = 'window', shortlist = null) => {
    // ⭐ 2026-10-19：手动点的那一轮**不受"每轮 N 条评论"这个自限**（用户反馈："我手动点了，评论还被每轮限制"）
    //    自动轮（谷时定时器）按 commentPerRound 控节奏；手动轮按**今天剩下的额度**来。
    const manual = why === 'manual'
    // ⭐ 章程取哪一份：家里那份优先（ensureCharter 保证铺好；他改过的话就是他那份，升级的事由 ensureCharter 记账处理）
    let duty = charterPath(pluginDir, stateDir)
    // ⭐ 2026-10-17（issue #8④）：章程里的 `<家目录>` 这种占位符会被模型读成 `~`，实测**整轮转写白跑** ✗
    //    ⇒ 在拼提示词这一步把**绝对路径**填进去，别让它猜（我们的老规矩：提示词一律给绝对路径）
    try { duty = String(duty).split('<家目录>').join(stateDir) } catch { /* 替换失败就按原文用 */ }
    const kws = Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean) : []
    // ⭐ 开场先让它读**工作区**的 AGENTS.md —— 这一轮的工作目录就是使用者的工作区，
    //    AGENTS.md 本来就会自动注入；这里再点一句，保证它真按使用者的设定来（别人的设定同理）。
    // ⭐ 那一轮的工作目录是**插件家**（沙箱只让它写自己工作目录里的东西 ✗），
    //    所以"使用者的设定"由**我们自己读进来**喂给它 —— 它在宿主进程里跑，没有沙箱限制 ✓
    let ownerDoc = ''
    try {
      // ⚠️ 2026-10-16 用户反馈（"只要给人设就会走偏"）：留空时我们以前退到 `process.cwd()`，
      //    也就是 **dsh 进程自己的工作目录** —— 那对多数人根本不是他的工作区 ✗
      //    ⇒ 读错人设、甚至把别的目录的设定读进来 ✓
      //    ⭐ 现在的规矩：**留空 = 不读设定**（宁可按中性说话，也别猜错 ✓）；要按人设就自己填工作区 ✓。
      const wsDir = String(cfg.workspace || '').trim()
      const agents = wsDir ? join(wsDir, 'AGENTS.md') : ''
      if (agents && existsSync(agents)) {
        const text = readFileSync(agents, 'utf8')
        ownerDoc = '\n\n===== 使用者的 AGENTS.md（他写给自己 AI 的人设与准则，**按这个来**）=====\n'
          + text.slice(0, 6000)
          + '\n===== 设定结束 =====\n'
      }
    } catch { /* 读不到就算了，别因此跑不成 */ }
    // ⭐ 「每天最多挑 N 条」是**全天**的账：上一轮已经挑过的要扣掉，这一轮只给剩下的额度
    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const already = countPickedToday()
    const left = Math.max(0, quota - already)
    // ⭐ 2026-10-19：「一轮挑几条」单独配（perRound）—— 0 = 不单独限制，用剩下额度
    const perRound = Math.max(0, Number(cfg.perRound) || 0)
    const thisRound = perRound > 0 ? Math.min(perRound, left) : left
    // ⭐ 三连开着（且今天还有额度）时，评论正文要给"已三连"那句留位置：150 → 135 字
    const tripleActive = Boolean(cfg.serviceOn && cfg.tripleOn && Math.max(0, Number(cfg.triplePerDay) || 0) > 0)
    const budget = (tripleActive && cfg.tripleSay !== false) ? 135 : 150
    // ⭐ 投递方式（2026-10-17 加）：dmMode = off（只评论）· only（只私信）· both（都发）
    //    commentOn 是"这一轮到底能不能发公开评论"的唯一判据（工具层的闸用的是同一套逻辑）
    // ⭐ 2026-10-19：`@` 支持多人 —— mentionsNow() 是唯一出口（mentionNames 优先，mentionName 兜底）
    const mentions = mentionsNow()
    const mentionText = mentions.length ? mentions.map((n) => `@${n}`).join(' ') : ''
    const commentOn = Boolean(cfg.autoComment && mentions.length && cfg.dmMode !== 'only')
    const dmOn = Boolean(cfg.dmMode !== 'off' && Number(cfg.dmUid) > 0)
    return `你是这个账号的 B站 助手。`
      + `下面是使用者的设定（如果有）—— **按它来**，别用你默认那套人格。`
      + ownerDoc
      + (ownerDoc
        ? ''
        : '⭐ 这一轮**没有**拿到使用者的设定（他没填「工作区」，或那个目录里没有 `AGENTS.md`）⇒ **按中性说话**：别扮演任何人、也别自己编一套设定 ✓。')
      + `然后读章程 ${duty}，按里面的要求刷一轮 B站，`
      + (cfg.reportLevel === 'brief'
        ? `日报写成薄版：每条一两行（值不值得 + 链接）就够，别写长摘要。`
        : cfg.reportLevel === 'off'
          ? `这一轮不要写日报文件，也别生成任何报告；只有真发了评论就一句话记下。`
          : `把报告写到 ${join(outDir, `${dayKey()}.md`)}。`)
      + (cfg.reportLevel === 'off' ? '' : `⚠️ 今天那份报告里可能已经有上一轮写的东西 —— 有就**追加到末尾**，别覆盖（配额按全天算）。`)
      + (cfg.reportLevel === 'off' ? '' : '⭐ 报告里**每挑中一条**，第一行写成 `### BV号`（例：`### BV1xxxxxxx`）—— 宿主**就数这些标题行**算今天挑了几条：漏写当成没挑中，给只是提到 / 跳过的视频加上标题则当成挑中。')
      + (thisRound <= 0
        ? `⚠️ 今天已经挑过 ${already} 条了（每天上限 ${quota} 条）⇒ **这一轮一条都别再挑**，只写报告；`
        : `**这一轮最多挑 ${thisRound} 条**`
          + (perRound > 0 ? `（单轮上限 ${perRound} 条）` : '')
          + `；今天已经挑过 ${already} 条，全天总共上限 ${quota} 条（还剩 ${left} 条）；`)
      + `关键词${kws.length ? `用这些：${kws.join('、')}` : '用章程里的默认那几组'}。`
      + `本地转写：${cfg.transcribe
        ? (asrReadyNow()
          ? '开着，而且装好了（没字幕的视频用家里那份 asr.py 转，命令见章程）'
          : '**开着、但依赖没装好** ⇒ 这一轮没字幕的视频只能跳过')
        : '关着（没字幕的视频就跳过）'}；`
      + `⭐ 不管哪种情况，**报告里都要写一行「因无字幕跳过 N 条」**（N=0 也写）—— 别让它悄悄少几条。`
      + `判重表 = ${join(stateDir, 'seen.md')}（**就是这个绝对路径**，别写到家目录 ~、也别写到别处）；`
      + `⚠️ 它读不出来或写不进去，**必须在报告里明说** —— 那一轮宁可不发评论，也别当成"没有记录"重发一遍。`
      + `⭐ 另外把这一轮**看过的每一条视频（挑中的和跳过的都算）**追加进归档：${join(digestDir, `${dayKey().slice(0, 7)}.md`)}`
      + ` —— 一行一条：日期 · BV 号 · 标题 · UP · 一句话结论 · 链接（跳过的那条在后面注明理由）；`
      + `这是**给以后检索用**的（报告是给人看的，归档是给"回头翻"用的），别省略、也别只写挑中的。`
      + (() => {
        // ⭐ 评论条数的口径：手动轮按"今天还剩多少额度"，自动轮按"每轮 N 条"
        //    ⚠️ 这里的 perRound 是**评论**的每轮上限（commentPerRound），上面那个 perRound 是**挑几条**的单轮上限
        const commentCap = Math.max(0, Number(cfg.commentPerRound) || 0)
        const capText = manual
          ? (thisRound > 0
            ? `**这一轮是主人手动点的** ⇒ 别拿"每轮 ${commentCap} 条"卡自己；`
              + `这一轮最多挑 ${thisRound} 条${perRound > 0 ? `（单轮上限 ${perRound}）` : ''}，今天还剩 ${left} 条额度`
            : `**这一轮是手动点的，但今天的额度已经用完了**（每天最多 ${quota} 条，已挑 ${already}）⇒ 只写报告，别再发评论`)
          : `每轮最多 ${commentCap} 条评论`
        if (!commentOn) {
          return `自动评论并 @ ${mentions.length ? mentions.join('、') : '（还没填要 @ 谁）'} 是`
            + (cfg.dmMode === 'only'
              ? '关着的 —— 当前是「**只私信**」模式：**这一轮一条公开评论都不许发**，改走私信'
              : '关着的（只写报告，别发评论）') + '。'
        }
        const tail = mentions.length === 1
          ? `每条在正文里纯文本 @ ${mentions[0]}，${budget} 字内；@ 完要**称呼一声「主人」**（就一次，别一句一个）`
          : `要 @ 的是**这些人**：${mentions.join('、')} ——`
            + ` 正文里**每个人都要单独写一次** \`@昵称\`（就是 ${mentionText}），一个都不能漏；整条正文 ${budget} 字内，`
            + ` @ 完之后要**称呼一声「主人」**（一次就够，别每句都叫），再写一句"为什么值得"；`
            + ` 别为了塞 @ 把人名写错`
        return `自动评论并 @ ${mentions.join('、')} 是开着的（${capText}；${tail}）。`
      })()
      /* ⭐ 类型限制（2026-10-19）：只评论娱乐视频 —— 学习/技术型的写进报告、不发评论。
       *    宿主会在 bili_reply / bili_interact 里再拦一道；这里先说清楚，别浪费调用。 */
      + (cfg.funOnly && commentOn
        ? `🔴 **只评论娱乐视频**：学习 / 技术 / 教程 / 科普 / 评测 / 编程 这类视频**不发评论**（写进报告就行）。`
          + `拿不准就先用 \`bili_video_info\` 看 \`tname\`（分区）和标签：「知识 / 科技 / 教程 / 科普」= 别评论、别三连；「动画 / 搞笑 / 游戏 / 生活」= 可以；`
          + (() => {
            const allow = Array.isArray(cfg.funTagsAllow) ? cfg.funTagsAllow : []
            const block = Array.isArray(cfg.funTagsBlock) ? cfg.funTagsBlock : []
            let s = ''
            if (allow.length) s += `⭐ **标签白名单**（命中就一定可以评论，哪怕分区是知识/科技）：${allow.join('、')}；`
            if (block.length) s += `⛔ **标签黑名单**（命中就一条都不发、也不三连）：${block.join('、')}；`
            return s
          })()
          + `真要发也会被宿主拦下（除非 force）。`
        : '')
      /* ⭐ 顺手三连（2026-10-19）：只在开关开着、且今天还有额度时才写进提示词。
       *    开关关着 ⇒ **这一段完全不出现**（不是"额度为 0"，而是根本没这功能）。 */
      + (() => {
        if (!cfg.serviceOn || !cfg.tripleOn) return ''
        const cap = Math.max(0, Number(cfg.triplePerDay) || 0)
        if (cap <= 0) return ''
        const done = tripledCountOn(stateDir, dayKey())
        const leftTriple = Math.max(0, cap - done)
        if (leftTriple <= 0) {
          return `三连：今天已经三连 ${done}/${cap} 条 ⇒ **这一轮不再三连**，也不许在评论里提"三连"两个字。`
        }
        const say = cfg.tripleSay !== false
        return `顺手三连：这一轮最多再给 ${leftTriple} 条视频三连（今天 ${done}/${cap}）。`
          + `🔴 **顺序：先 \`bili_triple\` 三连、再 \`bili_reply\` 发评论**（反过来就来不及在评论里说）。`
          + `三连只给"这一轮真的挑中、要发评论"的那几条，别给没选的视频三连。`
          + (say
            ? `只有 \`bili_triple\` 回的 ok=true 时，才允许在「主人」后面加一句自然的说明（三选一、只出现一次，别写成固定后缀）：`
              + `「顺手三连了」「币投了，收藏也点了」「三连支持一下」。`
            : `评论里**不要提**三连这件事。`)
          + `任何一项失败（like/coin/favorite 里出现 fail）⇒ **一个字都别提三连**，按普通评论发。`
      })()
      + (dmOn
        ? `⭐⭐ **私信投递**：用 bili_send_message 把这一轮的结果发到 UID **${Number(cfg.dmUid)}**。`
          + `内容**别照抄评论那套**：把本轮每条值得的写成 **标题 + 链接 + 一句话理由**`
          + `（私信是私人渠道、不占别人的地方，可以比评论长一点，但**别啰嗦**）。`
          + `🔴🔴 **但私信有长度上限 —— 实测 500 字符就顶了**：`
          + `490 字那条能发出去、再长就被接口拒（报 **code 21007**）✗。`
          + `所以**一条私信务必控制在 500 字以内、最多塞 4~5 条** —— 宁可少放一条，也别整条被拒；`
          + `⚠️ **被拒了就精简一次重发**（删理由、砍条目），**别原样无脑重试** ✗。`
          + `🔴🔴 **私信是写给「人」看的，必须是干净的人话** —— **不许出现任何设置名 / 内部术语 / 台账口径** ✗：`
          + `dmMode、only、aiReply、判据、白名单、prompt、token、复核 这类词，**一个都不许出现在私信正文里**；`
          + `**更不许写「公开评论一条没发 / 楼中楼跳过」这种内部机制说明** ✗`
          + `（那是在跟使用者念操作手册，可读性极差）。他关心的只有：**这次挑了哪几条、为什么值得**。`
          + `（想交代"没别的了"就用一句人话，比如「今天没什么新的了」；`
          + `⚠️ **不要**把「无字幕跳过 N 条」这种统计口径搬进私信 —— 那是**报告**里写的，不是私信里写的。）`
          + `⚠️ 私信里**不用 @ 任何人**；⚠️ **一轮只发一条私信**（多条合并成一条）；`
          + `⚠️ 私信里**不要**写"本鱼 / 本鲸 / 主人 / 人家"那套；⚠️ 发完把"已私信"记进报告（**报告里**可以写口径）。`
          + (cfg.dmMode === 'both' ? `⚠️ 现在是 **both**：公开评论照发（走下面那一整套规矩），私信**另外**再发一条。` : '')
        : '')
      + (() => {
        if (!cfg.replyToComments) return '回复评论：关着（一个字都不要回任何人 —— 有人回复你那条评论也不要理）。'
        const cap = Math.max(1, Math.min(Number(cfg.replyPerRound) || 1, 10))
        const days = Math.max(1, Number(cfg.replyLookbackDays) || 7)
        const minScore = Math.max(0, Number(cfg.replyMinScore) || 0)
        const list = Array.isArray(shortlist?.items) ? shortlist.items : []
        const head = `回复评论：开着（每轮最多回 ${cap} 条）。`
        if (!list.length) {
          return head
            + `这一轮**不用回任何人** —— 宿主已经按「最近 ${days} 天」扫过你自己发过的 ${Number(shortlist?.scanned) || 0} 条评论、`
            + `拿到 ${Number(shortlist?.fetched) || 0} 条回复，没有一条达到回复线（${minScore} 分）。`
            + `⚠️ **别自己去翻评论/楼中楼找回复**（那是宿主干的活，你翻还容易翻错）。`
        }
        const lines = list.slice(0, cap * 2).map((it, i) => {
          const why = Array.isArray(it.why) && it.why.length ? `（${it.why.join('、')}，${it.score} 分）` : `（${it.score} 分）`
          return `${i + 1}. ${it.bv} · ${it.nickname || '有个人'}：${JSON.stringify(String(it.text || '').slice(0, 80))}${why}`
        })
        const params = list.slice(0, cap).map((it) => `${it.bv} → rpid=${it.source} root=${it.root}`)
        return head
          + `宿主扫了最近 ${days} 天的 ${Number(shortlist?.scanned) || 0} 条评论、拿到 ${Number(shortlist?.fetched) || 0} 条回复，`
          + `按规则打分筛出这些**值得回**的（按分从高到低）：`
          + lines.join('；') + `。`
          + `🔴 **只回这个清单里的人**（别再自己去找）；回的时候用 \`bili_reply\`：${params.join('；')}。`
          + `每轮最多回 ${cap} 条，挑前 ${cap} 个就够；回完把"回了谁"记进报告。`
          + `⚠️ 清单里没有的人（分数不够的、带联系方式的、有敌意的）**一律不回**。`
      })()
      // ⭐ 时间直接给绝对答案 —— 原来写「自己看一眼系统时间」，模型真去开 shell 查，
      //    结果撞上沙箱 ACL 报错、白烧一堆 token ✗（2026-10-19 实测）
      + `最后用一句话汇报你挑到了什么。现在是 ${new Date().toLocaleString('zh-CN')}（别去跑 shell 查时间）。`
  }

  /**
   * 给 headless 那一轮写一份 overlay —— 把 B站 MCP 挂上去。
   * 🔴 为什么需要它：**某个 profile 能拿到什么工具，取决于它自己那层的 patch**
   *    （headless 里那两条 B站 MCP 就是当初手写进去的）。分发给别人时不能要求人家改 profile，
   *    所以插件自己生成一份、跑的时候 `--patch` 带上（dsh 支持可重复的 `--patch`）。
   */
  /**
   * ⭐ 值班轮能看到哪些 MCP 工具（2026-10-17 审查里的 H3）
   *    起因：overlay 把整台 mcp_server.py 挂成 stdio server ⇒ 那一轮的模型手里握着**原生全套**工具
   *    （bili_reply / bili_crawl / bili_send_opus / bili_upload_video / bili_login…）——
   *    宿主这边 autoComment / mentionName 两道闸只拦得住我们自己的 bili_reply 工具，拦不住它 ✗。
   *    做法：白名单写进 overlay 的 env（mcp-client 会把它并进子进程环境），
   *    mcp_server.py 那头**不在白名单里的工具根本不注册** —— 连名字都不给它看见 ✓。
   *    要读全就手工改这个列表（或者直接跑 mcp_server.py，不设这个变量 = 全放）。
   */
  /**
   * ⭐ 待回复清单（2026-10-19 改）：宿主按天数窗口**全量扫**自己发过的评论 → 拉到回复 →
   *    规则打分 → 只有 ≥ replyMinScore 的才进清单。模型不再自己翻楼中楼。
   *    缓存 60 秒（一轮里提示词和页面可能会各问一次）。
   */
  let replyCache = { at: 0, data: null }
  const replyShortlist = async (force = false) => {
    const now = Date.now()
    if (!force && replyCache.data && now - replyCache.at < 60_000) return replyCache.data
    const data = await scanReplies(stateDir, {
      lookbackDays: Math.max(1, Math.min(Number(cfg.replyLookbackDays) || 7, 30)),
      minScore: Math.max(0, Math.min(Number(cfg.replyMinScore) || 0, 20)),
      maxItems: Math.max(4, Math.min((Number(cfg.replyPerRound) || 1) * 3, 20)),
      log,
    }).catch((e) => ({ items: [], scanned: 0, fetched: 0, errors: [String(e?.message ?? e)], at: Date.now() }))
    replyCache = { at: now, data }
    return data
  }

  /**
   * ⭐ 这条视频是娱乐还是学习/技术（2026-10-19）：发评论 / 三连之前先看这个。
   *    取 `bili_video_info` 的 `tname`（分区）+ title + tags，交给 lib/classify.mjs 粗筛。
   *    结果缓存 5 分钟（一轮里可能被问好几次）。
   *    ⚠️ 取不到视频信息 ⇒ **放行**（unknown），别因为一次接口失败把整轮卡死。
   */
  const kindCache = new Map()
  const videoKind = async (bvid) => {
    const bv = String(bvid || '').trim()
    if (!bv) return { kind: 'unknown', why: ['没有 BV 号'] }
    const hit = kindCache.get(bv)
    if (hit && Date.now() - hit.at < 300_000) return hit.data
    let data = { kind: 'unknown', why: ['取不到视频信息 → 放行'] }
    try {
      const r = await call('bili_video_info', { bvid: bv })
      const obj = (typeof r === 'string') ? JSON.parse(r) : r
      data = {
        ...classifyVideo({
          tname: obj?.tname, title: obj?.title, tags: obj?.tags,
          allowTags: Array.isArray(cfg.funTagsAllow) ? cfg.funTagsAllow : [],
          blockTags: Array.isArray(cfg.funTagsBlock) ? cfg.funTagsBlock : [],
        }),
        title: obj?.title || '', tname: obj?.tname || '', tags: Array.isArray(obj?.tags) ? obj.tags : [],
      }
    } catch (e) {
      data = { kind: 'unknown', why: [`取视频信息失败：${String(e?.message ?? e).slice(0, 60)}`] }
    }
    kindCache.set(bv, { at: Date.now(), data })
    return data
  }

  const tripleLeftToday = () => {
    const cap = Math.max(0, Number(cfg.triplePerDay) || 0)
    if (!(cfg.serviceOn && cfg.tripleOn) || cap <= 0) return 0
    return Math.max(0, cap - tripledCountOn(stateDir, dayKey()))
  }

  const mcpWhitelist = () => {
    const list = ['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info']
    if (cfg.autoComment || cfg.replyToComments) list.push('bili_reply')   // 只有真要发评论才给这只
    // ⭐ 三连：只有开着且今天还有额度时，才把 bili_triple 交给那一轮（关着 = 模型连名字都看不到）
    if (tripleLeftToday() > 0) list.push('bili_triple')
    return list
  }

  /**
   * ⭐ 找出「本机的 llm provider 插件」（2026-10-19，修 NO_ADAPTER）
   * ============================================================================
   * 🔴 事故：用户在设置里选了桌面端在用的 `qodercn`，那一轮直接
   *    `dsh: NO_ADAPTER: no adapter registered for provider "qodercn"` 秒退 ✗
   *    原因：headless profile 只装了 `dsh-base + dsh-headless`，里面**只有** `deepseek-official`；
   *    而 `qodercn` 是桌面端的 `dsh-our-free-model` 插件注册的 —— 那是 profile 级的 bundle。
   * ⭐ 做法：**不装插件、不改用户的 profile**，而是把本机已有的 provider 插件**用绝对 file:// 路径
   *    塞进那一轮的 `--patch` overlay 里**（实测可行：`insert: { name: 'file:///…/index.js' }`）。
   *    判定"谁是 provider 插件"：package.json 的 `keywords` 里有 `llm-provider`（our-free-model 就是）。
   * ⚠️ 这些东西只在**那一轮的子进程**里生效，不污染用户平时的 profile。
   */
  let providerPluginCache = { at: 0, list: null }
  const findProviderPlugins = () => {
    const now = Date.now()
    if (providerPluginCache.list && now - providerPluginCache.at < 60_000) return providerPluginCache.list
    const found = []
    const seen = new Set()
    const roots = []
    const profileDir = String(process.env.DSH_PROFILE_DIR || '')
    if (profileDir) roots.push(join(profileDir, 'node_modules'))
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      for (const p of readdirSync(join(home, 'profiles'))) roots.push(join(home, 'profiles', p, 'node_modules'))
    } catch { /* 没有就算了 */ }
    for (const root of roots) {
      let names = []
      try { names = readdirSync(root) } catch { continue }
      const dirs = []
      for (const n of names) {
        if (n.startsWith('.')) continue
        if (n.startsWith('@')) {
          try { for (const c of readdirSync(join(root, n))) dirs.push(join(n, c)) } catch { /* 跳过 */ }
        } else dirs.push(n)
      }
      for (const rel of dirs) {
        const pkgFile = join(root, rel, 'package.json')
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
          const kw = Array.isArray(pkg.keywords) ? pkg.keywords : []
          if (!kw.includes('llm-provider')) continue
          const main = String(pkg.main || 'index.js')
          const entry = join(root, rel, main)
          if (!existsSync(entry)) continue
          const key = entry.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          found.push({ name: String(pkg.name || rel), entry, fileUrl: pathToFileURL(entry).href })
        } catch { /* 单个包坏了不影响别的 */ }
      }
    }
    providerPluginCache = { at: now, list: found }
    return found
  }

  /**
   * 写 headless 那一轮用的 overlay（`--patch` 带上）：
   *   ① **换模型**（可选）：覆盖 `agent-default-model` 的 provider/model；
   *      如果选的 provider 不是 base 自带的那家，就**同时**把本机的 provider 插件挂进来，
   *      并放开 `credentials`（那些插件要读账号凭证；headless 默认把它关了）。
   *   ② **挂 B站 MCP**（可选）：把 mcp_server.py 当 stdio server 接进去，并限定白名单。
   * ⚠️ 原来这两件事是一体的（`if (!cfg.overlayMcp) return null`）—— 现在用户可能**只换模型、不挂 MCP**
   *    ⇒ 只要有一件事要做就写这份 overlay。
   */
  const BASE_PROVIDERS = new Set(['deepseek-official', 'deepseek-account'])
  /**
   * ⭐ 用户自己在「设置 → 模型」里加的供应商，配置落在**桌面 profile 的 `cordis.patch.yml`** 里
   *    （形如 `- id: llm-pi-ai` + `config.providers.<名字>`）。headless profile 没有这一段 ⇒
   *    那一轮报 `NO_ADAPTER: no adapter registered for provider "ark"` ✗（2026-10-19 用户实测）
   *    ⇒ 这里把那段**原样搬进 overlay**（通用做法：不认 ark，只认"llm-pi-ai 这段配置"）。
   */
  const piAiBlock = () => {
    const dirs = []
    if (process.env.DSH_PROFILE_DIR) dirs.push(process.env.DSH_PROFILE_DIR)
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      for (const p of readdirSync(join(home, 'profiles'))) dirs.push(join(home, 'profiles', p))
    } catch { /* 没有就算了 */ }
    for (const dir of dirs) {
      try {
        const lines = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
        const start = lines.findIndex((l) => /^-\s*id:\s*['"]?llm-pi-ai['"]?\s*$/.test(l))
        if (start < 0) continue
        let end = lines.length
        for (let i = start + 1; i < lines.length; i += 1) {
          if (/^-\s/.test(lines[i])) { end = i; break }
        }
        const block = lines.slice(start, end).join('\n').replace(/\s+$/, '')
        if (block) return block
      } catch { /* 下一个 profile 看看 */ }
    }
    return ''
  }

  const ensureOverlay = () => {
    const file = join(stateDir, 'headless-overlay.yml')
    const script = join(stateDir, 'mcp_server.py')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`
    const blocks = []
    const model = modelNow()
    if (model) {
      // ⭐ 覆盖 dsh-base 里的 `agent-default-model`（headless profile 继承自 base）
      blocks.push([
        '- id: agent-default-model',
        "  name: '@deepseek-ai/dsh-agent-default-model'",
        '  config:',
        `    provider: ${q(model.provider)}`,
        `    model: ${q(model.model)}`,
        '',
      ].join('\n'))
      // ⭐ 2026-10-19：`deepseek-account`（用本机登录的 DeepSeek 账号，不需要 API Key）
      //    headless 的 bundle 把这个服务关了 ⇒ 这一轮要三件一起放开才认得出来。
      //    实测（本机）：`provider: deepseek-account / model: deepseek-flash` + 这三行 ⇒ exit=0，能调 B站 工具 ✓
      if (model.provider === 'deepseek-account') {
        for (const id of ['credentials', 'authorization', 'deepseek-account']) {
          blocks.push([`- id: ${id}`, '  disabled: false', ''].join('\n'))
        }
        log('overlay：deepseek-account 走本机 DeepSeek 账号（放开 credentials / authorization / deepseek-account）')
      } else if (!BASE_PROVIDERS.has(model.provider)) {
        // ⭐ 不管有没有 provider 插件，credentials 都要放开（路由的 apiKeyEnv 指向凭据库）
        blocks.push(['- id: credentials', '  disabled: false', ''].join('\n'))
        const plugins = findProviderPlugins()
        if (plugins.length) {
          const insert = ['- insert:']
          for (const p of plugins) {
            insert.push(`    - id: ${String(p.name).replace(/[^A-Za-z0-9_-]/g, '-')}`)
            insert.push(`      name: ${q(p.fileUrl)}`)
          }
          insert.push('')
          blocks.push(insert.join('\n'))
          log(`overlay：provider ${model.provider} 不在 base 里 ⇒ 挂上本机的 provider 插件（${plugins.map((p) => p.name).join('、')}）`)
        } else {
          log(`⚠️ overlay：没找到本机的 llm provider 插件（keywords 含 llm-provider）—— provider ${model.provider} 可能仍然 NO_ADAPTER`)
        }
        // ⭐ 用户自己在「设置 → 模型」里加的供应商（llm-pi-ai 的 providers 段）也要搬进来，
        //    否则 headless 里认不出这个 provider ⇒ `NO_ADAPTER` ✗
        const route = piAiBlock()
        if (route) {
          blocks.push(route)
          log('overlay：把桌面 profile 里的 llm-pi-ai 路由配置（你自己加的供应商）搬进来了')
        }
      } else if (hasDeepseekKey()) {
        // ⭐ 2026-10-19 补：base 的 `deepseek-official` **也要把 credentials 放开** ——
        //    用户把 Key 存在凭据库（设置 → 模型）里的时候，headless 默认读不到它 ⇒
        //    报 `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"` ✗
        blocks.push(['- id: credentials', '  disabled: false', ''].join('\n'))
        log('overlay：deepseek-official 用本机凭据库里的 Key（已放开 credentials）')
      }
    }
    if (cfg.overlayMcp) {
      blocks.push([
        '- insert:',
        '    - id: mcp-bili-duty',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: bili-duty',
        '        transport: stdio',
        `        command: ${q(posix(cfg.pythonPath || 'python'))}`,
        '        args:',
        `          - ${q(posix(script))}`,
        '        env:',
        `          BILI_MCP_TOOLS: ${q(mcpWhitelist().join(','))}`,
        /* ⭐ 三连的闸门下发到那一轮的 MCP 进程（2026-10-19）：
         *    开关 / 剩余额度 / 投币数 / 收藏夹 / 记账文件全由宿主决定 —— 模型改不了 ✗ */
        `          BILI_TRIPLE: ${q(tripleLeftToday() > 0 ? '1' : '0')}`,
        `          BILI_TRIPLE_LEFT: ${q(String(tripleLeftToday()))}`,
        `          BILI_TRIPLE_COIN: ${q(String(Math.min(2, Math.max(1, Number(cfg.tripleCoin) || 1))))}`,
        `          BILI_TRIPLE_FAV: ${q(String(Math.max(0, Number(cfg.tripleFavMediaId) || 0)))}`,
        `          BILI_TRIPLE_STATE: ${q(posix(join(stateDir, 'interacted.jsonl')))}`,
        '',
      ].join('\n'))
    }
    if (!blocks.length) return null
    const yml = blocks.join('\n')
    try { writeFileSync(file, yml, 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }
  // ⭐ 启动时就写一份（设置页 / 定时器不一定先跑过；这样文件永远是当前配置的映像）
  try { ensureOverlay() } catch (e) { log(`初始化 overlay 失败（不影响加载）：${e?.message ?? e}`) }

  /**
   * ⭐ 评论发出后复核（2026-10-16 加的行 —— 起因是用户在评论区反馈
   *    「**回执成功不等于公开可见，新号会被压审**」）：
   * 那一轮的 `bili_reply` 回"发送成功"只代表**接口收了**；新号 / 风控会让它进审核，
   * 那时候连 @ 通知都不会推 ⇒ 插件以为发了、下一轮又不再发 ⇒ **一条都没到人**。
   * 所以由**宿主**（有网络、有凭证、不受沙箱限制）去拉一次评论列表 / 楼中楼来核。
   * ⚠️ 措辞守则：看不到写「**没查到**」，**绝不写"没发出去"**（翻页/热度排序都会漏）。
   */
  let verifying = false
  const runVerify = async (why = 'manual') => {
    if (verifying) return { ok: false, error: '上一次复核还没跑完，等它完事' }
    verifying = true
    try {
      log(`评论复核开始（${why}）`)
      const r = await verifyRecent(stateDir, { log })
      // ⭐ 2026-10-19：**没复核到任何一条就别往报告里写**。
      //    原来每轮失败后 90 秒的复核都会追加一句「都复核过了（跳过的旧记录 5 条）」——
      //    一天下来报告尾部会堆出十几行一模一样的话，模型写报告时连"唯一锚点"都找不到 ✗
      const f = (r.checked.length > 0 || why === 'manual') ? appendVerifyToReport(stateDir, r.text) : ''
      log(`评论复核结束（${why}）：查了 ${r.checked.length} 条${f ? `，已写进 ${f}` : '（没有新结果，不写报告）'}`)
      return { ok: true, why, checked: r.checked, skipped: r.skipped, text: r.text, report: f || '' }
    } catch (e) {
      log(`评论复核失败（${why}）：${e?.message ?? e}`)
      return { ok: false, why, error: String(e?.message ?? e) }
    } finally { verifying = false }
  }

  /**
   * ⭐ 保底：那一轮**没写出报告**时，宿主自己补一份"占位报告"。
   * 起因（2026-10-16 用户实测反馈）：有一轮卡在"转写返回空 ⇒ 以为 ASR 坏了"上反复重试，
   *   最后 `out/` 是空的、判重表也没建 ⇒ **使用者完全看不到发生了什么**，也不知道白烧了钱 ✗。
   * ⚠️ 只在"报告本来该有却没有"时补（`reportLevel: off` 不补 ✓），不覆盖已有的报告 ✓。
   */
  /**
   * ⭐ 从这一轮的输出里认出"到底是哪一类死法"，给一句人能看懂的话（2026-10-19 加）。
   *   用户在日志里只看到 `dsh: CLIENT_ERROR: … reasoning_content …` 一脸懵 ⇒ 这里翻成人话。
   */
  const explainDeath = (tail) => {
    const t = String(tail || '')
    if (/reasoning_content/i.test(t)) {
      return '模型报「reasoning_content must be passed back」—— 这条通道的 **thinking 模式**跟宿主适配不了'
        + '（多轮工具调用时 reasoning 没被回传）。换一个非思考模型：`our-free-model/glm-5.3-flash-free` 或 `longcat-2.5-preview-free`。'
    }
    if (/ModelNotOpen|not activated the model/i.test(t)) {
      return '火山方舟那边**这个模型没开通**（Key 本身有效）—— 去方舟控制台「模型广场 → DeepSeek → 开通」，'
        + '或者换一个已经开通的模型 id（Ark 的 id 带日期，比如 `deepseek-v4-1-flash-261017`）。'
    }
    if (/PI_AI_ERROR/i.test(t)) return '模型网关报错（火山方舟 / OpenAI 兼容端点）—— 看上面那行原始错误，多半是模型 id 或开通状态'
    if (/MISSING_CREDENTIAL/i.test(t)) return '宿主没拿到这个 provider 的凭证（见「这一轮用哪个模型」里的提示，换通道或补 Key）'
    if (/NO_ADAPTER/i.test(t)) return '这个 provider 在 headless 里没有适配器（换通道，或确认 provider 插件装在本机）'
    if (/AUTH|api key/i.test(t)) return 'Key 无效（注意 Ark 的 `ark-…` 不是 DeepSeek 的 `sk-…`）'
    if (/EBUSY|EPERM/i.test(t)) return '文件被占用 / 没权限（多半是 venv 或日志被别的进程占着）'
    return ''
  }

  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      const why = explainDeath(tail)
      writeFileSync(f, [
        `# 刷B站 · ${dayKey()} —— 这一轮没写出报告`,
        '',
        `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
        why ? `> 🔎 **看起来是**：${why}` : '> 常见原因是它卡在某个工具上反复重试、或者把预算烧完了。下一轮它会重来。',
        '> 下面附日志尾部，方便定位（插件数据目录里的 `duty.log` 有完整版）。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  /**
   * ⭐ 同一时间只允许跑一轮（2026-10-19 加）
   * 🔴 事故：用户连点两次「现在跑一轮」⇒ 起了两个 headless 进程同时刷，
   *    日志互相交织、两边都可能挑中同一批视频（重复评论），而且都不是"再点一次就好"的状态 ✗
   * ⇒ 用一个简单的单飞锁：跑着的时候再点就回「上一轮还在跑」，把开始时间一起带回去。
   */
  let dutyRun = { at: 0, why: '' }
  let childTail = ''   // ⭐ 这一轮子进程输出的尾巴（退出时用来判断"到底怎么死的"）
  const dutyRunning = () => Boolean(dutyRun.at)
  /**
   * ⭐ 新一轮开始前，把**上一轮留下的占位报告**改名收走。
   * 起因：占位报告（"这一轮没写出报告"）一旦存在，`stubReportIfMissing` 就不再补、
   * 而模型那一轮又是"追加到末尾" ⇒ 真正写出来的报告会被埋在旧占位报告下面 ✗
   * ⇒ 只在**内容确实是占位报告**时改名（正常报告一个字不动），保留成 `.failed-<时间>.md`。
   */
  const stashStubReport = () => {
    try {
      const f = join(outDir, `${dayKey()}.md`)
      if (!existsSync(f)) return
      const text = readFileSync(f, 'utf8')
      // ⚠️ 只收**纯粹是占位报告**的那种：一旦这轮已经往里面写了真报告（有 `### BV…` 标题行），
      //    绝不能整份改名 —— 那会把今天的报告一起搬走 ✗
      const stubOnly = /^# 刷B站 · /.test(text) && text.includes('这一轮没写出报告') && !/^#{2,3}[ \t]*BV/m.test(text)
      if (!stubOnly) return
      const bak = join(outDir, `${dayKey()}.failed-${Date.now()}.md`)
      renameSync(f, bak)
      log(`把上一轮的占位报告收走：${bak}`)
    } catch (e) { log(`收走占位报告失败（不影响这一轮）：${e?.message ?? e}`) }
  }

  const runDuty = async (why = 'window') => {
   try {
    refreshCfg()          // ⭐ 设置页刚改过的值要立刻生效（config 是就地改的，快照会过期）
    // ⭐ 总开关关着就什么都不起（2026-10-19）：自动轮、手动轮、工具层全走这一条判据
    if (!cfg.serviceOn) {
      log(`「刷B站服务」总开关关着 —— 这一轮（${why}）没跑`)
      return { started: false, disabled: true, hint: '「刷B站服务」总开关关着 —— 先把它打开再跑' }
    }
    // ⭐ 选了要 Key 的通道但本机没配 ⇒ 当场拦下（不然 headless 8 秒后才 MISSING_CREDENTIAL，白等）
    const chosen = modelNow()
    if (chosen && chosen.provider === 'deepseek-official') {
      const ks = deepseekKeyState()
      if (!ks.ok) {
        const hint = `这一轮选的是 deepseek-official，但${ks.why} —— `
          + '要么去「设置 → 模型」填一个 DeepSeek 的 Key（sk-…），要么在「这一轮用哪个模型」里换成免费通道（our-free-model）。'
        log(`没跑：${hint}`)
        return { started: false, needKey: true, hint }
      }
    }
    if (dutyRunning()) {
      const secs = Math.max(1, Math.round((Date.now() - dutyRun.at) / 1000))
      const ago = secs >= 60 ? `${Math.floor(secs / 60)} 分钟` : `${secs} 秒`
      log(`又点了一次「跑一轮」，但上一轮（${dutyRun.why}）还在跑，已 ${ago} —— 忽略这次`)
      return { started: false, busy: true, since: dutyRun.at, hint: `上一轮还在跑（已经 ${ago}），等它结束再点` }
    }
    stashStubReport()
    const dsh = resolveDsh()
    /* ⭐ 找不到 dsh 就**别硬跑**（2026-10-19，合并上游 0.1.11）：
     *    以前会退化成裸 `dsh` 去 spawn ⇒ 必然失败，日志只剩一句 code=1 和一段乱码，
     *    用户完全不知道该怎么办。现在直接停下、说清楚"去哪儿填 dsh 路径"，并照常补一份占位报告。 */
    if (dsh?.notFound) {
      const hint = '这一轮没跑：找不到 dsh —— 桌面版多半不是 npm 全局安装的。请到「环境与账号」里把「dsh 路径」指到 dsh 的 bin.js（或 .cmd），再试一次。'
      log(hint)
      stashStubReport(hint)
      return { ok: false, started: false, noDsh: true, hint }
    }
    const overlay = ensureOverlay()
    const rest = ['--profile', cfg.headlessProfile || 'headless']
    if (overlay) rest.push('--patch', overlay)
    // ⭐ 回复评论开着 ⇒ 先让宿主扫一遍"谁回了我"（窗口内全量 + 规则打分），把清单塞进提示词
    let shortlist = null
    if (cfg.replyToComments) {
      try { shortlist = await replyShortlist() } catch (e) { log(`扫回复失败（不影响这一轮）：${e?.message ?? e}`) }
      if (shortlist?.items?.length) log(`待回复 ${shortlist.items.length} 条（分数 ≥ ${cfg.replyMinScore}）`)
    }
    const prompt = promptFor(why, shortlist)   // ⭐ 手动轮不受"每轮 N 条评论"自限（见 promptFor 里 manual 的注释）
    rest.push('-')                     // ⭐ 任务走 stdin（`-`），别把几千字塞进命令行
    const plan = dshSpawn(dsh, rest)   // ⭐ .cmd / 带空格路径 / cmd 引号规则统一在这里处理
    // ⭐ 这一轮的工作目录 = 使用者（或别的用户）的**工作区** —— 只有这样它的 `AGENTS.md` 才会自动加载。
    // ⭐ 工作目录 = **插件家**：那一轮**被沙箱关着**，只写得了自己工作目录里的东西 ✗
    //    （2026-10-14 教训：为了让它读工作区里的 AGENTS.md 把 cwd 改成工作区 ⇒
    //      它写不了家目录里的 out/ 报告、整轮卡在"我是被沙箱关着的"上面打转 ✗；
    //      现在改成"设定由插件读进来、内联进提示词" ✓，cwd 回到插件家 ✓）
    const cwd = stateDir
    log(`刷B站开跑（${why}）：${plan.cmd} ${plan.args.slice(0, 4).join(' ')} …  cwd=${cwd}`)
    dutyRun = { at: Date.now(), why }        // ⭐ 上锁：这一轮结束前不再接受新的
    childTail = ''                           // ⭐ 清掉上一轮的尾巴
    const child = spawn(plan.cmd, plan.args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(plan.verbatim),
      stdio: ['pipe', 'pipe', 'pipe'],
      // ⭐ PYTHONUTF8 / PYTHONIOENCODING：Windows 上 Python 默认按 GBK 编解码，
      //    中文 / emoji 打进管道会炸（用户反馈过 UnicodeDecodeError），一律按 UTF-8 来
      // ⭐ ELECTRON_RUN_AS_NODE：**桌面版（Electron）里 spawn 出去的 node 必须带这个**，
      //    否则它当成"再开一个 Electron 应用"、什么都不干就以 0 退出（issue #5：0.17 秒、code 0、什么都没做）
      env: pyEnv({ BILI_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
    })
    // ⭐ 提示词从这里送进去（cmd 那边命令行只留短参数，避免引号/长度把整轮打死）
    try {
      child.stdin.on('error', () => { /* 子进程提前退出时 EPIPE，别升级成未捕获异常 */ })
      child.stdin.end(prompt, 'utf8')
    } catch (e) { log(`写提示词到子进程失败：${e?.message ?? e}`) }
    // ⚠️ 2026-10-16 issue #1（用户 `miaoxingyunduo` 贴了崩溃日志）：`duty.log` 被别的进程占着时
    //    (`EBUSY`) `appendFileSync` 会抛异常 —— 而这里是 **stream 的 data 回调**，没人接
    //    ⇒ **未捕获异常 ⇒ 整个 DSH 宿主被杀**（所有会话一起没）。跟 10-14 定时器那次是同一类 ✗
    //    ⇒ ⭐ 规矩：**插件里任何写日志/写文件的地方都包好 try/catch**，再错也只该"这一轮没跑成" ✓
    const pick = (buf) => {
      const s = decodeOut(buf)
      childTail = (childTail + s).slice(-6000)   // ⭐ 留一小段尾巴，退出时判断死法
      try { appendFileSync(logFile, s, 'utf8') } catch { /* 写不进去就丢，绝不能抛 */ }
    }
    child.stdout?.on('data', pick)
    child.stderr?.on('data', pick)
    child.on('exit', (code) => {
      dutyRun = { at: 0, why: '' }          // ⭐ 解锁
      log(`刷B站结束（${why}，code=${code}）`)
      // ⭐ 死了就说人话：把 CLIENT_ERROR / reasoning_content / MISSING_CREDENTIAL 翻成建议
      if (code !== 0) {
        const why2 = explainDeath(childTail)
        if (why2) log(`⚠️ 这一轮的失败原因：${why2}`)
      }
      stubReportIfMissing(code)   // ⭐ 没写报告就补一份占位 —— 别让使用者什么都看不到
      rotateLogIfBig()            // ⭐ 日志别无声地长（三天 797KB ⇒ 一年约 100MB）
      // ⭐ 这一轮挑了几条：从今天的报告里数（上一轮挑的还在同一份文件里 ⇒ 数出来就是全天的账）
      try {
        const st = readJson(dutyStateFile, {})
        const prev = st.day === dayKey() ? Number(st.picked || 0) : 0
        const picked = countPickedToday()   // 报告是事实来源、state 只是兜底（跟闸门同一个算法）
        if (picked > prev) { bumpState({ picked }); log(`今天挑到 ${picked} 条（上限 ${Number(cfg.perDay) || 0} 条）`) }
      } catch (e) { log(`数挑了几条时出错（不影响这一轮）：${e?.message ?? e}`) }
      // ⭐ 发完评论之后**过一会儿再核一次**（2026-10-16 加的「评论发出后复核」）：
      //    接口回"发送成功"≠ 公开可见（新号/风控会进审核）；而"不公开"时连 @ 通知都不会推 ⇒
      //    插件会以为发了、下一轮不再发 ⇒ 一条都没到人。等 90 秒再查，避免把"还在审核"误判成"没发出去"。
      const verifyTimer = setTimeout(() => { Promise.resolve(runVerify('round')).catch((e) => log('复核异常：' + (e?.message ?? e))) }, 90_000)
      verifyTimer.unref?.()   // 别为了一次复核把宿主进程的退出拖住 90 秒
    })
    child.on('error', (e) => { dutyRun = { at: 0, why: '' }; log(`刷B站起不来：${e?.message ?? e}`) })
    return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile }
   } catch (e) {
    dutyRun = { at: 0, why: '' }
    log(`刷B站开跑失败（${why}）：${e?.stack ?? e}`)
    return { started: false, why, error: String(e?.message ?? e) }
   }
  }

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 2026-10-14 事故（使用者那边表现为"DSH 突然崩了、网页 Failed to fetch (gateway/internal)"）：
   *    第一版是 `setInterval(tick, 60_000)`，回调里抛的 TypeError **没人接**，直接把整个宿主进程带走
   *    （`dsh: fatal uncaught exception`）。⇒ **定时器回调必须自己兜住所有异常**：
   *    插件再错也只该"这一轮没跑成"，绝不该杀宿主。
   */
  const tick = () => {
    try {
      refreshCfg()                    // ⭐ 定时器活得比设置页久：每一跳都重新读一遍配置
      if (!cfg.serviceOn) return       // ⭐ 总开关关着 ⇒ 定时器什么都不做
      if (!cfg.peakValley) return
      const now = new Date()
      const st = readJson(dutyStateFile, {})
      const today = dayKey(now)
      // ⭐ 闸门看的是「今天已经**挑到几条**」（从今天的报告里数出来），不是「跑了几轮」
      if (countPickedToday(now) >= Number(cfg.perDay || 0)) return
      // ⭐ 「不写日报」那档没有报告可数 ⇒ 数不出条数就保守一点：一天只跑一轮
      if (String(cfg.reportLevel || 'full') === 'off' && roundsToday(now) >= 1) return
      for (const k of ['noon', 'night']) {
        if (!cfg[k]) continue
        if (!inWindow(now, WINDOWS[k])) continue
        const key = `${today}:${k}`
        if (st.windows?.[key]) continue
        bumpState({ windows: { ...(st.windows || {}), [key]: true }, count: roundsToday(now) + 1, lastRunAt: now.toISOString(), lastWhy: k })
        runDuty(`window:${k}`).catch((e) => log(`跑一轮失败：${e?.message ?? e}`))
        return
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()                                    // 别因为这个定时器让进程不肯退出
    ctx.effect(() => () => clearInterval(timer), 'bili-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    // ⚠️ 超过 1MB 得**先把 Promise 收掉**再掐断：只 destroy 的话它永远不 settle，
    //    这个请求就挂在那儿（不回响应、也不释放）
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  const venvPython = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')

  /**
   * 建 venv + 装依赖 —— ⭐ **起完就返回，不等它装完**。
   *
   * 🔴 为什么必须这样（2026-10-14 事故）：第一版是 `async` 全程 await，
   *    而"建 venv + pip install"在使用者这条网络上要**几分钟** ⇒ 那个工具调用一直挂着，
   *    **整个会话僵住、连"暂停"都卡，最后只能重启 dsh** ✗。
   *    现在的做法：spawn 出去、输出追加进 `install.log`，函数立刻返回；
   *    想知道装完没 —— 读日志，或看 `bili_duty_status` 里的 `installing`。
   * 依赖走**国内镜像**（使用者那条网络 pip 直连只有 ~24KB/s ✗；uv + 清华源是几十秒 ✓）。
   */
  let installing = false
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 写不进去就算了 */ } }

  let uvOk = null
  const haveUv = async () => {
    if (uvOk) return true
    const ok = await new Promise((resolve) => {
      try {
        const c = spawn('uv', ['--version'], { windowsHide: true, stdio: 'ignore' })
        c.on('exit', (code) => resolve(code === 0))
        c.on('error', () => resolve(false))
      } catch { resolve(false) }
    })
    // ⭐ 只缓存"有"：把"没有"也缓存住的话，这一轮里刚下好的 uv（或用户刚装上的）会被一直当成没有，
    //    非重启 dsh 不可 ✗（调用点只有装依赖那两处，多探一次几毫秒）
    if (ok) uvOk = true
    return ok
  }

  /** 探一下某个命令在不在（用于"这台机器有没有 python"）—— 陌生人第一条坎就卡在这儿 */
  const probeCmd = (cmd) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0))
      c.on('error', () => resolve(false))
    } catch { resolve(false) }
  })

  const spawnLogged = (cmd, args, { env = null } = {}) => new Promise((resolve) => {
    appendInstall(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try { c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv(env || {}) }) }
    catch (e) { appendInstall(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => appendInstall(decodeOut(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { appendInstall(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { appendInstall(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  // ───────── 本地转写（ASR）：**独立环境**，别把主 venv 撑成 1GB ─────────
  const asrPython = () => join(asrDir, process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python')
  const appendAsr = (s) => { try { appendFileSync(asrLogFile, String(s)) } catch { /* 日志写不了也不能炸 */ } }
  // ⭐ 转写的临时目录必须由**宿主**预先建好：值班那一轮跑在沙箱里，
  //    而沙箱只允许写"该子进程启动前就已存在"的目录（2026-10-14 那一轮自己挖出来的规则）
  //    （实际建目录在下面的 ensureHomeLayout() —— 家目录可改之后，建目录也得跟着重跑）

  // ⭐ 判重表也由**宿主**预先建好（两个原因）：
  //   ① 那一轮被沙箱关着，"新建文件"会被拒（2026-10-14 那条规矩）；
  //   ② 它读不出判重表 ⇒ 以为"没记录过" ⇒ 同一批视频反复推送（用户实测反馈 2026-10-16）。
  //    内容也由 ensureHomeLayout() 铺。

  // ⭐ 归档目录：那一轮**被沙箱关着**，只写得了"启动前就已存在"的目录 ⇒ 宿主预建 ✓
  //    （2026-10-16 主人要的"它看过什么"清单：报告是给人看的，归档是给检索用的 ✓）

  /**
   * ⭐ 日志轮转（2026-10-16 量出来的：`duty.log` 三天就 797 KB、没有轮转 ⇒ 一年约 100 MB ✗）
   * 超过 2MB 就滚成 `duty.log.1`（只留一份），别让它在 C 盘上无声地长。
   */
  const rotateLogIfBig = (limit = 2 * 1024 * 1024) => {
    try {
      if (!existsSync(logFile) || statSync(logFile).size < limit) return
      const bak = logFile + '.1'
      try { rmSync(bak, { force: true }) } catch { /* 删不掉就算了 */ }
      renameSync(logFile, bak)
      appendFileSync(logFile, `${new Date().toISOString()}  日志超过 2MB，旧的滚到 duty.log.1\n`, 'utf8')
    } catch { /* 轮转失败不该影响跑一轮 */ }
  }
  let installingAsr = false

  /** 找 uv：系统里的 → 插件家里下好的 → 自己下一份（给"两样都没有"的人）；主/转写两套安装共用 */
  const resolveUv = async () => {
    const bundled = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (await haveUv()) return 'uv'
    if (existsSync(bundled)) return bundled
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    const got = await ensureUv({ dir: join(stateDir, 'bin'), log: appendInstall })
    if (got) appendInstall('uv 已就位：' + got + '\n')
    return got
  }

  /** 跟 spawnLogged 一样，但可以写进别的日志、可以带环境变量 */
  const spawnTo = (cmd, args, { sink = appendInstall, env = null, verbatim = false } = {}) => new Promise((resolve) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try {
      c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: Boolean(verbatim),
        env: pyEnv(env || {}) })
    } catch (e) { sink(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => sink(decodeOut(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { sink(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { sink(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  /** 装"本地转写"那一套：独立环境 + faster-whisper + yt-dlp + 先把 Whisper 模型下好 */
  const runAsrInstall = () => {
    if (installingAsr) return { ok: true, busy: true, log: asrLogFile, hint: '正在装转写依赖，别重复起' }
    installingAsr = true
    appendAsr(`\n=== ${new Date().toISOString()} 开始装"本地转写"依赖 ===\n`)
    ;(async () => {
      try {
        const mirror = process.env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const hf = process.env.BILI_DUTY_HF_ENDPOINT || 'https://hf-mirror.com'
        const py = asrPython()
        const uvCmd = await resolveUv()
        if (!existsSync(py)) {
          // --seed：把 pip 也装进去（uv 默认不给）—— 不然出现问题时连 pip 都没有，没法补救 ✗
          if (uvCmd) await spawnTo(uvCmd, ['venv', '--seed', asrDir], { sink: appendAsr, env: uvEnv(stateDir) })
          else await spawnTo(String(cfg.pythonPath || 'python'), ['-m', 'venv', asrDir], { sink: appendAsr, env: uvEnv(stateDir) })
        }
        if (!existsSync(py)) {
          appendAsr('建环境失败 —— 先点上面的「装依赖」，把 uv 或 Python 准备好\n')
          log('转写：建环境失败'); return
        }
        appendAsr('装 faster-whisper + yt-dlp（走国内镜像）…\n')
        let code = 1
        // ⚠️ av 必须钉在 17 以下：faster-whisper 1.2.1 会调 av.open(metadata_errors=…)，
        //    而 av 17+ 不再接受这个参数 ⇒ 装了最新的 av 反而转不了（2026-10-14 在主人机器上实证）
        const AV_PIN = process.env.BILI_DUTY_AV_PIN || 'av>=12,<17'
        if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', py, '-i', mirror, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr, env: uvEnv(stateDir) })
        if (code !== 0) code = await spawnTo(py, ['-m', 'pip', 'install', '-i', mirror, 'faster-whisper', 'yt-dlp', AV_PIN], { sink: appendAsr, env: uvEnv(stateDir) })
        if (code !== 0) { appendAsr('装包失败 —— 看上面的报错\n'); log('转写：装包失败'); return }
        // ⭐ 顺手把模型也下好（不然第一次跑那一轮会卡在下载上 ✗）；模型走 HuggingFace 国内镜像
        const model = String(cfg.asrModel || 'small')
        // 模型缓存必须放进插件家：默认的 ~/.cache 在本机拒绝写入（2026-10-14 实测 WinError 5）
        const hfHome = join(stateDir, '.hf-cache')
        try { mkdirSync(hfHome, { recursive: true }) } catch { /* 建不了后面会给报错 */ }
        appendAsr(`下 Whisper 模型「${model}」（缓存在 ${hfHome}，源 ${hf}，几百 MB，只需要一次）…\n`)
        const code2 = await spawnTo(py, ['-c',
          'import os,sys;os.environ["HF_HUB_DISABLE_XET"]="1";from faster_whisper import WhisperModel;WhisperModel(sys.argv[1], device="cpu", compute_type="int8");print("模型就绪")',
          model], { sink: appendAsr, env: { HF_ENDPOINT: hf, HF_HOME: hfHome, HF_HUB_DISABLE_XET: '1' } })
        appendAsr(`=== 结束（装包 exit ${code}，模型 exit ${code2}，asrReady=${asrReadyNow()}）===\n`)
        log(`装转写依赖结束：exit=${code}/${code2}`)
      } catch (e) {
        appendAsr(`装转写依赖崩了：${e?.stack ?? e}\n`)
        log(`装转写依赖崩了：${e?.message ?? e}`)
      } finally { installingAsr = false }
    })()
    return { ok: true, started: true, log: asrLogFile, hint: '正在后台装转写依赖 —— 进度显示在下面（要下几百 MB 模型，慢一点正常）' }
  }

  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 开始装依赖 ===\n`)
    ;(async () => {
      try {
        const reqFile = join(pluginDir, 'vendor', 'bilibili-mcp', 'requirements.txt')
        const mirror = process.env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const venvPy = venvPython()
        const py = String(cfg.pythonPath || 'python')
          const uvCmd = await resolveUv()   // ⭐ 系统里的 → 家里下好的 → 自己下一份
        if (!existsSync(venvPy) && !uvCmd && !(await probeCmd(py))) {
          const msg = '这台机器上没有 uv，也没有可用的 python（试过 "' + py + '"），而且我自动下 uv 也没成功'
            + '（大概是网络到不了 GitHub / PyPI 镜像）。⇒ 请手动装 uv（单个 exe：https://docs.astral.sh/uv/）'
            + '或 Python 3.10+（安装时勾 Add to PATH），然后回来再点一次「装依赖」。'
          appendInstall(msg + '\n'); log(msg); installing = false; return
        }
        if (!existsSync(venvPy)) {
          // ⭐ 2026-10-17（issue #8③）：ASR 那个环境带了 --seed，主环境却漏了 ⇒ uv 建的 venv 默认不含 pip，
          //    一旦镜像失败、回退 `python -m pip` 就是 `No module named pip` ⇒ 连补救的路都没有 ✗
          if (uvCmd) await spawnLogged(uvCmd, ['venv', '--seed', join(stateDir, '.venv')], { env: uvEnv(stateDir) })
          if (!existsSync(venvPy) && !uvCmd) await spawnLogged(py, ['-m', 'venv', join(stateDir, '.venv')])
        }
        let code = 1
        // ⭐ 2026-10-17（issue #8②）：镜像也会整站拒绝（清华对部分 IP 回 403，而 pip 的报错写成"这个包不存在"，很误导）
        //    ⇒ 一个镜像失败就换下一个，别让用户在一个死镜像上反复撞
        const mirrors = [mirror, 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://mirrors.aliyun.com/pypi/simple']
        for (let i = 0; i < mirrors.length && code !== 0; i++) {
          const m = mirrors[i]
          if (i > 0) appendInstall(`\n--- 换个镜像再试：${m} ---\n`)
          if (uvCmd) code = await spawnLogged(uvCmd, ['pip', 'install', '--python', venvPy, '-i', m, '-r', reqFile], { env: uvEnv(stateDir) })
          if (code !== 0) code = await spawnLogged(venvPy, ['-m', 'pip', 'install', '-i', m, '-r', reqFile])
        }
        if (code === 0 && existsSync(venvPy)) {
          await persistCfg({ pythonPath: venvPy })   // ⭐ 不然设置页里显式设过 pythonPath 的话，这里就白写了
          appendInstall(`已把 pythonPath 设为 ${venvPy}\n`)
        }
        appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}）===\n`)
        log(`装依赖结束：exit=${code} venvReady=${existsSync(venvPy)}`)
      } catch (e) {
        appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
        log(`装依赖崩了：${e?.message ?? e}`)
      } finally { installing = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖 —— 进度就显示在下面（走国内镜像，通常几十秒到一两分钟）' }
  }

  /** 「测一下」：真跑一次查询再下结论（判据落在载荷上，不看自报） */
  const checkUp = async () => {
    const out = { ok: false, steps: [] }
    if (!venvReadyNow()) { out.error = '环境还没装好（可能上次装失败了）—— 点「重装主依赖」再试一次'; return out }
    if (!hasCredential()) { out.error = '还没登录：点「扫码登录」，手机 B站 扫一下'; return out }
    try {
      const who = await call('bili_check_credential', {})
      out.who = (typeof who === 'object' ? JSON.stringify(who) : String(who)).slice(0, 140)
      out.steps.push('登录有效')
    } catch (e) { out.error = '登录检查失败：' + (e?.message ?? e); return out }
    try {
      const s = await call('bili_search', { keyword: 'DeepSeek Harness', num: 3 })
      const t = typeof s === 'string' ? s : JSON.stringify(s)
      out.sample = t.slice(0, 160)
      out.steps.push('能搜到东西')
      out.ok = t.length > 2
      if (!out.ok) out.error = '搜到了空结果'
    } catch (e) { out.error = '搜索失败：' + (e?.message ?? e) }
    return out
  }

  let updateCache = null            // { at, latest } —— 检查更新的结果缓存

  /**
   * ⭐ 模型目录（给设置页的下拉框用）
   * 数据源是宿主的 `llm` 服务：`listProviders()` + `listModels(provider)`。
   * ⚠️ 有些 adapter 的 listModels 要联网/很慢 ⇒ 每个 provider 最多等 6 秒，拿不到就标个 error，
   *    界面退回手填（**不能因为模型列表拿不到就让设置页转圈**）。
   * ⚠️ 结果缓存 60 秒：设置页每 5 秒轮询一次 /status，模型目录别跟着 5 秒扫一遍。
   */
  const withTimeout = (p, ms) => new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    Promise.resolve(p).then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } },
      (e) => { if (!done) { done = true; clearTimeout(t); resolve({ __error: String(e?.message ?? e) }) } })
  })
  let modelsCache = { at: 0, data: null }
  let favCache = { at: 0, data: null }   // ⭐ 收藏夹列表缓存（60 秒）
  /**
   * ⭐ `deepseek-official` 这条路**要 API Key**（2026-10-19 用户踩了：
   *    在下拉里选了 deepseek-official，那一轮 8 秒就 `MISSING_CREDENTIAL` 退出 ✗）。
   *    这里只判断"有没有配"；配了也可能无效（验证要真发一次请求，太贵，不做）。
   *    ⇒ 列表里标出来，跑之前也拦一道，别让人白等一轮。
   */
  const hasDeepseekKey = () => deepseekKeyState().ok
  /**
   * ⭐ `deepseek-official` 这条路**要 DeepSeek 的 API Key**。
   *   2026-10-19 用户踩了两次：
   *     ① 下拉里选了 deepseek-official，本机**没配** ⇒ 8 秒后
   *        `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"` ✗
   *     ② 凭据库里那把是 **Ark（火山方舟）** 的键（`ark-…`），不是 DeepSeek 的（`sk-…`）
   *        ⇒ 就算读到了也会 `AUTH: api key is invalid` ✗
   *   ⇒ 这里先判断"能不能用"，跑之前就拦下来 + 在下拉里标出来。
   */
  const deepseekKeyState = () => {
    const env = String(process.env.DEEPSEEK_API_KEY || '').trim()
    if (env) {
      if (env.startsWith('ark-')) return { ok: false, why: '环境变量里那把是 Ark（火山方舟）的 Key（ark-…），不是 DeepSeek 的' }
      return { ok: true, why: '' }
    }
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      const y = readFileSync(join(home, '.credentials.yaml'), 'utf8')
      const m = y.match(/DEEPSEEK_API_KEY\s*:\s*['"]?([^'"\n]+)['"]?/)
      if (!m) return { ok: false, why: '没配 DEEPSEEK_API_KEY' }
      const k = m[1].trim()
      if (k.startsWith('ark-')) return { ok: false, why: '凭据库里那把是 Ark（火山方舟）的 Key（ark-…），不是 DeepSeek 的' }
      if (!k) return { ok: false, why: 'DEEPSEEK_API_KEY 是空的' }
      return { ok: true, why: '' }
    } catch { return { ok: false, why: '读不到凭据库（.credentials.yaml）' } }
  }
  const providerNote = (id) => {
    if (id !== 'deepseek-official') return ''
    const s = deepseekKeyState()
    return s.ok ? '' : `deepseek-official 跑不了：${s.why} —— 去「设置 → 模型」填，或换成免费通道（our-free-model）`
  }
  const modelsCatalog = async () => {
    refreshCfg()
    const now = Date.now()
    if (modelsCache.data && now - modelsCache.at < 60_000) return { ok: true, cached: true, ...modelsCache.data }
    const out = { current: modelNow(), providers: [], errors: [] }
    let llm = null
    try { llm = ctx.get?.('llm') ?? null } catch { llm = null }
    if (!llm || typeof llm.listProviders !== 'function') {
      out.errors.push('宿主没有 llm 服务（拿不到模型列表）⇒ 可以手填 provider / model')
      modelsCache = { at: now, data: out }
      return { ok: true, ...out }
    }
    try {
      const list = llm.listProviders() || []
      for (const p of list) {
        const id = String(p?.id ?? p?.name ?? '')
        if (!id) continue
        const note = providerNote(id)
        const entry = { provider: id, name: String(p?.name || p?.description || id), models: [], usable: !note, note }
        const r = await withTimeout(llm.listModels(id), 6000)
        if (r && r.__error) entry.error = r.__error
        else if (Array.isArray(r)) entry.models = r.map((m) => ({ id: String(m.id), name: String(m.name || m.id) }))
        else entry.error = '6 秒内没拿到模型列表'
        out.providers.push(entry)
      }
    } catch (e) { out.errors.push(String(e?.message ?? e)) }
    modelsCache = { at: now, data: out }
    return { ok: true, ...out }
  }

  const status = () => {
    refreshCfg()
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    return {
      ok: true,
      home: stateDir,
      defaultHome: bootDir,          // ⭐ 默认地盘（设置页的「恢复默认」要用）
      homeCustom: stateDir !== bootDir,
      config: cfg,
      serviceOn: Boolean(cfg.serviceOn),   // ⭐ 总开关（侧栏那盏灯看的就是它）
      tripledToday: tripledCountOn(stateDir, dayKey()),   // ⭐ 今天成功三连了几条
      repliesPending: replyCache.data?.items?.length ?? null,   // ⭐ 待回复条数（宿主扫出来的）
      mentions: mentionsNow(),        // ⭐ 这一轮会 @ 的名单（多个）
      model: modelNow(),              // ⭐ 这一轮用哪个模型（null = 跟 profile 默认）
      windows: WINDOWS,
      today,
      ranToday: st.day === today ? Number(st.count || 0) : 0,   // 今天跑了几轮
      pickedToday: countPickedToday(),                          // 今天挑到几条（从报告里数）
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      loggedIn: hasCredential(),
      venvReady: venvReadyNow(),
      version: myVersion(),
      installFailed: !installing && !venvReadyNow() && (() => { try { return readFileSync(installLogFile, 'utf8').length > 0 } catch { return false } })(),
      installing,
      running: dutyRunning(),        // ⭐ 有一轮正在跑（设置页据此禁用「现在跑一轮」）
      runningSince: dutyRun.at || null,
      runningWhy: dutyRun.why || '',
      // ── 本地转写那一套的状态（设置页要显示进度）──
      asrReady: asrReadyNow(),
      // 模型下没下（免得界面写"就绪"、其实还得现下）
      asrModelReady: (() => { try { return existsSync(join(stateDir, '.hf-cache', 'hub')) } catch { return false } })(),
      asrInstalling: installingAsr,
      asrLog: asrLogFile,
      asrTail: (() => { try { return readFileSync(asrLogFile, 'utf8').slice(-1400) } catch { return '' } })(),
      installLog: installLogFile,
      // ⭐ 让设置页能显示"装到哪了"（陌生人原来只看到一句"后台在装" ✗）
      installTail: (() => { try { return readFileSync(installLogFile, 'utf8').slice(-1400) } catch { return '' } })(),
      report: join(outDir, `${today}.md`),
      log: logFile,
    }
  }

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-duty/status') return sendJson(res, 200, status())

    if (req.method === 'GET' && path === '/api/bili-duty/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: WINDOWS, home: stateDir, defaultHome: bootDir })
    }

    // ⭐ 换「地盘」：校验 → 搬家（默认搬，可不搬）→ 落配置（config.json 仍在 bootDir）
    //    ⚠️ 这是**会动文件**的操作，所以单开一个接口，不做成 /config 的隐式副作用
    if (req.method === 'POST' && path === '/api/bili-duty/home') {
      const body = await readBody(req)
      const r = await changeHome(body?.home, { migrate: body?.migrate !== false })
      log(`换家请求：${JSON.stringify(body || {})} ⇒ ${r.ok ? r.home : '被拒：' + r.error}`)
      return sendJson(res, 200, { ...r, defaultHome: bootDir, venvReady: venvReadyNow() })
    }

    if (req.method === 'GET' && path === '/api/bili-duty/models') {
      return sendJson(res, 200, await modelsCatalog())
    }

    /* ⭐ 收藏夹列表（2026-10-19 加）：给页面的「收藏到」下拉用
     *    缓存 60 秒 —— 别每开一次页面就去打一次 B站。 */
    /* ⭐ 待回复清单（2026-10-19）：宿主扫"最近 N 天自己发过的评论"下面的回复 + 打分。
     *    ?force=1 无视 60 秒缓存，立刻重扫。 */
    if (req.method === 'GET' && path === '/api/bili-duty/replies') {
      try {
        const data = await replyShortlist(req.url.includes('force=1'))
        return sendJson(res, 200, { ok: true, ...data, minScore: Number(cfg.replyMinScore) || 0, days: Number(cfg.replyLookbackDays) || 7 })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), items: [] })
      }
    }

    if (req.method === 'GET' && path === '/api/bili-duty/favorites') {
      const now2 = Date.now()
      if (favCache.data && now2 - favCache.at < 60_000) return sendJson(res, 200, { ok: true, cached: true, ...favCache.data })
      try {
        const r = await call('bili_fav_folders', {})
        const obj = (typeof r === 'string') ? JSON.parse(r) : r
        const data = { folders: Array.isArray(obj?.folders) ? obj.folders : [], error: obj?.ok === false ? String(obj?.error || '') : '' }
        if (obj?.ok !== false) favCache = { at: now2, data }
        return sendJson(res, 200, { ok: obj?.ok !== false, ...data, error: data.error })
      } catch (e) {
        return sendJson(res, 200, { ok: false, folders: [], error: String(e?.message ?? e) })
      }
    }

    /* ⭐ 实时日志（2026-10-19 加）：给页面底部那块「实时日志」用
     *   ?lines=300（默认 300，20–1000）
     *   只回**尾部**：日志可能有几十万字符，全丢给浏览器没必要（rotateLogIfBig 会滚动截断）
     */
    if (req.method === 'GET' && path === '/api/bili-duty/log') {
      const n = Math.max(20, Math.min(Number(url.searchParams.get('lines')) || 300, 1000))
      try {
        const raw = readFileSync(logFile, 'utf8')
        const MAXC = 160_000
        const cut = raw.length > MAXC
        const tail = cut ? raw.slice(-MAXC) : raw
        const all = tail.split(/\r?\n/)
        // ⚠️ 截断点可能切在行中间 ⇒ 丢掉第一行（半截）；顺手去掉尾部空行（不然日志块底下空一大条）
        let lines = all.slice(Math.max(0, all.length - n))
        if (cut) lines = lines.slice(1)
        while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop()
        let mtime = 0
        try { mtime = statSync(logFile).mtimeMs } catch { /* 读不到就算了 */ }
        return sendJson(res, 200, {
          ok: true, path: logFile, lines, text: lines.join('\n'),
          total: raw.length, truncated: raw.length > MAXC, mtime,
          running: dutyRunning(), at: Date.now(),
        })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), path: logFile, text: '', lines: [], total: 0, running: dutyRunning(), at: Date.now() })
      }
    }

    if (req.method === 'POST' && path === '/api/bili-duty/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of ['serviceOn', 'tripleOn', 'tripleCoin', 'triplePerDay', 'tripleFavMediaId', 'tripleSay', 'perDay', 'perRound', 'peakValley', 'noon', 'night', 'autoComment', 'transcribe', 'asrModel',
        'commentPerRound', 'mentionName', 'mentionNames', 'dmMode', 'dmUid',
        'keywords', 'pythonPath', 'dshBin', 'headlessProfile', 'workspace', 'reportLevel', 'replyToComments', 'replyPerRound', 'replyLookbackDays', 'replyMinScore', 'funOnly', 'funTagsAllow', 'funTagsBlock',
        'modelProvider', 'modelName',
        'home']) {
        if (k in body) patch[k] = body[k]
      }
      // ⭐ 范围钳制 + 两份都写（config.json / DSH 原生设置页），统一走 persistCfg —— 见文件上方
      // ⭐ 私信那两个字段的合法值（2026-10-17 摘 PR #9；其余范围钳制统一在 persistCfg 里）
      if ('dmMode' in patch) patch.dmMode = ['off', 'only', 'both'].includes(String(patch.dmMode)) ? String(patch.dmMode) : 'off'
      if ('dmUid' in patch) patch.dmUid = Math.max(0, Math.min(Number(patch.dmUid) || 0, Number.MAX_SAFE_INTEGER))
      // ⭐ home 出现在这里就走 changeHome（要建目录 / 可能要搬家），不裸写配置
      if ('home' in patch) {
        const r = await changeHome(patch.home, { migrate: body?.migrate !== false })
        delete patch.home
        if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error, home: stateDir, config: cfg })
        const rest = Object.keys(patch).length ? await persistCfg(patch) : { clean: {}, host: r.host }
        return sendJson(res, 200, { ok: true, config: cfg, host: rest.host, home: stateDir, homeNote: r.note, copied: r.copied })
      }
      const { clean, host } = await persistCfg(patch)
      log(`设置已更新：${JSON.stringify(clean)}（DSH 那边${host.ok ? '已同步' : '没写成：' + host.error}）`)
      return sendJson(res, 200, { ok: true, config: cfg, host })
    }

    if (req.method === 'POST' && path === '/api/bili-duty/run') {
      return sendJson(res, 200, { ok: true, ...(await runDuty('manual')) })
    }

    // 建 venv + 装依赖（**不等它**：几分钟的活，进度写 install.log）
    if (req.method === 'POST' && path === '/api/bili-duty/install') {
      return sendJson(res, 200, runInstall())
    }

    // 装"本地转写"那套（独立环境：faster-whisper + yt-dlp + Whisper 模型）
    if (req.method === 'POST' && path === '/api/bili-duty/install-asr') {
      return sendJson(res, 200, runAsrInstall())
    }

    // ⭐ 「复核评论」：拿判重表里最近的记录，去 B站 核一遍到底公开可见没有
    //    （设置页那个按钮、以及每轮结束 90 秒后自动跑一次，都走这里）
    if (req.method === 'POST' && path === '/api/bili-duty/verify') return sendJson(res, 200, await runVerify('manual'))

    // 「看今天的报告」：把报告的文本读出来给设置页显示（浏览器不能直接开本地文件 ✗）
    if (req.method === 'GET' && path === '/api/bili-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 200000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }

    // 「打开文件夹」：浏览器开不了本地目录 ⇒ 让宿主去开（只认 out / home 两个，别的不受理）
    if (req.method === 'POST' && path === '/api/bili-duty/open') {
      const body = await readBody(req)
      const dir = String(body?.what || 'out') === 'home' ? stateDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      // ⭐ 三种方式依次试（PATH 不全时 explorer.exe 会找不到 ✗；spawn 的失败是**异步**的，
      //    try/catch 抓不到 ⇒ 必须挂 'error' 监听，否则会升级成未捕获异常）
      // ⭐ 顺序很重要：把**最可能真的弹出窗口**的放第一（cmd start 走 shell 的 ShellExecute ✓）
      //    并且**不要再传 windowsHide**（2026-10-15 实测：传了以后"成功"但窗口不出现 ✗）
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
        ['powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath '" + dir.replace(/'/g, "''") + "'"]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) { log('打开文件夹：用了 ' + cmd + '（没报错；窗口不一定真弹出来了）'); return sendJson(res, 200, { ok: true, opened: dir, via: cmd }) }
        lastErr = err
        log('打开文件夹失败（' + cmd + '）：' + err)
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }

    // 「一键升级」：点了它自己跑 add（⚠️ 之后要重启才生效）
    if (req.method === 'POST' && path === '/api/bili-duty/upgrade') return sendJson(res, 200, runUpgrade())

    // 「检查更新」：⚠️ 只在用户点按钮时才联网（不偷偷发请求 ✓），结果缓存一天 ✓
    /* ⭐ 两条源都问（合并上游 0.1.12）：
     *   先 npm（不依赖加速器、快），再 GitHub（读 raw 上的 package.json）；
     *   谁给的版本号更新就用谁 ⇒ 返回里带 source。
     *   起因：npm 账号被暂停过，线上 latest 停在旧版，只问 npm 会让"检查更新"永远说"已是最新"。
     *   GitHub 不通时**静默跳过**，不打扰用户。 */
    if (req.method === 'GET' && path === '/api/bili-duty/update') {
      const out = { ok: true, current: myVersion(), latest: '', hasNew: false, source: '', page: 'https://www.npmjs.com/package/dsh-bili-scroll' }
      const vnum = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0)
      const cmp = (a, b) => {
        const x = vnum(a), y = vnum(b)
        for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0) }
        return 0
      }
      const withTimeout = async (fn, ms) => {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), ms)
        try { return await fn(ctrl.signal) } finally { clearTimeout(timer) }
      }
      try {
        if (updateCache && Date.now() - updateCache.at < 24 * 3600 * 1000) {
          out.latest = updateCache.latest
          out.source = updateCache.source || ''
        } else {
          const found = []
          // ① npm
          try {
            const v = await withTimeout(async (signal) => {
              const r = await fetch('https://registry.npmjs.org/dsh-bili-scroll/latest', { signal })
              const j = await r.json()
              return String(j.version || '')
            }, 8000)
            if (v) found.push({ v, source: 'npm' })
          } catch { /* npm 不通就跳过 */ }
          // ② GitHub（raw 上的 package.json）—— 仓库地址从 package.json 的 repository 里读
          try {
            let slug = 'FunnyMudXD/dsh-bili-scroll'
            try {
              const pkg = readJson(join(pluginDir, 'package.json'), {})
              const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(String(pkg?.repository?.url || pkg?.homepage || ''))
              if (m) slug = m[1]
            } catch { /* 读不到就用默认 */ }
            const v = await withTimeout(async (signal) => {
              const r = await fetch(`https://raw.githubusercontent.com/${slug}/main/package.json`, { signal, headers: { 'User-Agent': 'dsh-bili-scroll' } })
              const j = await r.json()
              return String(j.version || '')
            }, 8000)
            if (v) found.push({ v, source: 'github' })
          } catch { /* GitHub 不通就静默跳过 */ }
          if (!found.length) { out.ok = false; out.error = 'npm 与 GitHub 都没问出来（可能都没网）'; return sendJson(res, 200, out) }
          found.sort((a, b) => cmp(b.v, a.v))
          out.latest = found[0].v
          out.source = found[0].source
          if (out.source === 'github') out.page = `https://github.com/FunnyMudXD/dsh-bili-scroll`
          updateCache = { at: Date.now(), latest: out.latest, source: out.source }
        }
      } catch (e) { out.ok = false; out.error = String(e?.message ?? e); return sendJson(res, 200, out) }
      // ⭐ 要比谁更新，不能只比不相等 —— 否则本地版本高于线上时会误报有新版
      out.hasNew = Boolean(out.latest) && cmp(out.latest, out.current) > 0
      return sendJson(res, 200, out)
    }

    // 「测一下」：真跑一次，回答"能不能用"
    if (req.method === 'POST' && path === '/api/bili-duty/check') {
      return sendJson(res, 200, await checkUp())
    }

    // ── 扫码登录（设置页用）──
    if (req.method === 'POST' && path === '/api/bili-duty/login/start') {
      const { key, url } = await loginStart()
      const r = await renderQr({ url, stateDir, pythonCandidates: pythonCandidates(), log })
      // ⭐ 拿不到二维码时把**真实原因**带回界面（原来只有一句"venv 里大概还没有 qrcode"，把人带沟里）
      log(`出码：${url}${r.png ? `（${r.via}）` : `（画不出来：${r.errors.join('；')}）`}`)
      return sendJson(res, 200, r.png
        ? { ok: true, key, url, qr: r.dataUrl, via: r.via }
        : { ok: false, key, url, qr: null, error: '二维码没画出来：' + r.errors.join('；'), errors: r.errors })
    }

    if (req.method === 'POST' && path === '/api/bili-duty/login/poll') {
      const body = await readBody(req)
      const r = await loginPoll(String(body.key || ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return sendJson(res, 200, { ok: true, state: 'ok', file })
      }
      return sendJson(res, 200, { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-duty: /api/bili-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'bili-duty: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，python=${cfg.pythonPath}，峰谷=${cfg.peakValley ? '开' : '关'}）`)
}
