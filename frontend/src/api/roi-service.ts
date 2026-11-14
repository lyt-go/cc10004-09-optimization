import { filterRows } from './local-service'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ROI_RULE_VERSION,
  buildFingerprint,
  buildIdentity,
  centsToAmount,
  computeRoi,
  formatNumber,
  identityLabel,
  normalizeActivity,
  parseAmountToCents,
  parsePeriod,
  readInput,
  readMeta,
  validateForConfirm,
  writeMeta,
  type RoiComputed,
  type RoiInput,
  type RoiMeta,
} from '@/domain/roi'
import {
  getCachedResult,
  isRoiCacheSimulatedDown,
  loadRoiCache,
  setRoiCacheSimulatedDown,
  writeCachedResult,
} from '@/domain/roi-cache'
import {
  allocateCompletionSeq,
  appendBatch,
  clearWorkLog,
  findEarlierWinner,
  loadWorkState,
  markStaleRunningBatches,
  nextBatchId,
  updateBatch,
  type RoiBatch,
} from '@/domain/roi-work'
import type { EntryRow } from '@/data/types'

/**
 * ROI 核算的业务编排。
 *
 * 核算身份 = 活动 + 投入金额 + 评估周期；身份相同的报告共享「数值缓存」，但各自的
 * 状态、确认人、确认时间、归档状态始终只写在自己那一行上，互不代劳。
 */

export const ROI_STATUS = {
  draft: '草稿',
  computing: '计算中',
  calculated: '已计算',
  stale: '待重算',
  interrupted: '计算中断',
  confirmed: '已确认',
  archived: '已归档',
} as const

const LOCKED_STATUSES = new Set<string>([ROI_STATUS.confirmed, ROI_STATUS.archived])
const CACHE_STATUS_LABEL: Record<RoiMeta['cacheStatus'], string> = {
  hit: '复用',
  miss: '本次计算',
  unavailable: '缓存不可用 · 真实计算',
}

export type RoiReportView = {
  id: number
  reportNo: string
  activity: string
  activityName: string
  investmentText: string
  revenueText: string
  clicksText: string
  impressionsText: string
  period: string
  roiText: string
  cpcText: string
  cpmText: string
  identity: string
  identityText: string
  numberSource: string
  liveCache: 'hit' | 'miss' | 'stale' | 'unavailable' | 'none'
  status: string
  confirmedBy: string
  confirmedAt: string
  archivedBy: string
  archivedAt: string
  errorText: string
  batchId: string
  sharedCount: number
  canSubmit: boolean
  canRecalculateIdentity: boolean
  canConfirm: boolean
  canArchive: boolean
  canRetry: boolean
}

export type RoiStat = { label: string; value: number; hint?: string }

export type RoiIdentityGroup = {
  identity: string
  label: string
  reportNos: string[]
  confirmedCount: number
  confirmedReportNos: string[]
}

export type RoiWorkspace = {
  items: RoiReportView[]
  total: number
  stats: RoiStat[]
  cache: { available: boolean; reason: string; simulatedDown: boolean }
  batches: RoiBatch[]
  identityGroups: RoiIdentityGroup[]
  interruptedBatches: RoiBatch[]
}

export type RoiActionTone = 'success' | 'conflict' | 'error' | 'warning' | 'info'

