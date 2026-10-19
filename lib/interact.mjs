/**
 * lib/interact.mjs —— 「三连」的记账（2026-10-19 加）
 * ============================================================================
 * 为什么单独一份文件：三连是**花硬币**的动作，B站 也最容易把"批量三连"判成刷量。
 * 所以它必须有：① 有没有三连过（同一视频只花一次钱）② 今天花了几枚（日上限）
 * ③ 失败原因留证据（报告里要写清"哪一项没成"）。
 * 状态放在 `<家>/interacted.jsonl`，一行一条，append-only（坏了也只坏一行）。
 */

import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function interactedFile(stateDir) {
  return join(stateDir, 'interacted.jsonl')
}

/** 读全部记录（坏行跳过，绝不让一行烂数据搞挂整轮） */
export function readInteracted(stateDir) {
  const f = interactedFile(stateDir)
  if (!existsSync(f)) return []
  const out = []
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const row = JSON.parse(s)
      if (row && typeof row === 'object') out.push(row)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 追加一条记录（写不进去也不抛 —— 记账失败不该毁掉这一轮） */
export function appendInteracted(stateDir, row) {
  try {
    appendFileSync(interactedFile(stateDir), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 今天成功三连了几条（按 `day` 字段数，只数 ok） */
export function tripledCountOn(stateDir, day) {
  return readInteracted(stateDir).filter((r) => r.day === day && r.ok === true).length
}

/**
 * 这个视频之前三连过吗？
 * ⚠️ 只认**成功**的那次：失败过的要允许重试（比如当时硬币不足，补币后应该能成）。
 */
export function findTripled(stateDir, bvid) {
  const bv = String(bvid || '').trim().toLowerCase()
  if (!bv) return null
  for (const r of readInteracted(stateDir)) {
    if (String(r.bvid || '').toLowerCase() === bv && r.ok === true) return r
  }
  return null
}
