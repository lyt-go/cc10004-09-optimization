import { ROI_RULE_VERSION, roundHalfUp } from './roi'

/**
 * ROI 数值缓存：独立于业务数据的 localStorage 命名空间，只放「输入指纹 + 算好的数值」。
 *
 * 设计要点：
 * - 缓存按「核算身份 → 输入指纹」两级存：同一身份下不同输入各是一份 variant，
 *   某份报告的收入 / 点击 / 曝光变化只会让它自己重算，同身份其他未变化的报告继续命中。
 * - 缓存不是事实来源：报告状态、确认人和确认时间始终存在业务数据里，缓存只加速数值复用。
 * - 命中要求 核算身份 + 输入指纹 + 口径版本 三者一致；任何一项变化都按未命中处理。
 * - 每次读取都直接读 localStorage，不做模块级内存兜底：缓存不可用时宁可重算，也不返回旧值。
 */

export const ROI_CACHE_KEY = 'data-product-ops:roi-cache'
export const ROI_CACHE_SCHEMA_VERSION = 4

export type RoiCacheVariant = {
  fingerprint: string
  ruleVersion: string
  computedAt: string
  roi: number
  cpc: number
  cpm: number
  sourceReportId: number
  sourceReportNo: string
  reportNumbers: string[]
}

export type RoiCacheEntry = {
  identity: string
  variants: Record<string, RoiCacheVariant>
}

export type RoiCacheState = {
  schemaVersion: number
  entries: Record<string, RoiCacheEntry>
}

export type RoiCacheLoad =
  | { available: true; state: RoiCacheState; reason?: string }
  | { available: false; state: RoiCacheState; reason: string }

function emptyState(): RoiCacheState {
  return { schemaVersion: ROI_CACHE_SCHEMA_VERSION, entries: {} }
}

function storage(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

let simulatedDown = false

/** 演示 / 自测用：模拟浏览器缓存不可用，验证会回落到真实计算。 */
export function setRoiCacheSimulatedDown(value: boolean): void {
  simulatedDown = value
}

export function isRoiCacheSimulatedDown(): boolean {
  return simulatedDown
}

function probe(target: Storage): boolean {
  const key = `${ROI_CACHE_KEY}:probe`
  try {
    target.setItem(key, '1')
    const read = target.getItem(key)
    target.removeItem(key)
    return read === '1'
  } catch {
    return false
  }
}

export function isRoiCacheAvailable(): boolean {
  if (simulatedDown) {
    return false
  }
  const target = storage()
  return target !== null && probe(target)
}

export function loadRoiCache(): RoiCacheLoad {
  if (!isRoiCacheAvailable()) {
    return {
      available: false,
      state: emptyState(),
      reason: simulatedDown ? '核算缓存已被手动停用' : '浏览器本地核算缓存不可用',
    }
  }
  const target = storage() as Storage
  const raw = target.getItem(ROI_CACHE_KEY)
  if (!raw) {
    return { available: true, state: emptyState() }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RoiCacheState>
    if (
      !parsed ||
      parsed.schemaVersion !== ROI_CACHE_SCHEMA_VERSION ||
      typeof parsed.entries !== 'object' ||
      parsed.entries === null
    ) {
      return {
        available: false,
        state: emptyState(),
        reason: '核算缓存结构已损坏，按不可用处理并回落到真实计算',
      }
    }
    return {
      available: true,
      state: {
        schemaVersion: ROI_CACHE_SCHEMA_VERSION,
        entries: parsed.entries as Record<string, RoiCacheEntry>,
      },
    }
  } catch {
    return {
      available: false,
      state: emptyState(),
      reason: '核算缓存无法解析，按不可用处理并回落到真实计算',
    }
  }
}

function persist(state: RoiCacheState): boolean {
  if (!isRoiCacheAvailable()) {
    return false
  }
  try {
    storage()?.setItem(ROI_CACHE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export type CacheLookup =
  | { hit: true; entry: RoiCacheVariant }
  | { hit: false; reason: string; cacheAvailable: boolean }

export function getCachedResult(identity: string, fingerprint: string): CacheLookup {
  const loaded = loadRoiCache()
  if (!loaded.available) {
    return { hit: false, reason: loaded.reason, cacheAvailable: false }
  }
  const entry = loaded.state.entries[identity]
  if (!entry) {
    return { hit: false, reason: '同核算身份下还没有缓存', cacheAvailable: true }
  }
  const variant = entry.variants[fingerprint]
  if (!variant) {
    return { hit: false, reason: '同核算身份下没有该输入组合的缓存', cacheAvailable: true }
  }
  if (variant.ruleVersion !== ROI_RULE_VERSION) {
    return { hit: false, reason: '核算口径版本已升级', cacheAvailable: true }
  }
  if (![variant.roi, variant.cpc, variant.cpm].every((value) => Number.isFinite(value))) {
    return { hit: false, reason: '缓存数值不完整', cacheAvailable: true }
  }
  return { hit: true, entry: variant }
}

export function writeCachedResult(params: {
  identity: string
  fingerprint: string
  roi: number
  cpc: number
  cpm: number
  sourceReportId: number
  sourceReportNo: string
  reportNumbers?: string[]
  computedAt?: string
}): { stored: boolean; reason?: string } {
  const loaded = loadRoiCache()
  if (!loaded.available) {
    return { stored: false, reason: loaded.reason }
  }
  const existing = loaded.state.entries[params.identity]
  const variant: RoiCacheVariant = {
    fingerprint: params.fingerprint,
    ruleVersion: ROI_RULE_VERSION,
    computedAt: params.computedAt ?? new Date().toISOString(),
    roi: roundHalfUp(params.roi, 4),
    cpc: roundHalfUp(params.cpc, 2),
    cpm: roundHalfUp(params.cpm, 2),
    sourceReportId: params.sourceReportId,
    sourceReportNo: params.sourceReportNo,
    reportNumbers: params.reportNumbers ?? [params.sourceReportNo],
  }
  const entry: RoiCacheEntry = {
    identity: params.identity,
    variants: { ...(existing?.variants ?? {}), [params.fingerprint]: variant },
  }
  const state: RoiCacheState = {
    ...loaded.state,
    entries: { ...loaded.state.entries, [params.identity]: entry },
  }
  if (!persist(state)) {
    return { stored: false, reason: '核算缓存写入失败，下次将回落到真实计算' }
  }
  return { stored: true }
}

/** 身份或输入变化后清掉该身份的整组缓存，确保不会有人捡到旧变体。 */
export function invalidateCachedResult(identity: string): boolean {
  const loaded = loadRoiCache()
  if (!loaded.available) {
    return false
  }
  if (!loaded.state.entries[identity]) {
    return true
  }
  const entries = { ...loaded.state.entries }
  delete entries[identity]
  return persist({ ...loaded.state, entries })
}

export function clearRoiCache(): void {
  const target = storage()
  try {
    target?.removeItem(ROI_CACHE_KEY)
  } catch {
    // 清不掉也不影响重算，读取方会按不可用处理。
  }
}
