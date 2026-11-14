/**
 * ROI 核算批次 / 并发确认的工作日志。
 *
 * 与「结果缓存」分开存：缓存是可选加速层，坏了只影响复用率；这里记录的是可续跑的
 * 执行过程 —— 哪一批在算、算了几份、失败 / 中断原因、并发确认谁先完成完整校验。
 */

export const ROI_WORK_KEY = 'data-product-ops:roi-work'
export const ROI_WORK_SCHEMA_VERSION = 2

export type RoiBatchKind = 'calculate' | 'recalculate' | 'confirm'

export type RoiBatchStatus =
  | 'running'
  | 'succeeded'
  | 'reused'
  | 'failed'
  | 'interrupted'
  | 'conflict'

export type RoiBatch = {
  id: string
  kind: RoiBatchKind
  identity: string
  identityLabel: string
  reportIds: number[]
  reportNos: string[]
  operator: string
  status: RoiBatchStatus
  startedAt: string
  finishedAt?: string
  completionSeq?: number
  validatedAt?: string
  error?: string
  note?: string
  cachedFrom?: string
  raceGroup?: string
  winnerBatchId?: string
  affectedCount?: number
  reusedCount?: number
  recomputedCount?: number
}

export type RoiWorkState = {
  schemaVersion: number
  sequence: number
  batches: RoiBatch[]
}

export type RoiWorkLoad = {
  available: boolean
  reason: string
  state: RoiWorkState
}

function emptyState(): RoiWorkState {
  return { schemaVersion: ROI_WORK_SCHEMA_VERSION, sequence: 0, batches: [] }
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

let memoryState: RoiWorkState = emptyState()

export function loadWorkState(): RoiWorkLoad {
  const target = storage()
  if (!target) {
    return { available: false, reason: '浏览器本地存储不可用，批次只保留在当前会话', state: memoryState }
  }
  const raw = target.getItem(ROI_WORK_KEY)
  if (!raw) {
    return { available: true, reason: '', state: emptyState() }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RoiWorkState>
    if (!parsed || parsed.schemaVersion !== ROI_WORK_SCHEMA_VERSION || !Array.isArray(parsed.batches)) {
      memoryState = emptyState()
      return { available: false, reason: '核算批次记录结构损坏，已重置为本会话日志', state: memoryState }
    }
    memoryState = {
      schemaVersion: ROI_WORK_SCHEMA_VERSION,
      sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
      batches: parsed.batches as RoiBatch[],
    }
    return { available: true, reason: '', state: memoryState }
  } catch {
    memoryState = emptyState()
    return { available: false, reason: '核算批次记录无法解析，已重置为本会话日志', state: memoryState }
  }
}

function persist(state: RoiWorkState): boolean {
  memoryState = state
  const target = storage()
  if (!target) {
    return false
  }
  try {
    target.setItem(ROI_WORK_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function nextBatchId(state: RoiWorkState, prefix = 'B'): string {
  return `${prefix}-${Date.now().toString(36)}-${(state.sequence + 1).toString(36)}`
}

export function appendBatch(batch: RoiBatch): RoiWorkLoad {
  const loaded = loadWorkState()
  const state: RoiWorkState = {
    ...loaded.state,
    sequence: loaded.state.sequence + 1,
    batches: [batch, ...loaded.state.batches].slice(0, 60),
  }
  const persisted = persist(state)
  return {
    available: loaded.available && persisted,
    reason: persisted ? '' : '批次日志写入本地存储失败，仅保留在当前会话',
    state,
  }
}

export function updateBatch(
  id: string,
  updater: (batch: RoiBatch) => RoiBatch,
): { updated: boolean; state: RoiWorkState } {
  const loaded = loadWorkState()
  let found = false
  const batches = loaded.state.batches.map((batch) => {
    if (batch.id !== id) {
      return batch
    }
    found = true
    return updater(batch)
  })
  if (!found) {
    return { updated: false, state: loaded.state }
  }
  const state: RoiWorkState = { ...loaded.state, batches }
  persist(state)
  return { updated: true, state }
}

/** 完成顺序号：并发确认时，先完成完整校验的批次拿到更小的序号。 */
export function allocateCompletionSeq(): number {
  const loaded = loadWorkState()
  const sequence = loaded.state.sequence + 1
  persist({ ...loaded.state, sequence })
  return sequence
}

/**
 * 找出同一竞态组里「更早完成完整校验」的批次。
 * 不看批次最后是成功还是冲突、也不看谁先写入：完成序号更小就是先到者。
 */
export function findEarlierWinner(state: RoiWorkState, raceGroup: string, batchId: string): RoiBatch | null {
  const candidates = state.batches.filter(
    (batch) =>
      batch.raceGroup === raceGroup &&
      batch.id !== batchId &&
      batch.status !== 'conflict' &&
      typeof batch.completionSeq === 'number',
  )
  if (candidates.length === 0) {
    return null
  }
  const earliest = candidates.reduce((first, batch) =>
    (batch.completionSeq as number) < (first.completionSeq as number) ? batch : first,
  )
  const self = state.batches.find((batch) => batch.id === batchId)
  if (self && typeof self.completionSeq === 'number' && self.completionSeq <= (earliest.completionSeq as number)) {
    return null
  }
  return earliest
}

/** 页面重新打开时，把上一次没跑完的批次标成「中断」，保留现场供重试。 */
export function markStaleRunningBatches(options: { force?: boolean; now?: number } = {}): number {
  const now = options.now ?? Date.now()
  const loaded = loadWorkState()
  let count = 0
  const batches = loaded.state.batches.map((batch) => {
    if (batch.status !== 'running') {
      return batch
    }
    // 在同一个标签页里刚开始的批次不算中断；换页面 / 刷新后重新挂载时由调用方 force。
    const started = Date.parse(batch.startedAt)
    if (!options.force && Number.isFinite(started) && now - started < 2_000) {
      return batch
    }
    count += 1
    return {
      ...batch,
      status: 'interrupted' as const,
      finishedAt: new Date(now).toISOString(),
      error: '核算进程在完成前中断（页面刷新 / 会话断开），已保留现场，可重试恢复',
    }
  })
  if (count > 0) {
    persist({ ...loaded.state, batches })
  }
  return count
}

export function clearWorkLog(): void {
  memoryState = emptyState()
  const target = storage()
  try {
    target?.removeItem(ROI_WORK_KEY)
  } catch {
    // 清不掉也不影响当前会话继续记录。
  }
}