export type RoiActionResult = {
  ok: boolean
  tone: RoiActionTone
  message: string
  batchId?: string
  reportNo?: string
  details?: string[]
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 演示 / 自测用的故障注入：下一次提交计算时按失败处理。 */
let injectedFailure: string | null = null

export function injectRoiFailure(reason: string): RoiActionResult {
  injectedFailure = reason.trim() || '核算服务暂时不可用'
  return {
    ok: true,
    tone: 'warning',
    message: `已注入一次性故障「${injectedFailure}」：下一次提交计算会失败并保留可重试现场`,
  }
}

function reportNoOf(row: EntryRow): string {
  return String(row['报告编号'] ?? `#${row.id}`)
}

function statusOf(row: EntryRow): string {
  return String(row.status ?? ROI_STATUS.draft)
}

function formatTimestamp(value: unknown): string {
  const text = String(value ?? '')
  if (!text) {
    return '—'
  }
  const date = new Date(text)
  if (!Number.isFinite(date.getTime())) {
    return text
  }
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function activityLookupFactory(): (row: EntryRow) => EntryRow | null {
  const campaigns = listRows('campaign')
  const byCode = new Map<string, EntryRow>()
  const byName = new Map<string, EntryRow>()
  for (const campaign of campaigns) {
    const code = normalizeActivity(campaign['活动编号'])
    const name = normalizeActivity(campaign['活动名称'])
    if (code) {
      byCode.set(code, campaign)
    }
    if (name) {
      byName.set(name, campaign)
    }
  }
  return (row) => {
    const key = normalizeActivity(row['关联活动'])
    return byCode.get(key) ?? byName.get(key) ?? null
  }
}

function readRowInput(row: EntryRow, lookup: (row: EntryRow) => EntryRow | null) {
  return readInput(row, lookup)
}

/** 已确认集合：用作并发确认的「轮次基线」，基线相同的两次确认才可能互相冲突。 */
function confirmedBaseline(rows: EntryRow[], identity: string): number[] {
  return rows
    .filter((row) => {
      if (statusOf(row) !== ROI_STATUS.confirmed && statusOf(row) !== ROI_STATUS.archived) {
        return false
      }
      const meta = readMeta(row)
      return meta?.identity === identity && Boolean(meta.confirmedAt)
    })
    .map((row) => Number(row.id))
    .sort((a, b) => a - b)
}

function buildRowView(
  row: EntryRow,
  rows: EntryRow[],
  lookup: (row: EntryRow) => EntryRow | null,
): RoiReportView {
  const meta = readMeta(row)
  const inputResult = readRowInput(row, lookup)
  const input = inputResult.ok ? inputResult.input : null
  const status = statusOf(row)

  let identity = meta?.identity ?? ''
  let identityText = '身份未形成'
  let liveCache: RoiReportView['liveCache'] = 'none'
  if (input) {
    const currentIdentity = buildIdentity(input)
    const fingerprint = buildFingerprint(input)
    identity = currentIdentity
    identityText = identityLabel(input)
    if (!meta) {
      liveCache = 'none'
    } else if (meta.ruleVersion !== ROI_RULE_VERSION) {
      liveCache = 'stale'
    } else if (meta.identity !== currentIdentity || meta.fingerprint !== fingerprint) {
      liveCache = 'stale'
    } else {
      const cached = getCachedResult(currentIdentity, fingerprint)
      liveCache = cached.hit ? 'hit' : cached.cacheAvailable ? 'miss' : 'unavailable'
    }
  } else if (meta) {
    identity = meta.identity
    identityText = meta.identity
    liveCache = 'stale'
  }

  const sharedCount = identity
    ? rows.filter((item) => {
        const itemMeta = readMeta(item)
        if (itemMeta?.identity) {
          return itemMeta.identity === identity
        }
        const itemInput = readRowInput(item, lookup)
        return itemInput.ok && buildIdentity(itemInput.input) === identity
      }).length
    : 1

  const numberSource = meta
    ? liveCache === 'stale'
      ? '旧值 · 已失效'
      : meta.cacheStatus === 'hit'
      ? meta.reuseFromReportNo
        ? `复用 ${meta.reuseFromReportNo}`
        : '复用同身份缓存'
      : CACHE_STATUS_LABEL[meta.cacheStatus]
    : '未计算'

  const errorText = String(row['核算异常'] ?? '').trim()
  const displayStatus = status === ROI_STATUS.calculated && liveCache === 'stale' ? ROI_STATUS.stale : status

  return {
    id: Number(row.id),
    reportNo: reportNoOf(row),
    activity: String(row['关联活动'] ?? ''),
    activityName: String(input?.activityName ?? ''),
    investmentText: formatNumber(centsToAmount(parseAmountToCents(row['投入金额']) ?? 0), 2),
    revenueText: formatNumber(centsToAmount(parseAmountToCents(row['转化收入']) ?? 0), 2),
    clicksText: String(row['点击量'] ?? '—'),
    impressionsText: String(row['曝光量'] ?? '—'),
    period: String(row['评估周期'] ?? ''),
    // 待重算时旧数值一律带「旧值」后缀：避免运营拿旧 ROI 与新的回收报告直接对比。
    roiText: meta
      ? liveCache === 'stale'
        ? `${formatNumber(meta.roi, 4)}（旧值）`
        : formatNumber(meta.roi, 4)
      : String(row['ROI数值'] ?? '') || '—',
    cpcText: meta
      ? liveCache === 'stale'
        ? `${formatNumber(meta.cpc, 2)}（旧值）`
        : formatNumber(meta.cpc, 2)
      : String(row['CPC成本'] ?? '') || '—',
    cpmText: meta
      ? liveCache === 'stale'
        ? `${formatNumber(meta.cpm, 2)}（旧值）`
        : formatNumber(meta.cpm, 2)
      : String(row['CPM成本'] ?? '') || '—',
    identity,
    identityText,
    numberSource,
    liveCache,
    status: displayStatus,
    confirmedBy: String(row['确认人'] ?? meta?.confirmedBy ?? '') || '—',
    confirmedAt: formatTimestamp(row['确认时间'] ?? meta?.confirmedAt),
    archivedBy: String(row['归档人'] ?? meta?.archivedBy ?? '') || '—',
    archivedAt: formatTimestamp(row['归档时间'] ?? meta?.archivedAt),
    errorText,
    batchId: String(row['核算批次'] ?? '') || '—',
    sharedCount,
    canSubmit: status !== ROI_STATUS.computing && !LOCKED_STATUSES.has(status),
    canRecalculateIdentity: !LOCKED_STATUSES.has(status),
    canConfirm: status === ROI_STATUS.calculated && Boolean(meta) && liveCache !== 'stale',
    canArchive: status === ROI_STATUS.confirmed,
    canRetry: status === ROI_STATUS.interrupted,
  }
}

export function loadRoiWorkspace(filters: Record<string, string> = {}): RoiWorkspace {
  const rows = listRows('roi')
  const matched = filterRows(rows, filters)
  const lookup = activityLookupFactory()
  const items = matched.map((row) => buildRowView(row, rows, lookup))
  const cacheLoad = loadRoiCache()
  const work = loadWorkState()

  const groups = new Map<string, RoiIdentityGroup>()
  for (const row of rows) {
    const item = buildRowView(row, rows, lookup)
    if (!item.identity) {
      continue
    }
    const group = groups.get(item.identity) ?? {
      identity: item.identity,
      label: item.identityText,
      reportNos: [],
      confirmedCount: 0,
      confirmedReportNos: [],
    }
    group.reportNos.push(item.reportNo)
    if (statusOf(row) === ROI_STATUS.confirmed || statusOf(row) === ROI_STATUS.archived) {
      group.confirmedCount += 1
      group.confirmedReportNos.push(item.reportNo)
    }
    groups.set(item.identity, group)
  }

  const confirmed = rows.filter((row) => statusOf(row) === ROI_STATUS.confirmed).length
  const reused = rows.filter((row) => readMeta(row)?.cacheStatus === 'hit').length
  const interrupted = rows.filter((row) => statusOf(row) === ROI_STATUS.interrupted).length
  const stale = items.filter((item) => item.liveCache === 'stale').length

  const stats: RoiStat[] = [
    { label: '核算身份数', value: groups.size, hint: '活动 + 投入金额 + 评估周期' },
    { label: 'ROI报告总数', value: rows.length },
    { label: '已确认报告', value: confirmed },
    { label: '数值复用报告', value: reused, hint: '直接沿用同身份缓存数值' },
    { label: '待重试报告', value: interrupted + stale, hint: '中断或输入已变化' },
  ]

  return {
    items,
    total: matched.length,
    stats,
    cache: {
      available: cacheLoad.available,
      reason: cacheLoad.available ? '' : cacheLoad.reason,
      simulatedDown: isRoiCacheSimulatedDown(),
    },
    batches: work.state.batches.slice(0, 12),
    identityGroups: [...groups.values()],
    interruptedBatches: work.state.batches.filter((batch) => batch.status === 'interrupted'),
  }
}

function markRow(
  row: EntryRow,
  patch: Partial<RoiMeta>,
  computed: RoiComputed,
  params: { batchId: string; operator: string; cacheStatus: RoiMeta['cacheStatus']; reuseFromReportNo?: string },
): EntryRow {
  const meta: RoiMeta = {
    identity: String(patch.identity ?? ''),
    ruleVersion: ROI_RULE_VERSION,
    fingerprint: String(patch.fingerprint ?? ''),
    computedAt: patch.computedAt ?? nowIso(),
    computedBy: params.operator,
    roi: computed.roi,
    cpc: computed.cpc,
    cpm: computed.cpm,
    investmentCents: Number(patch.investmentCents ?? 0),
    revenueCents: Number(patch.revenueCents ?? 0),
    clicks: Number(patch.clicks ?? 0),
    impressions: Number(patch.impressions ?? 0),
    periodStart: String(patch.periodStart ?? ''),
    periodEnd: String(patch.periodEnd ?? ''),
    periodDays: Number(patch.periodDays ?? 0),
    activityWindow: String(patch.activityWindow ?? ''),
    activityEnd: String(patch.activityEnd ?? ''),
    batchId: params.batchId,
    cacheStatus: params.cacheStatus,
    reuseFromReportNo: params.reuseFromReportNo,
  }
  return {
    ...row,
    status: ROI_STATUS.calculated,
    pending: false,
    abnormal: false,
    'ROI数值': computed.roi,
    'CPC成本': computed.cpc,
    'CPM成本': computed.cpm,
    '核算身份': meta.identity,
    '核算元数据': writeMeta(meta),
    '核算批次': params.batchId,
    '核算异常': '',
  }
}

type ComputeOutcome =
  | { ok: true; row: EntryRow; reused: boolean; cacheStatus: RoiMeta['cacheStatus']; details: string[] }
  | { ok: false; row: EntryRow; error: string }

function computeOne(
  row: EntryRow,
  lookup: (item: EntryRow) => EntryRow | null,
  batchId: string,
  operator: string,
): ComputeOutcome {
  const inputResult = readRowInput(row, lookup)
  if (!inputResult.ok) {
    return {
      ok: false,
      row: {
        ...row,
        status: ROI_STATUS.interrupted,
        pending: true,
        abnormal: true,
        '核算批次': batchId,
        '核算异常': inputResult.error,
      },
      error: inputResult.error,
    }
  }
  const input = inputResult.input
  const identity = buildIdentity(input)
  const fingerprint = buildFingerprint(input)
  const cached = getCachedResult(identity, fingerprint)

  const details: string[] = []
  let computed: RoiComputed
  let cacheStatus: RoiMeta['cacheStatus']
  let reuseFromReportNo: string | undefined

  if (cached.hit) {
    computed = { roi: cached.entry.roi, cpc: cached.entry.cpc, cpm: cached.entry.cpm }
    cacheStatus = 'hit'
    reuseFromReportNo = cached.entry.sourceReportNo
    details.push(`复用 ${cached.entry.sourceReportNo} 的 ROI 数值（身份相同且输入未变化）`)
  } else {
    computed = computeRoi(input)
    if (cached.cacheAvailable) {
      cacheStatus = 'miss'
      const stored = writeCachedResult({
        identity,
        fingerprint,
        roi: computed.roi,
        cpc: computed.cpc,
        cpm: computed.cpm,
        sourceReportId: Number(row.id),
        sourceReportNo: reportNoOf(row),
        reportNumbers: [reportNoOf(row)],
      })
      if (!stored.stored) {
        cacheStatus = 'unavailable'
        details.push(stored.reason ?? '核算缓存写入失败，已按真实计算结果写入报告')
      } else {
        details.push(cached.reason === '没有同核算身份的缓存' ? '形成新的核算身份并写入数值缓存' : `缓存未命中：${cached.reason}，已重新计算`)
      }
    } else {
      cacheStatus = 'unavailable'
      // 缓存不可用时绝不读取旧值：本次一律用真实输入重算。
      details.push(`${cached.reason}，已回退到真实计算（未使用任何缓存数值）`)
    }
  }

  const metaPatch: Partial<RoiMeta> = {
    identity,
    fingerprint,
    computedAt: nowIso(),
    investmentCents: input.investmentCents,
    revenueCents: input.revenueCents,
    clicks: input.clicks,
    impressions: input.impressions,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    periodDays: input.period.days,
    activityWindow: input.window?.label ?? '未登记活动窗口',
    activityEnd: input.window?.activityEnd ?? '',
  }

  return {
    ok: true,
    row: markRow(row, metaPatch, computed, { batchId, operator, cacheStatus, reuseFromReportNo }),
    reused: cacheStatus === 'hit',
    cacheStatus,
    details,
  }
}

export function submitRoiCalculation(
  reportId: number,
  operator: string,
  scope: 'single' | 'identity' = 'single',
): RoiActionResult {
  const rows = listRows('roi')
  const target = rows.find((row) => Number(row.id) === reportId)
  if (!target) {
    return { ok: false, tone: 'error', message: `没有找到编号为 ${reportId} 的ROI报告` }
  }
  if (LOCKED_STATUSES.has(statusOf(target))) {
    return {
      ok: false,
      tone: 'error',
      message: `${reportNoOf(target)} 当前为「${statusOf(target)}」，确认状态不可被重算覆盖；如需重算请新建报告`,
    }
  }

  const lookup = activityLookupFactory()
  const targetInput = readRowInput(target, lookup)
  const targetIdentity = targetInput.ok ? buildIdentity(targetInput.input) : ''

  const affected =
    scope === 'identity' && targetIdentity
      ? rows.filter((row) => {
          if (LOCKED_STATUSES.has(statusOf(row))) {
            return false
          }
          const input = readRowInput(row, lookup)
          return input.ok && buildIdentity(input.input) === targetIdentity
        })
      : [target]

  const work = loadWorkState()
  const batchId = nextBatchId(work.state, scope === 'identity' ? 'R' : 'B')
  const batchStartedAt = nowIso()
  appendBatch({
    id: batchId,
    kind: scope === 'identity' ? 'recalculate' : 'calculate',
    identity: targetIdentity,
    identityLabel: targetInput.ok ? identityLabel(targetInput.input) : reportNoOf(target),
    reportIds: affected.map((row) => Number(row.id)),
    reportNos: affected.map(reportNoOf),
    operator,
    status: 'running',
    startedAt: batchStartedAt,
  })

  // 先把受影响报告标成计算中，哪怕后续被异常打断，恢复时也能看出是哪一批留下的现场。
  const computingRows = rows.map((row) =>
    affected.some((item) => Number(item.id) === Number(row.id))
      ? { ...row, status: ROI_STATUS.computing, pending: true, '核算批次': batchId, '核算异常': '' }
      : row,
  )
  saveRows('roi', computingRows)

  if (injectedFailure) {
    const reason = injectedFailure
    injectedFailure = null
    const failedRows = computingRows.map((row) =>
      affected.some((item) => Number(item.id) === Number(row.id))
        ? {
            ...row,
            status: ROI_STATUS.interrupted,
            pending: true,
            abnormal: true,
            '核算异常': `${reason}；本次未产生任何数值，可直接重试`,
          }
        : row,
    )
    saveRows('roi', failedRows)
    updateBatch(batchId, (batch) => ({
      ...batch,
      status: 'failed',
      finishedAt: nowIso(),
      affectedCount: affected.length,
      error: reason,
    }))
    return {
      ok: false,
      tone: 'error',
      message: `核算失败：${reason}；已保留可重试现场，重试时会重新执行完整核算`,
      batchId,
      details: affected.map((row) => `${reportNoOf(row)}：${reason}`),
    }
  }

  const nextRows = [...computingRows]
  const details: string[] = []
  let successCount = 0
  let reusedCount = 0
  let changedCount = 0
  let failureCount = 0

  for (const candidate of affected) {
    const index = nextRows.findIndex((row) => Number(row.id) === Number(candidate.id))
    const outcome = computeOne(nextRows[index], lookup, batchId, operator)
    nextRows[index] = outcome.row
    if (outcome.ok) {
      successCount += 1
      if (outcome.reused) {
        reusedCount += 1
      } else {
        changedCount += 1
      }
      details.push(`${reportNoOf(candidate)}：${outcome.details.join('；') || '核算完成'}`)
    } else {
      failureCount += 1
      details.push(`${reportNoOf(candidate)}：${outcome.error}`)
    }
  }
  saveRows('roi', nextRows)

  const lockedSkipped =
    scope === 'identity'
      ? rows.filter(
          (row) =>
            LOCKED_STATUSES.has(statusOf(row)) &&
            readMeta(row)?.identity === targetIdentity,
        )
      : []
  for (const skipped of lockedSkipped) {
    details.push(`${reportNoOf(skipped)} 已处于「${statusOf(skipped)}」，保留原确认状态，不参与重算`)
  }

  const status = successCount === 0 ? 'failed' : 'succeeded'
  updateBatch(batchId, (batch) => ({
    ...batch,
    status,
    finishedAt: nowIso(),
    affectedCount: affected.length,
    reusedCount,
    recomputedCount: changedCount,
    error: failureCount > 0 ? `${failureCount} 份报告核算失败：${details.filter((item) => item.includes('：')).join('；')}` : undefined,
  }))

  if (successCount === 0) {
    return {
      ok: false,
      tone: 'error',
      message: `核算失败：${details.join('；')}`,
      batchId,
      details,
    }
  }

  const summary =
    scope === 'identity'
      ? `同身份核算完成：${changedCount} 份重算、${reusedCount} 份复用${failureCount > 0 ? `、${failureCount} 份失败（可重试）` : ''}${lockedSkipped.length > 0 ? `；${lockedSkipped.length} 份已确认/已归档报告保持原状` : ''}`
      : reusedCount > 0
        ? `${reportNoOf(target)} 直接复用了同核算身份的 ROI 数值，未触发重算`
        : `${reportNoOf(target)} 核算完成${failureCount > 0 ? `（${failureCount} 份失败可重试）` : ''}`

  return {
    ok: true,
    tone: failureCount > 0 ? 'warning' : 'success',
    message: summary,
    batchId,
    reportNo: reportNoOf(target),
    details,
  }
}

type ConfirmAttempt = {
  batchId: string
  raceGroup: string
  baseIds: number[]
  completionSeq: number
  reportId: number
  reportNo: string
  identity: string
  input: RoiInput
  operator: string
  startedAt: string
}

function beginConfirmAttempt(
  reportId: number,
  operator: string,
): { ok: true; attempt: ConfirmAttempt } | { ok: false; result: RoiActionResult } {
  const rows = listRows('roi')
  const row = rows.find((item) => Number(item.id) === reportId)
  if (!row) {
    return { ok: false, result: { ok: false, tone: 'error', message: `没有找到编号为 ${reportId} 的ROI报告` } }
  }
  const status = statusOf(row)
  if (status === ROI_STATUS.confirmed) {
    return {
      ok: false,
      result: { ok: false, tone: 'error', message: `${reportNoOf(row)} 已经确认过，不能重复确认` },
    }
  }
  if (status === ROI_STATUS.archived) {
    return {
      ok: false,
      result: { ok: false, tone: 'error', message: `${reportNoOf(row)} 已归档，不能再确认` },
    }
  }
  if (status !== ROI_STATUS.calculated) {
    return {
      ok: false,
      result: {
        ok: false,
        tone: 'warning',
        message: `${reportNoOf(row)} 当前为「${status}」，请先完成核算再确认`,
      },
    }
  }

  const lookup = activityLookupFactory()
  const inputResult = readRowInput(row, lookup)
  const meta = readMeta(row)
  const batchHelp = (error: string, details: string[] = []): RoiActionResult => {
    const work = loadWorkState()
    const id = nextBatchId(work.state, 'C')
    appendBatch({
      id,
      kind: 'confirm',
      identity: meta?.identity ?? '',
      identityLabel: reportNoOf(row),
      reportIds: [Number(row.id)],
      reportNos: [reportNoOf(row)],
      operator,
      status: 'failed',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      error,
    })
    return { ok: false, tone: 'error', message: `${reportNoOf(row)} 确认未通过完整校验：${error}`, batchId: id, details }
  }

  if (!inputResult.ok) {
    return { ok: false, result: batchHelp(inputResult.error) }
  }
  const input = inputResult.input
  const computed = computeRoi(input)
  const validation = validateForConfirm(row, input, meta, computed)
  if (!validation.ok) {
    return { ok: false, result: batchHelp(validation.errors.join('；'), validation.warnings) }
  }

  const identity = buildIdentity(input)
  const fingerprint = buildFingerprint(input)
  const baseIds = confirmedBaseline(rows, identity)
  const work = loadWorkState()
  const batchId = nextBatchId(work.state, 'C')
  const startedAt = nowIso()
  // 完成序号在「完整校验通过」这里分配：同一核算身份下谁先校验完，谁就是写入方。
  const completionSeq = allocateCompletionSeq()
  const raceGroup = `${identity}#${fingerprint}#${baseIds.join(',') || 'none'}`
  appendBatch({
    id: batchId,
    kind: 'confirm',
    identity,
    identityLabel: identityLabel(input),
    reportIds: [Number(row.id)],
    reportNos: [reportNoOf(row)],
    operator,
    status: 'running',
    startedAt,
    validatedAt: startedAt,
    completionSeq,
    raceGroup,
    note: validation.warnings.length > 0 ? `完整校验通过（提示：${validation.warnings.join('；')}）` : '完整校验通过',
  })

  return {
    ok: true,
    attempt: {
      batchId,
      raceGroup,
      baseIds,
      completionSeq,
      reportId: Number(row.id),
      reportNo: reportNoOf(row),
      identity,
      input,
      operator,
      startedAt,
    },
  }
}

function finishConfirmAttempt(attempt: ConfirmAttempt): RoiActionResult {
  const finishedAt = nowIso()
  const completionSeq = attempt.completionSeq
  updateBatch(attempt.batchId, (batch) => ({
    ...batch,
    status: 'succeeded',
    finishedAt,
  }))

  const work = loadWorkState()
  const winner = findEarlierWinner(work.state, attempt.raceGroup, attempt.batchId)
  const rows = listRows('roi')
  const currentBase = confirmedBaseline(rows, attempt.identity)
  const baselineChanged = currentBase.join(',') !== attempt.baseIds.join(',')

  if (winner || baselineChanged) {
    const winnerLabel = winner
      ? `${winner.reportNos.join('、')}（批次 ${winner.id}，完成序号 ${winner.completionSeq}）`
      : '另一处已完成校验的确认批次'
    const message = `确认冲突：同一核算身份的 ${winnerLabel} 先完成完整校验并写入，${attempt.reportNo} 的确认未写入，报告状态保持「已计算」`
    updateBatch(attempt.batchId, (batch) => ({
      ...batch,
      status: 'conflict',
      finishedAt,
      winnerBatchId: winner?.id,
      error: message,
    }))
    return {
      ok: false,
      tone: 'conflict',
      message,
      batchId: attempt.batchId,
      reportNo: attempt.reportNo,
      details: [`被比较的批次：${winner?.id ?? '未知'}`, `本批次完成序号：${completionSeq}`],
    }
  }

  const index = rows.findIndex((row) => Number(row.id) === attempt.reportId)
  if (index < 0) {
    return { ok: false, tone: 'error', message: `确认时找不到 ${attempt.reportNo}` }
  }
  const row = rows[index]
  if (statusOf(row) !== ROI_STATUS.calculated) {
    return {
      ok: false,
      tone: 'conflict',
      message: `${attempt.reportNo} 在确认过程中状态已变为「${statusOf(row)}」，本次确认未写入`,
      batchId: attempt.batchId,
    }
  }
  const meta = readMeta(row)
  const nextMeta: RoiMeta = {
    ...(meta as RoiMeta),
    confirmedBy: attempt.operator,
    confirmedAt: finishedAt,
  }
  const nextRow: EntryRow = {
    ...row,
    status: ROI_STATUS.confirmed,
    pending: false,
    abnormal: false,
    '确认人': attempt.operator,
    '确认时间': finishedAt,
    '核算元数据': writeMeta(nextMeta),
    '核算批次': attempt.batchId,
    '核算异常': '',
  }
  const nextRows = [...rows]
  nextRows[index] = nextRow
  saveRows('roi', nextRows)

  return {
    ok: true,
    tone: 'success',
    message: `${attempt.reportNo} 已由 ${attempt.operator} 确认${meta?.cacheStatus === 'hit' ? '（ROI 数值复用同身份缓存，确认记录独立保留）' : ''}`,
    batchId: attempt.batchId,
    reportNo: attempt.reportNo,
  }
}

export function confirmRoiReport(reportId: number, operator: string): RoiActionResult {
  const begun = beginConfirmAttempt(reportId, operator)
  if (!begun.ok) {
    return begun.result
  }
  return finishConfirmAttempt(begun.attempt)
}

/**
 * 并发确认演练：两个操作者在同一核算身份、同一轮确认基线上同时发起确认。
 * A 先完成完整校验（拿到更小的完成序号），B 后完成；两者都没有看到对方的确认结果，
 * 因此属于同一轮竞态。写入时故意先让 B 落库，验证判定依据是「谁先完成完整校验」而不是
 * 「谁先写入」：B 检测到 A 的完成序号更小 → 显示冲突且不写报告；A 正常确认。
 */
export function simulateConcurrentConfirmation(
  operatorA: string,
  operatorB: string,
): RoiActionResult {
  const rows = listRows('roi')
  const lookup = activityLookupFactory()
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    if (statusOf(row) !== ROI_STATUS.calculated) {
      continue
    }
    const input = readRowInput(row, lookup)
    if (!input.ok) {
      continue
    }
    const identity = buildIdentity(input.input)
    groups.set(identity, [...(groups.get(identity) ?? []), row])
  }
  const candidate = [...groups.values()].find((group) => group.length >= 2)
  if (!candidate) {
    return {
      ok: false,
      tone: 'warning',
      message: '没有同一核算身份下两份「已计算」报告，无法演练并发确认；请先对 ROI-0001 和 ROI-0002 提交计算',
    }
  }
  const [first, second] = candidate
  // A 先完成完整校验（拿到更小的完成序号），B 后完成；随后故意让 B 先写入。
  const begunA = beginConfirmAttempt(Number(first.id), operatorA)
  if (!begunA.ok) {
    return begunA.result
  }
  const begunB = beginConfirmAttempt(Number(second.id), operatorB)
  if (!begunB.ok) {
    return begunB.result
  }

  const resultB = finishConfirmAttempt(begunB.attempt)
  const resultA = finishConfirmAttempt(begunA.attempt)

  const winner = resultA.ok ? resultA : resultB
  const loser = resultA.ok ? resultB : resultA
  const tone: RoiActionTone = loser.tone === 'conflict' ? 'conflict' : 'warning'
  return {
    ok: Boolean(resultA.ok || resultB.ok),
    tone,
    message: `并发确认演练完成：${winner.reportNo} 先完成完整校验（完成序号 #${begunA.attempt.completionSeq}）并确认；${loser.reportNo} 后完成校验（完成序号 #${begunB.attempt.completionSeq}），即使先写入也显示冲突且未产生确认`,
    batchId: loser.batchId,
    details: [resultA.message, resultB.message],
  }
}

export function archiveRoiReport(reportId: number, operator: string): RoiActionResult {
  const rows = listRows('roi')
  const index = rows.findIndex((row) => Number(row.id) === reportId)
  if (index < 0) {
    return { ok: false, tone: 'error', message: `没有找到编号为 ${reportId} 的ROI报告` }
  }
  const row = rows[index]
  const status = statusOf(row)
  if (status === ROI_STATUS.archived) {
    return { ok: false, tone: 'error', message: `${reportNoOf(row)} 已经归档，不用重复操作` }
  }
  if (status !== ROI_STATUS.confirmed) {
    return {
      ok: false,
      tone: 'warning',
      message: `${reportNoOf(row)} 当前为「${status}」，只有已确认报告可以归档`,
    }
  }
  const meta = readMeta(row)
  const archivedAt = nowIso()
  const nextMeta: RoiMeta | null = meta
    ? { ...meta, archivedBy: operator, archivedAt }
    : null
  const nextRow: EntryRow = {
    ...row,
    status: ROI_STATUS.archived,
    pending: false,
    abnormal: false,
    '归档人': operator,
    '归档时间': archivedAt,
    ...(nextMeta ? { '核算元数据': writeMeta(nextMeta) } : {}),
  }
  const nextRows = [...rows]
  nextRows[index] = nextRow
  saveRows('roi', nextRows)

  const siblings = rows.filter(
    (item) =>
      Number(item.id) !== reportId &&
      (statusOf(item) === ROI_STATUS.confirmed || statusOf(item) === ROI_STATUS.archived) &&
      meta?.identity &&
      readMeta(item)?.identity === meta.identity,
  )
  return {
    ok: true,
    tone: 'success',
    message:
      siblings.length > 0
        ? `${reportNoOf(row)} 已单独归档；同身份的 ${siblings.map(reportNoOf).join('、')} 保持各自确认/归档状态，未被连带处理`
        : `${reportNoOf(row)} 已归档`,
    reportNo: reportNoOf(row),
  }
}

export function retryBatch(batchId: string, operator: string): RoiActionResult {
  const work = loadWorkState()
  const batch = work.state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, tone: 'error', message: `没有找到核算批次 ${batchId}` }
  }
  if (batch.status === 'succeeded' || batch.status === 'reused') {
    return { ok: false, tone: 'info', message: `批次 ${batchId} 已成功，无需重试` }
  }
  if (batch.reportIds.length === 0) {
    return { ok: false, tone: 'error', message: `批次 ${batchId} 没有可重试的报告` }
  }
  const results = batch.reportIds.map((reportId) =>
    batch.kind === 'confirm'
      ? confirmRoiReport(reportId, operator)
      : submitRoiCalculation(reportId, operator, batch.kind === 'recalculate' ? 'identity' : 'single'),
  )
  const success = results.filter((result) => result.ok)
  const failed = results.filter((result) => !result.ok)
  if (success.length === 0) {
    return {
      ok: false,
      tone: 'error',
      message: `批次 ${batchId} 重试仍失败：${failed.map((result) => result.message).join('；')}`,
      details: results.map((result) => result.message),
    }
  }
  return {
    ok: true,
    tone: failed.length > 0 ? 'warning' : 'success',
    message: `批次 ${batchId} 已重试：${success.length} 份成功${failed.length > 0 ? `，${failed.length} 份仍失败` : ''}（异常原因见批次记录）`,
    details: results.map((result) => result.message),
  }
}

