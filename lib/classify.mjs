/**
 * lib/classify.mjs —— 「这条视频是娱乐还是学习/技术」（2026-10-19 加）
 * ============================================================================
 * 用户要求：**只评论娱乐视频，不评论学习/技术型视频**。
 *   理由：技术区的观众是来学东西的，评论区塞一句"值得看"反而像机器人；
 *   娱乐区才是"有人真的看了、还愿意搭话"的场景。
 *
 * 判断顺序（**分区优先**，然后关键词；拿不准就放行）：
 *   ① 分区名命中「学习/技术」 ⇒ tech
 *   ② 分区名命中「娱乐」     ⇒ fun
 *   ③ 标题 + 标签里技术词多、娱乐词少 ⇒ tech；反过来 ⇒ fun
 *   ④ 两边都有 / 都没有 ⇒ unknown（**放行**，宁可放过不可错杀）
 *
 * ⚠️ 只做粗筛，不追求准确率；真正的内容判断还是那一轮自己在做。
 */

const TECH_T = [/^知识$/, /科技/, /校园学习/, /职业职场/, /科学科普/, /计算机/, /软件应用/, /^数码$/, /设计·创意/]
const FUN_T = [/搞笑/, /鬼畜/, /动画/, /^音乐$/, /^舞蹈$/, /^游戏$/, /^生活$/, /^美食$/, /^动物$/, /^娱乐$/, /^影视$/, /^电影$/, /^电视剧$/, /番剧/, /国创/, /^资讯$/]

const TECH_KW = /教程|教学|课程|科普|原理|源码|编程|代码|开发|部署|搭建|配置|调试|评测|实测|复盘|干货|学习|入门|讲解|解析|避坑|算法|架构|面试|考研|英语|数学|物理|化学|数据库|服务器|运维|命令行|插件开发|API|SDK|benchmark|参数|调优/i
const FUN_KW = /小剧场|整活|搞笑|沙雕|鬼畜|动画|PV|MV|剧情|短剧|猫|狗|萌|美食|做饭|唱歌|跳舞|游戏|玩梗|梗|可爱|整蛊|挑战|日常/i

/**
 * @param {{ tname?: string, title?: string, tags?: string[], allowTags?: string[], blockTags?: string[] }} v
 *   allowTags：**命中就放行**（哪怕分区是"知识"）—— 用户的"这些标签我要评论"
 *   blockTags：**命中就不评论**（哪怕分区是"动画"）—— 用户的"这些标签我不要"
 * @returns {{ kind: 'fun'|'tech'|'unknown', why: string[] }}
 */
export function classifyVideo({ tname = '', title = '', tags = [], allowTags = [], blockTags = [] } = {}) {
  const t = String(tname || '').trim()
  const tagList = (Array.isArray(tags) ? tags : []).map((x) => String(x).trim()).filter(Boolean)
  const blob = `${String(title || '')} ${tagList.join(' ')}`
  const why = []

  // ⭐ 用户自己定的标签规则最优先（2026-10-19 加）
  const hitTag = (rules) => {
    const list = (Array.isArray(rules) ? rules : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    if (!list.length) return ''
    for (const tag of tagList) {
      const low = tag.toLowerCase()
      if (list.some((r) => low.includes(r))) return tag
    }
    return ''
  }
  const allowHit = hitTag(allowTags)
  if (allowHit) {
    why.push(`标签「${allowHit}」在你的白名单里`)
    return { kind: 'fun', why }
  }
  const blockHit = hitTag(blockTags)
  if (blockHit) {
    why.push(`标签「${blockHit}」在你的黑名单里`)
    return { kind: 'tech', why }
  }

  if (t && TECH_T.some((r) => r.test(t))) {
    why.push(`分区「${t}」属于学习/技术`)
    return { kind: 'tech', why }
  }
  if (t && FUN_T.some((r) => r.test(t))) {
    why.push(`分区「${t}」属于娱乐`)
    return { kind: 'fun', why }
  }
  const tech = TECH_KW.test(blob)
  const fun = FUN_KW.test(blob)
  if (tech && !fun) { why.push('标题/标签像教程或技术内容'); return { kind: 'tech', why } }
  if (fun && !tech) { why.push('标题/标签像娱乐内容'); return { kind: 'fun', why } }
  if (tech && fun) { why.push('技术词和娱乐词都有 → 按娱乐放行（宁可放过）'); return { kind: 'fun', why } }
  return { kind: 'unknown', why: ['看不出类型 → 放行'] }
}

/** 给人看的一行说明（日志 / 提示词里用） */
export function kindLabel(kind) {
  return kind === 'tech' ? '学习/技术型' : kind === 'fun' ? '娱乐型' : '没看出来'
}
