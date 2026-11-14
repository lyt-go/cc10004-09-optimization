import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import {
  clearRoiReports,
  createRoiReport,
  injectRoiFailure,
  loadRoiWorkspace,
  recoverRoiWorkspace,
  resetRoiReports,
  simulateConcurrentConfirmation,
  simulateInterruption,
  updateRoiReportInputs,
  type RoiUpdateInput,
  submitRoiCalculation,
  archiveRoiReport,
  confirmRoiReport,
  retryBatch,
  setCacheSimulation,
  type RoiActionResult,
  type RoiCreateInput,
  type RoiReportView,
  type RoiWorkspace,
} from '@/api/roi-service'
import { downloadEntries, moduleMeta } from '@/api/local-service'
import type { RoiBatch } from '@/domain/roi-work'

const meta = moduleMeta('roi')

const COLUMNS: { key: keyof RoiReportView; label: string }[] = [
  { key: 'reportNo', label: '报告编号' },
  { key: 'activityName', label: '关联活动' },
  { key: 'investmentText', label: '投入金额' },
  { key: 'revenueText', label: '转化收入' },
  { key: 'roiText', label: 'ROI数值' },
  { key: 'cpcText', label: 'CPC成本' },
  { key: 'cpmText', label: 'CPM成本' },
  { key: 'period', label: '评估周期' },
]

const FILTER_FIELDS = ['报告编号', '关联活动', '评估周期'] as const

const STATUS_ORDER = ['草稿', '计算中', '已计算', '待重算', '计算中断', '已确认', '已归档']

const STATUS_DESC: Record<string, string> = {
  草稿: '尚未提交计算',
  计算中: '核算批次已开始，尚未写回',
  已计算: '数值已就绪，可确认',
  待重算: '输入或活动窗口已变化，当前数值不可再确认',
  计算中断: '上次核算失败 / 中断，可直接重试',
  已确认: '确认人与确认时间独立记录在报告上',
  已归档: '归档只作用于本报告',
}

const TONE_CLASS: Record<RoiActionResult['tone'], string> = {
  success: 'notice success',
  conflict: 'notice conflict',
  error: 'notice error',
  warning: 'notice warning',
  info: 'notice info',
}

type Notice = { tone: RoiActionResult['tone']; message: string; details: string[] }

const EMPTY_FORM: RoiCreateInput = {
  reportNo: '',
  activity: 'CAMP-0001',
  investment: '120000',
  revenue: '186000',
  clicks: '4800',
  impressions: '960000',
  period: '2026-09-01~2026-09-30',
}

function formatClock(value: string | undefined): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return value
  }
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const BATCH_STATUS_LABEL: Record<RoiBatch['status'], string> = {
  running: '执行中',
  succeeded: '成功',
  reused: '复用',
  failed: '失败',
  interrupted: '中断',
  conflict: '冲突',
}

const CACHE_LABEL: Record<RoiReportView['liveCache'], string> = {
  hit: '缓存命中',
  miss: '缓存待建',
  stale: '数值已过期',
  unavailable: '缓存不可用',
  none: '尚未核算',
}