/** 页面加载时恢复现场：把上次没跑完的批次标为中断，并把对应报告从「计算中」拉回可重试状态。 */
export function recoverRoiWorkspace(options: { force?: boolean } = {}): { count: number; message: string } {
  const interruptedAdded = markStaleRunningBatches({ force: options.force })
  const work = loadWorkState()
  const interruptedBatches = work.state.batches.filter((batch) => batch.status === 'interrupted')
  const interruptedIds = new Set(interruptedBatches.map((batch) => batch.id))

  const rows = listRows('roi')
  let recoveredReports = 0
  const nextRows = rows.map((row) => {
    if (statusOf(row) !== ROI_STATUS.computing) {
      return row
    }
    const batchId = String(row['核算批次'] ?? '')
    const batch = interruptedBatches.find((item) => item.id === batchId)
    recoveredReports += 1
    return {
      ...row,
      status: ROI_STATUS.interrupted,
      pending: true,
      abnormal: true,
      '核算异常':
        batch?.error ??
        (interruptedIds.has(batchId)
          ? '核算进程未完成即中断，已恢复现场，可重试'
          : '要么是页面在核算过程中被关闭，要么是批次记录已丢失：已恢复为可重试状态，请重新提交计算'),
    }
  })
  if (recoveredReports > 0) {
    saveRows('roi', nextRows)
  }

  if (interruptedAdded === 0 && recoveredReports === 0) {
    return { count: 0, message: '' }
  }
  const reason = interruptedBatches[0]?.error ?? '报告停留在「计算中」且原批次已丢失'
  return {
    count: Math.max(interruptedAdded, recoveredReports),
    message: `异常原因：${reason}；已恢复 ${recoveredReports} 份中断报告、${interruptedAdded} 个中断批次，可直接重试（重试时会重新执行完整核算）`,
  }
}

