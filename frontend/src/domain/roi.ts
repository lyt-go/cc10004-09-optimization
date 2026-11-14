import type { EntryRow } from '@/data/types'

/**
 * ROI 核算的纯计算层：身份归一化、数值精度、活动结束窗口与完整校验都在这里。
 *
 * 约定：
 * - 投入金额按「分」做整数归一化，身份里不会出现 1250 / 1250.0 / 1,250 三种写法。
 * - ROI 保留 4 位小数，CPC / CPM 保留 2 位小数，全部四舍五入。
 * - 评估周期统一成闭区间 YYYY-MM-DD~YYYY-MM-DD（含首尾两天）。
 * - 活动结束窗口 = 活动结束日期 + 7 个自然日（结算与归因回补窗口）。
 */

export const ROI_RULE_VERSION = 'roi-rule-v2'
export const ROI_SETTLEMENT_DAYS = 7
export const ROI_META_FIELD = '核算元数据'
export const ROI_BATCH_FIELD = '核算批次'
export const ROI_IDENTITY_FIELD = '核算身份'

export type RoiComputed = {
  roi: number
  cpc: number
  cpm: number
}

export type RoiActivityWindow = {
  activityStart: string
  activityEnd: string
  windowEnd: string
  label: string
}

export type RoiPeriod = {
  start: string
  end: string
  canonical: string
  days: number
}

export type RoiInput = {
  activity: string
  investmentCents: number
  revenueCents: number
  clicks: number
  impressions: number
  period: RoiPeriod
  window: RoiActivityWindow | null
  activityNo: string
  activityName: string
}

export type RoiConfirmValidation = {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** 写进报告的核算元数据：确认人 / 确认时间属于每份报告自己，不跟着缓存走。 */
export type RoiMeta = {
  identity: string
  ruleVersion: string
  fingerprint: string
  computedAt: string
  computedBy: string
  roi: number
  cpc: number
  cpm: number
  investmentCents: number
  revenueCents: number
  clicks: number
  impressions: number
  periodStart: string
  periodEnd: string
  periodDays: number
  activityWindow: string
  activityEnd: string
  batchId: string
  cacheStatus: 'hit' | 'miss' | 'unavailable'
  reuseFromReportNo?: string
  confirmedBy?: string
  confirmedAt?: string
  archivedBy?: string
  archivedAt?: string
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function roundHalfUp(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN
  }
  const factor = 10 ** digits
  const sign = value < 0 ? -1 : 1
  return (sign * Math.round(Math.abs(value) * factor + Number.EPSILON)) / factor
}

export function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return '—'
  }
  return roundHalfUp(value, digits).toFixed(digits)
}