export default function RoiView() {
  const [workspace, setWorkspace] = useState<RoiWorkspace | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [draftFilters, setDraftFilters] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [recovery, setRecovery] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<RoiCreateInput>(EMPTY_FORM)
  const [working, setWorking] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<RoiUpdateInput>({ investment: '', revenue: '', clicks: '', impressions: '', period: '' })
  const operator = '值班管理员'
  const recoveredRef = useRef(false)

  const reload = useCallback(
    (message?: Notice | null) => {
      try {
        const next = loadRoiWorkspace(filters)
        setWorkspace(next)
        if (message) {
          setNotice(message)
        }
      } catch (error) {
        setNotice({
          tone: 'error',
          message: `ROI评估列表读取失败：${error instanceof Error ? error.message : '未知异常'}`,
          details: [],
        })
      }
    },
    [filters],
  )

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (recoveredRef.current) {
      return
    }
    recoveredRef.current = true
    // 核算在本地是同步执行的，页面重开后还停在「执行中」的批次一定是上次中断留下的。
    const result = recoverRoiWorkspace({ force: true })
    if (result.count > 0) {
      setRecovery(result.message)
      reload()
    }
  }, [reload])

  function apply(result: RoiActionResult, after?: () => void) {
    setNotice({ tone: result.tone, message: result.message, details: result.details ?? [] })
    after?.()
    reload()
  }

  function onCalculate(row: RoiReportView, scope: 'single' | 'identity') {
    setWorking(true)
    try {
      const result = submitRoiCalculation(row.id, operator, scope)
      apply(result)
    } finally {
      setWorking(false)
    }
  }

  function onConfirm(row: RoiReportView) {
    setWorking(true)
    try {
      apply(confirmRoiReport(row.id, operator))
    } finally {
      setWorking(false)
    }
  }

  function startEdit(row: RoiReportView) {
    setEditing(row.id)
    setEditForm({
      investment: row.investmentText,
      revenue: row.revenueText,
      clicks: row.clicksText,
      impressions: row.impressionsText,
      period: row.period,
    })
  }

  function onSubmitEdit(event: FormEvent) {
    event.preventDefault()
    if (editing === null) {
      return
    }
    const result = updateRoiReportInputs(editing, editForm, operator)
    apply(result, () => {
      if (result.ok) {
        setEditing(null)
      }
    })
  }

  function onArchive(row: RoiReportView) {
    apply(archiveRoiReport(row.id, operator))
  }

  function onRetryBatch(batchId: string) {
    setWorking(true)
    try {
      apply(retryBatch(batchId, operator))
    } finally {
      setWorking(false)
    }
  }

  function onRecalculateSharedIdentity() {
    const anchor = items.find((row) => row.identity && row.sharedCount > 1) ?? items.find((row) => row.identity)
    if (!anchor) {
      setNotice({ tone: 'warning', message: '当前没有已形成核算身份的报告，请先提交计算', details: [] })
      return
    }
    onCalculate(anchor, 'identity')
  }

  function onSimulateConflict() {
    apply(simulateConcurrentConfirmation('运营A', '运营B'))
  }

  function onToggleCache() {
    const next = !(workspace?.cache.simulatedDown ?? false)
    apply(setCacheSimulation(next))
  }

  function onInjectFailure() {
    apply(injectRoiFailure('核算服务连接超时（演示用一次性故障）'))
  }

  function onSimulateInterruption() {
    const anchor = items.find((row) => row.canSubmit || row.canRetry) ?? items[0]
    if (!anchor) {
      setNotice({ tone: 'warning', message: '当前没有可模拟中断的报告', details: [] })
      return
    }
    apply(simulateInterruption(anchor.id, operator))
  }

  function onCreate(event: FormEvent) {
    event.preventDefault()
    const result = createRoiReport(form)
    apply(result, () => {
      if (result.ok) {
        setShowForm(false)
        setForm(EMPTY_FORM)
      }
    })
  }

  function onRecoverNow() {
    const result = recoverRoiWorkspace({ force: true })
    setRecovery(result.message || '没有待恢复的中断批次')
    reload()
  }

  const identityGroups = workspace?.identityGroups ?? []
  const items = workspace?.items ?? []
  const empty = workspace !== null && workspace.total === 0
  const stats = useMemo(() => workspace?.stats ?? [], [workspace])
  const batches = workspace?.batches ?? []

  return (
    <section className="page roi-page" data-module="roi">
      <header className="page-head">
        <div>
          <h2>ROI评估管理</h2>
          <p className="page-desc">
            核算身份 = 关联活动 + 投入金额 + 评估周期。身份与输入都没变化的报告直接复用 ROI 数值；
            任一项变化只重算受影响的报告。ROI 保留 4 位小数，CPC / CPM 保留 2 位小数。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setShowForm((prev) => !prev)}>
            {showForm ? '收起登记表单' : '登记ROI报告'}
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出ROI评估清单
          </button>
        </div>
      </header>

      {recovery && (
        <p className="notice warning" data-testid="roi-recovery">
          <strong>现场已恢复：</strong>
          {recovery}
          <button className="link" type="button" onClick={() => setRecovery('')}>知道了</button>
        </p>
      )}

      {showForm && (
        <form className="roi-form" onSubmit={onCreate}>
          <label>
            <span>报告编号</span>
            <input required value={form.reportNo} placeholder="ROI-0004" onChange={(e) => setForm({ ...form, reportNo: e.target.value })} />
          </label>
          <label>
            <span>关联活动</span>
            <input required value={form.activity} placeholder="CAMP-0001" onChange={(e) => setForm({ ...form, activity: e.target.value })} />
          </label>
          <label>
            <span>投入金额</span>
            <input required value={form.investment} onChange={(e) => setForm({ ...form, investment: e.target.value })} />
          </label>
          <label>
            <span>转化收入</span>
            <input required value={form.revenue} onChange={(e) => setForm({ ...form, revenue: e.target.value })} />
          </label>
          <label>
            <span>点击量</span>
            <input required value={form.clicks} onChange={(e) => setForm({ ...form, clicks: e.target.value })} />
          </label>
          <label>
            <span>曝光量</span>
            <input required value={form.impressions} onChange={(e) => setForm({ ...form, impressions: e.target.value })} />
          </label>
          <label>
            <span>评估周期</span>
            <input required value={form.period} placeholder="2026-09-01~2026-09-30" onChange={(e) => setForm({ ...form, period: e.target.value })} />
          </label>
          <button className="btn primary" type="submit">保存草稿</button>
        </form>
      )}

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
            {item.hint && <span className="stat-hint">{item.hint}</span>}
          </article>
        ))}
      </div>

      <div className="roi-toolbar">
        <div className="roi-toolbar-group">
          <span className="roi-toolbar-label">验证操作</span>
          <button className="btn" type="button" onClick={onSimulateConflict} disabled={working}>
            并发确认演练
          </button>
          <button className="btn" type="button" onClick={onRecalculateSharedIdentity} disabled={working}>
            同身份批量重算
          </button>
          <button className="btn" type="button" onClick={onInjectFailure} disabled={working}>
            注入一次核算失败
          </button>
          <button className="btn" type="button" onClick={onSimulateInterruption} disabled={working}>
            模拟核算中断
          </button>
          <button className="btn" type="button" onClick={onRecoverNow} disabled={working}>
            模拟刷新并恢复
          </button>
          <button className="btn" type="button" onClick={onToggleCache} disabled={working}>
            {workspace?.cache.simulatedDown ? '恢复核算缓存' : '模拟缓存不可用'}
          </button>
          <button className="btn ghost" type="button" onClick={() => apply(resetRoiReports())}>
            重置示例数据
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              if (window.confirm('清空后本模块的ROI报告会被删除（仅本地浏览器数据），用于观察空态。继续？')) {
                apply(clearRoiReports())
              }
            }}
          >
            清空以查看空态
          </button>
        </div>
        <div className={`cache-badge ${workspace?.cache.available ? 'ok' : 'down'}`}>
          核算缓存：{workspace?.cache.available ? '可用' : '不可用'}
          {workspace?.cache.reason ? `（${workspace.cache.reason}）` : ''}
        </div>
      </div>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          setFilters(draftFilters)
        }}
      >
        {FILTER_FIELDS.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={draftFilters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setDraftFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button
          className="btn ghost"
          type="button"
          onClick={() => {
            setDraftFilters({})
            setFilters({})
          }}
        >
          重置条件
        </button>
      </form>

      <p className="status-legend">
        {STATUS_ORDER.map((status) => (
          <span key={status} className="legend-item" title={STATUS_DESC[status]}>
            {status}：{items.filter((row) => row.status === status).length}
          </span>
        ))}
      </p>

      {notice && (
        <div className={TONE_CLASS[notice.tone]} data-testid="roi-notice" role="status">
          <div className="notice-main">
            <strong>{notice.tone === 'conflict' ? '冲突' : notice.tone === 'error' ? '失败' : '提示'}：</strong>
            {notice.message}
            <button className="link" type="button" onClick={() => setNotice(null)}>关闭</button>
          </div>
          {notice.details.length > 0 && (
            <ul className="notice-detail">
              {notice.details.map((detail, index) => (
                <li key={`${index}-${detail}`}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editing !== null && (
        <form className="roi-form" onSubmit={onSubmitEdit} data-testid="roi-edit-form">
          <label>
            <span>调整投入金额</span>
            <input required value={editForm.investment} onChange={(e) => setEditForm({ ...editForm, investment: e.target.value })} />
          </label>
          <label>
            <span>调整转化收入</span>
            <input required value={editForm.revenue} onChange={(e) => setEditForm({ ...editForm, revenue: e.target.value })} />
          </label>
          <label>
            <span>点击量</span>
            <input required value={editForm.clicks} onChange={(e) => setEditForm({ ...editForm, clicks: e.target.value })} />
          </label>
          <label>
            <span>曝光量</span>
            <input required value={editForm.impressions} onChange={(e) => setEditForm({ ...editForm, impressions: e.target.value })} />
          </label>
          <label>
            <span>调整评估周期</span>
            <input required value={editForm.period} onChange={(e) => setEditForm({ ...editForm, period: e.target.value })} />
          </label>
          <button className="btn primary" type="submit">保存并标记待重算</button>
          <button className="btn ghost" type="button" onClick={() => setEditing(null)}>取消</button>
        </form>
      )}

      <table className="data-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => <th key={column.key}>{column.label}</th>)}
            <th>核算身份</th>
            <th>数值来源</th>
            <th>当前状态</th>
            <th>确认人 / 确认时间</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id} data-report={row.reportNo}>
              {COLUMNS.map((column) => (
                <td key={column.key} title={column.key === 'roiText' ? CACHE_LABEL[row.liveCache] : undefined}>
                  {column.key === 'activityName'
                    ? `${row.activityName || row.activity}（${row.activity}）`
                    : row[column.key] || '—'}
                </td>
              ))}
              <td className="identity-cell">
                <span className="identity-text">{row.identityText}</span>
                {row.sharedCount > 1 && <span className="identity-tag">同身份 {row.sharedCount} 份</span>}
              </td>
              <td>
                <span className={`cache-state ${row.liveCache}`}>{row.numberSource}</span>
                {row.liveCache === 'stale' && <span className="cell-warn">输入已变化，需重算</span>}
                {row.liveCache === 'unavailable' && <span className="cell-warn">缓存不可用，值来自真实计算</span>}
              </td>
              <td>
                <span className={`status-pill status-${row.status}`}>{row.status}</span>
                {row.errorText && <span className="cell-warn">{row.errorText}</span>}
              </td>
              <td className="confirm-cell">
                <span>{row.confirmedBy}</span>
                <span className="cell-muted">{row.confirmedAt}</span>
              </td>
              <td className="row-actions">
                {row.canSubmit && (
                  <button className="link" type="button" disabled={working} onClick={() => onCalculate(row, 'single')}>
                    提交计算
                  </button>
                )}
                {row.canRetry && (
                  <button className="link" type="button" disabled={working} onClick={() => onCalculate(row, 'single')}>
                    重试核算
                  </button>
                )}
                {row.canConfirm && (
                  <button className="link" type="button" disabled={working} onClick={() => onConfirm(row)}>
                    确认报告
                  </button>
                )}
                {row.canArchive && (
                  <button className="link" type="button" onClick={() => onArchive(row)}>
                    归档报告
                  </button>
                )}
                {row.status !== '已确认' && row.status !== '已归档' && (
                  <button className="link" type="button" disabled={working} onClick={() => startEdit(row)}>
                    调整输入
                  </button>
                )}
                {row.canRecalculateIdentity && (
                  <button className="link" type="button" disabled={working || !row.identity} onClick={() => onCalculate(row, 'identity')}>
                    同身份重算
                  </button>
                )}
              </td>
            </tr>
          ))}
          {empty && (
            <tr>
              <td className="empty-state" colSpan={COLUMNS.length + 5} data-testid="roi-empty">
                暂无ROI评估数据：可先登记ROI报告，或用「重置示例数据」恢复到样例
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>
          共 {workspace?.total ?? 0} 条ROI评估记录 · 核算身份 {identityGroups.length} 个 · 缓存按「身份 + 输入指纹 + 口径版本」命中
        </span>
      </footer>

      <section className="roi-panels">
        <div className="roi-panel">
          <h3>核算身份分组</h3>
          <p className="panel-desc">同身份共享 ROI 数值，但确认 / 归档状态逐份独立。</p>
          {identityGroups.length === 0 && <p className="empty-inline">暂无核算身份</p>}
          <ul className="identity-list">
            {identityGroups.map((group) => (
              <li key={group.identity}>
                <code>{group.label}</code>
                <span className="cell-muted">报告：{group.reportNos.join('、') || '—'}</span>
                <span className="cell-muted">
                  已确认：{group.confirmedCount} 份{group.confirmedReportNos.length > 0 ? `（${group.confirmedReportNos.join('、')}）` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="roi-panel">
          <h3>核算批次 / 确认记录</h3>
          <p className="panel-desc">失败与中断会保留原因；同一身份的并发确认按完成序号判定。</p>
          {batches.length === 0 && <p className="empty-inline">暂无批次记录</p>}
          <ul className="batch-list">
            {batches.map((batch) => (
              <li key={batch.id} data-batch={batch.id}>
                <div className="batch-head">
                  <code>{batch.id}</code>
                  <span className={`batch-status ${batch.status}`}>{BATCH_STATUS_LABEL[batch.status]}</span>
                  <span className="cell-muted">
                    {batch.kind === 'confirm' ? '确认' : batch.kind === 'recalculate' ? '同身份重算' : '核算'} · {batch.reportNos.join('、') || '—'}
                  </span>
                  <span className="cell-muted">{formatClock(batch.startedAt)}</span>
                </div>
                <div className="batch-meta">
                  {batch.affectedCount !== undefined && <span>影响 {batch.affectedCount} 份</span>}
                  {batch.reusedCount !== undefined && <span>复用 {batch.reusedCount} 份</span>}
                  {batch.recomputedCount !== undefined && <span>重算 {batch.recomputedCount} 份</span>}
                  {batch.completionSeq !== undefined && <span>完成序号 #{batch.completionSeq}</span>}
                </div>
                {batch.note && <span className="cell-muted">{batch.note}</span>}
                {batch.error && <span className="cell-warn">{batch.error}</span>}
                {(batch.status === 'failed' || batch.status === 'interrupted') && (
                  <button className="link" type="button" disabled={working} onClick={() => onRetryBatch(batch.id)}>
                    重试该批次
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </section>
  )
}