/** 演示 / 自测用：模拟页面在核算途中被关闭，留下一份停在「计算中」的报告与运行中批次。 */
export function simulateInterruption(reportId: number, operator: string): RoiActionResult {
  const rows = listRows('roi')
  const index = rows.findIndex((row) => Number(row.id) === reportId)
  if (index < 0) {
    return { ok: false, tone: 'error', message: `没有找到编号为 ${reportId} 的ROI报告` }
  }
  const row = rows[index]
  if (LOCKED_STATUSES.has(statusOf(row))) {
    return { ok: false, tone: 'error', message: `${reportNoOf(row)} 已确认或归档，不能模拟中断` }
  }
  const work = loadWorkState()
  const batchId = nextBatchId(work.state, 'B')
  appendBatch({
    id: batchId,
    kind: 'calculate',
    identity: readMeta(row)?.identity ?? '',
    identityLabel: reportNoOf(row),
    reportIds: [Number(row.id)],
    reportNos: [reportNoOf(row)],
    operator,
    status: 'running',
    startedAt: nowIso(),
  })
  const nextRows = [...rows]
  nextRows[index] = {
    ...row,
    status: ROI_STATUS.computing,
    pending: true,
    '核算批次': batchId,
    '核算异常': '',
  }
  saveRows('roi', nextRows)
  return {
    ok: true,
    tone: 'warning',
    message: `已模拟 ${reportNoOf(row)} 在核算途中被关闭页面：重新进入页面会自动恢复现场并说明原因，也可点「模拟刷新并恢复」立即触发`,
    batchId,
    reportNo: reportNoOf(row),
  }
}