export function parseAmountToCents(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const raw = value.trim().replace(/[¥￥,，\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null
}

export function centsToAmount(cents: number): number {
  return roundHalfUp(cents / 100, 2)
}

export function normalizeActivity(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function normalizeDate(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(/[./]/g, '-')
  const parts = DATE_PATTERN.exec(text)
  if (!parts) {
    return null
  }
  const y = Number(parts[1])
  const m = Number(parts[2])
  const d = Number(parts[3])
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null
  }
  return `${parts[1]}-${pad2(m)}-${pad2(d)}`
}

function toUtcMs(value: string): number | null {
  const parts = DATE_PATTERN.exec(value)
  if (!parts) {
    return null
  }
  return Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
}

function dateFromUtcMs(ms: number): string {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** 评估周期：接受 2026-09-01~2026-09-30、2026-09-01 至 2026-09-30、2026/09/01-2026/09/30、单日日期。 */
export function parsePeriod(value: unknown): RoiPeriod | null {
  const text = String(value ?? '').trim()
  if (!text) {
    return null
  }
  // 先把 / 和 . 统一成 -，再按日期出现顺序取值：日期本身带 -，不能拿 - 当区间分隔符切分。
  const normalized = text.replace(/[./]/g, '-')
  const matches = normalized.match(/\d{4}-\d{1,2}-\d{1,2}/g)
  if (!matches || matches.length === 0 || matches.length > 2) {
    return null
  }
  // 去掉日期后只允许剩下区间分隔符；其它字符说明是「2026-09-01~2026-09-30abc」这类脏输入。
  const leftover = normalized
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, '')
    .replace(/[~～至到—\-\s]/g, '')
  if (leftover !== '') {
    return null
  }
  const start = normalizeDate(matches[0])
  const end = normalizeDate(matches[matches.length - 1])
  if (!start || !end) {
    return null
  }
  const startMs = toUtcMs(start) as number
  const endMs = toUtcMs(end) as number
  if (endMs < startMs) {
    return null
  }
  const days = Math.round((endMs - startMs) / DAY_MS) + 1
  return { start, end, canonical: `${start}~${end}`, days }
}

/** 活动结束窗口：结束日 + 7 天；活动没登记结束日时返回 null，校验时降级为评估周期。 */
export function buildActivityWindow(activity?: EntryRow | null): RoiActivityWindow | null {
  if (!activity) {
    return null
  }
  const start = normalizeDate(activity['开始日期'])
  const end = normalizeDate(activity['结束日期'])
  if (!end) {
    return null
  }
  const endMs = toUtcMs(end) as number
  const windowEnd = dateFromUtcMs(endMs + ROI_SETTLEMENT_DAYS * DAY_MS)
  return {
    activityStart: start ?? end,
    activityEnd: end,
    windowEnd,
    label: `${start ?? end}~${windowEnd}`,
  }
}

export type ActivityLookup = (row: EntryRow) => EntryRow | null

/** 从报告行提取核算身份：活动 + 投入金额 + 评估周期。 */
export function readInput(row: EntryRow, lookup?: ActivityLookup): { ok: true; input: RoiInput } | { ok: false; error: string } {
  const rawActivity = String(row['关联活动'] ?? '').trim()
  const activity = normalizeActivity(rawActivity)
  if (!activity) {
    return { ok: false, error: '缺少关联活动，无法形成核算身份' }
  }
  const investmentCents = parseAmountToCents(row['投入金额'])
  if (investmentCents === null || investmentCents < 0) {
    return { ok: false, error: '投入金额缺失或不是合法金额' }
  }
  const period = parsePeriod(row['评估周期'])
  if (!period) {
    return { ok: false, error: '评估周期缺失或格式不合法（应为 YYYY-MM-DD~YYYY-MM-DD）' }
  }
  const revenueCents = parseAmountToCents(row['转化收入'])
  if (revenueCents === null || revenueCents < 0) {
    return { ok: false, error: '转化收入缺失或不是合法金额' }
  }
  const clicks = toNonNegativeInt(row['点击量'])
  if (clicks === null) {
    return { ok: false, error: '点击量缺失或不是合法非负整数' }
  }
  const impressions = toNonNegativeInt(row['曝光量'])
  if (impressions === null) {
    return { ok: false, error: '曝光量缺失或不是合法非负整数' }
  }
  const matched = lookup ? lookup(row) : null
  return {
    ok: true,
    input: {
      activity,
      investmentCents,
      revenueCents,
      clicks,
      impressions,
      period,
      window: buildActivityWindow(matched),
      activityNo: String(matched?.['活动编号'] ?? rawActivity),
      activityName: String(matched?.['活动名称'] ?? rawActivity),
    },
  }
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && Number.isInteger(value) ? value : null
  }
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  return Number(text)
}

export function buildIdentity(input: RoiInput): string {
  return [input.activity, input.investmentCents, input.period.canonical].join('|')
}

export function identityLabel(input: RoiInput): string {
  return `${input.activityNo} · ${input.investmentCents / 100} 元 · ${input.period.canonical}`
}

/** 输入指纹：身份之外的收入 / 点击 / 曝光 / 窗口也参与，任何一项变化都要重算。 */
export function buildFingerprint(input: RoiInput): string {
  return [
    buildIdentity(input),
    input.revenueCents,
    input.clicks,
    input.impressions,
    input.window?.windowEnd ?? '-',
  ].join('|')
}

export function computeRoi(input: RoiInput): RoiComputed {
  const roi = input.investmentCents > 0 ? (input.revenueCents / input.investmentCents) * 100 : 0
  const cpc = input.clicks > 0 ? input.investmentCents / 100 / input.clicks : 0
  const cpm = input.impressions > 0 ? (input.investmentCents / 100 / input.impressions) * 1000 : 0
  return {
    roi: roundHalfUp(roi, 4),
    cpc: roundHalfUp(cpc, 2),
    cpm: roundHalfUp(cpm, 2),
  }
}

/** 确认前的完整校验：输入自洽、窗口覆盖评估周期、数值可计算，并对照提交时的快照防篡改。 */
export function validateForConfirm(row: EntryRow, input: RoiInput, meta: RoiMeta | null, computed: RoiComputed): RoiConfirmValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (input.investmentCents <= 0) {
    errors.push('投入金额必须大于 0，不能计算 ROI')
  }
  if (input.clicks <= 0) {
    warnings.push('点击量为 0，CPC 按 0 展示')
  }
  if (input.impressions <= 0) {
    warnings.push('曝光量为 0，CPM 按 0 展示')
  }
  if (![computed.roi, computed.cpc, computed.cpm].every((value) => Number.isFinite(value)) || computed.roi < 0) {
    errors.push('核算结果不是合法的非负有限数值')
  }
  if (String(row['报告编号'] ?? '').trim() === '') {
    errors.push('缺少报告编号')
  }
  if (!meta) {
    errors.push('报告还没有完成核算，缺少核算元数据')
  } else {
    if (meta.ruleVersion !== ROI_RULE_VERSION) {
      errors.push('核算口径版本已升级，请先重新提交计算')
    }
    if (meta.identity !== buildIdentity(input) || meta.fingerprint !== buildFingerprint(input)) {
      errors.push('报告内容与核算时不一致，请先重新提交计算')
    }
    if (meta.activityWindow !== (input.window?.label ?? '未登记活动窗口')) {
      errors.push('活动结束窗口已变化，请先重新提交计算')
    }
  }
  if (input.window) {
    if (input.period.start < input.window.activityStart) {
      errors.push(`评估周期早于活动开始日期 ${input.window.activityStart}`)
    }
    if (input.period.end > input.window.windowEnd) {
      errors.push(`评估周期超过活动结束窗口（活动 ${input.window.activityEnd} 结束，最晚可核算至 ${input.window.windowEnd}）`)
    }
    if (input.period.end < input.window.activityEnd) {
      warnings.push(`评估周期在活动结束日 ${input.window.activityEnd} 之前结束，收入可能尚未回补完整`)
    }
  } else {
    warnings.push('活动未登记结束日期，按评估周期本身核算，未套用结束窗口')
  }
  return { ok: errors.length === 0, errors, warnings }
}

export function readMeta(row: EntryRow): RoiMeta | null {
  const raw = row[ROI_META_FIELD]
  if (typeof raw !== 'string' || !raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as RoiMeta
    return parsed && typeof parsed.identity === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function writeMeta(meta: RoiMeta): string {
  return JSON.stringify(meta)
}