export function setCacheSimulation(down: boolean): RoiActionResult {  setRoiCacheSimulatedDown(down)
  return {
    ok: true,
    tone: down ? 'warning' : 'info',
    message: down
      ? '已模拟核算缓存不可用：后续提交计算将回退到真实计算，不会读取任何旧缓存值'
      : '已恢复核算缓存：命中要求核算身份、输入指纹、口径版本三者一致',
  }
}

export type RoiCreateInput = {
  reportNo: string
  activity: string
  investment: string
  revenue: string
  clicks: string
  impressions: string
  period: string
}

export function createRoiReport(input: RoiCreateInput): RoiActionResult {
  const rows = listRows('roi')
  const reportNo = input.reportNo.trim().toUpperCase()
  if (!reportNo) {
    return { ok: false, tone: 'error', message: '报告编号不能为空' }
  }
  if (rows.some((row) => reportNoOf(row).toUpperCase() === reportNo)) {
    return { ok: false, tone: 'error', message: `报告编号 ${reportNo} 已存在` }
  }
  const activity = input.activity.trim().toUpperCase()
  const lookup = activityLookupFactory()
  const campaign = lookup({ id: 0, status: '', pending: false, abnormal: false, 关联活动: activity } as EntryRow)
  if (!campaign) {
    return { ok: false, tone: 'error', message: `活动 ${input.activity} 不在投放活动清单中，无法建立核算身份` }
  }
  const investmentCents = parseAmountToCents(input.investment)
  const revenueCents = parseAmountToCents(input.revenue)
  if (investmentCents === null || investmentCents <= 0) {
    return { ok: false, tone: 'error', message: '投入金额必须是大于 0 的金额' }
  }
  if (revenueCents === null || revenueCents < 0) {
    return { ok: false, tone: 'error', message: '转化收入必须是合法非负金额' }
  }
  if (!parsePeriod(input.period)) {
    return { ok: false, tone: 'error', message: '评估周期格式应为 YYYY-MM-DD~YYYY-MM-DD，且结束不早于开始' }
  }
  if (!/^\d+$/.test(input.clicks.trim()) || !/^\d+$/.test(input.impressions.trim())) {
    return { ok: false, tone: 'error', message: '点击量与曝光量必须是非负整数' }
  }
  const nextId = Math.max(0, ...rows.map((row) => Number(row.id))) + 1
  const nextRow: EntryRow = {
    id: nextId,
    status: ROI_STATUS.draft,
    pending: true,
    abnormal: false,
    '报告编号': reportNo,
    '关联活动': activity,
    '投入金额': centsToAmount(investmentCents),
    '转化收入': centsToAmount(revenueCents),
    '点击量': Number(input.clicks),
    '曝光量': Number(input.impressions),
    'ROI数值': '',
    'CPC成本': '',
    'CPM成本': '',
    '评估周期': parsePeriod(input.period)?.canonical ?? input.period.trim(),
    '确认人': '',
    '确认时间': '',
  }
  saveRows('roi', [...rows, nextRow])
  return {
    ok: true,
    tone: 'success',
    message: `${reportNo} 已登记为草稿；提交计算后会按「${activity} + ${nextRow['投入金额']} 元 + ${nextRow['评估周期']}」形成核算身份`,
    reportNo,
  }
}

export type RoiUpdateInput = {
  investment: string
  revenue: string
  clicks: string
  impressions: string
  period: string
}

/**
 * 调整一份报告的核算输入（例如运营改评估周期、补一笔回收收入）。
 * 只改这一行并把状态降为「待重算」，同身份的其他报告不受影响；已确认 / 已归档报告不允许改。
 */
export function updateRoiReportInputs(reportId: number, input: RoiUpdateInput, operator: string): RoiActionResult {
  const rows = listRows('roi')
  const index = rows.findIndex((row) => Number(row.id) === reportId)
  if (index < 0) {
    return { ok: false, tone: 'error', message: `没有找到编号为 ${reportId} 的ROI报告` }
  }
  const row = rows[index]
  if (LOCKED_STATUSES.has(statusOf(row))) {
    return {
      ok: false,
      tone: 'error',
      message: `${reportNoOf(row)} 当前为「${statusOf(row)}」，确认或归档后不允许再改核算输入`,
    }
  }
  const investmentCents = parseAmountToCents(input.investment)
  const revenueCents = parseAmountToCents(input.revenue)
  if (investmentCents === null || investmentCents <= 0) {
    return { ok: false, tone: 'error', message: '投入金额必须是大于 0 的金额' }
  }
  if (revenueCents === null || revenueCents < 0) {
    return { ok: false, tone: 'error', message: '转化收入必须是合法非负金额' }
  }
  const period = parsePeriod(input.period)
  if (!period) {
    return { ok: false, tone: 'error', message: '评估周期格式应为 YYYY-MM-DD~YYYY-MM-DD，且结束不早于开始' }
  }
  if (!/^\d+$/.test(input.clicks.trim()) || !/^\d+$/.test(input.impressions.trim())) {
    return { ok: false, tone: 'error', message: '点击量与曝光量必须是非负整数' }
  }

  const previous = readInput(row, activityLookupFactory())
  const previousIdentity = previous.ok ? buildIdentity(previous.input) : ''
  const previousFingerprint = previous.ok ? buildFingerprint(previous.input) : ''

  const nextRow: EntryRow = {
    ...row,
    '投入金额': centsToAmount(investmentCents),
    '转化收入': centsToAmount(revenueCents),
    '点击量': Number(input.clicks),
    '曝光量': Number(input.impressions),
    '评估周期': period.canonical,
  }
  const nextInput = readInput(nextRow, activityLookupFactory())
  const identityChanged = !nextInput.ok || buildIdentity(nextInput.input) !== previousIdentity
  const fingerprintChanged = !nextInput.ok || buildFingerprint(nextInput.input) !== previousFingerprint
  const hadNumbers = Boolean(readMeta(row))

  const nextRows = [...rows]
  if (identityChanged || fingerprintChanged) {
    nextRows[index] = {
      ...nextRow,
      // 数值已与输入不一致：降级为待重算，但保留旧数值供对比，只是不再允许直接确认。
      status: hadNumbers ? ROI_STATUS.stale : ROI_STATUS.draft,
      pending: true,
      '核算异常': hadNumbers
        ? `核算输入已由 ${operator} 调整${identityChanged ? '（核算身份变化）' : ''}，原 ROI 数值不再有效，请提交计算`
        : '',
    }
  } else {
    nextRows[index] = nextRow
  }
  saveRows('roi', nextRows)

  const siblingsUnchanged = rows.filter((item) => {
    if (Number(item.id) === reportId || LOCKED_STATUSES.has(statusOf(item))) {
      return false
    }
    const itemInput = readInput(item, activityLookupFactory())
    return itemInput.ok && previousIdentity !== '' && buildIdentity(itemInput.input) === previousIdentity
  })

  return {
    ok: true,
    tone: 'success',
    message: `${
      identityChanged || fingerprintChanged
        ? `${reportNoOf(row)} 的核算输入已更新，状态降为「${hadNumbers ? ROI_STATUS.stale : ROI_STATUS.draft}」`
        : `${reportNoOf(row)} 的输入与核算时一致，无需重算`
    }${siblingsUnchanged.length > 0 ? `；同身份的 ${siblingsUnchanged.map(reportNoOf).join('、')} 不受影响` : ''}`,
    reportNo: reportNoOf(row),
  }
}

export function clearRoiReports(): RoiActionResult {
  saveRows('roi', [])
  clearWorkLog()
  return { ok: true, tone: 'info', message: '已清空ROI报告（用于观察空态），核算批次日志同时清空；缓存会在下次计算时重建' }
}

export function resetRoiReports(): RoiActionResult {
  const rows = resetRows('roi')
  clearWorkLog()
  return {
    ok: true,
    tone: 'info',
    message: `ROI评估已重置为示例数据（${rows.length} 份报告），核算批次日志同时清空；缓存保留但会按身份与输入指纹重新校验`,
  }
}
