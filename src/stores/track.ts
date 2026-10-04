import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'
import type {
  AuditEntry, Defect, DefectStatus, RectificationAction, RetestBatch, RetestBatchEntry,
  RetestResult, TrackSegment
} from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
let idSeed = 100

function uid(prefix: string) {
  idSeed += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeed}`
}

/** 纯数据深拷贝：经 JSON 往返脱掉 Vue 响应式代理（业务数据均可 JSON 序列化） */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 模拟驻地时断时续的网络：离线或抖动时“写入失败”，批次保留待重试 */
function networkWrite(online: { value: boolean }, flaky: { value: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!online.value) reject(new Error('网络不可用，批次已保留，将在恢复后重试'))
      else if (flaky.value && Math.random() < 0.5) reject(new Error('写入超时，批次已保留，稍后自动重试'))
      else resolve()
    }, 120 + Math.random() * 260)
  })
}

function normalizeDefect(raw: Defect): Defect {
  const defect = { ...raw, roundWinners: raw.roundWinners ?? {}, recheck: raw.recheck ?? null }
  // 旧版本数据迁移：历史复测没有 entryId/轮次结论表，按轮次首条回填为生效结论
  for (const record of defect.retests) {
    if (!record.entryId) record.entryId = `legacy:${defect.id}:r${record.round}:${record.testedAt}`
  }
  for (const record of defect.retests) {
    if (!defect.roundWinners[String(record.round)] && !record.late) {
      defect.roundWinners[String(record.round)] = record.entryId!
    }
  }
  return defect
}

function load() {
  const fallback = {
    segments: structuredClone(seedSegments),
    defects: seedDefects.map(normalizeDefect),
    audit: structuredClone(seedAudit),
    batches: [] as RetestBatch[],
    online: true
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return {
      segments: parsed.segments ?? fallback.segments,
      defects: (parsed.defects ?? fallback.defects).map(normalizeDefect),
      audit: parsed.audit ?? fallback.audit,
      batches: parsed.batches ?? [],
      online: parsed.online ?? true
    }
  } catch {
    return fallback
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const batches = ref<RetestBatch[]>(initial.batches)
  const online = ref(initial.online)
  /** 抖动开关：模拟恢复初期仍会超时写入失败 */
  const flaky = ref(false)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  let flushRunning = false

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingBatches = computed(() => batches.value.filter((item) => item.state === '待提交'))
  const recheckDefects = computed(() => defects.value.filter((item) => item.recheck))

  function addAudit(entityId: string, action: string, operator: string, detail: string, idempotencyKey?: string, createdAt?: string) {
    // 审计幂等：同一逻辑事件重复回放只保留第一条
    if (idempotencyKey && audit.value.some((item) => item.idempotencyKey === idempotencyKey)) return
    audit.value.unshift({
      id: uid('A'), idempotencyKey, entityId, action, operator, detail,
      createdAt: createdAt ?? new Date().toISOString()
    })
  }

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      defect.owner = owner
      defect.status = '整治中'
      defect.version += 1
      addAudit(id, '批量派工', '当前用户', `任务分配至${owner}`)
    }
  }

  function addAction(id: string, action: RectificationAction) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.actions.unshift(action)
    defect.status = '待复测'
    defect.version += 1
    addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const previous = defect.status
    defect.status = next
    defect.version += 1
    addAudit(id, `状态流转：${next}`, '当前用户', `由${previous}流转至${next}`)
    recalculateSegmentSpeed(defect.segmentId, '当前用户')
    return { ok: true, message: `已流转至${next}` }
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    const conflict = defects.value.some((item) => item.segmentId === id && item.status !== '已关闭' && item.severity === '一级')
    if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}`)
    return { ok: true, message: '区段速度版本已更新' }
  }

  /* ---------------- 复测批次：可恢复提交 ---------------- */

  /**
   * 登记复测批次。断网也先持久化（待提交），网络恢复后自动重试。
   * 一个批次可携带同一轮里同一班组的多条补录值。
   */
  function enqueueRetestBatch(entries: Array<Omit<RetestBatchEntry, 'entryId'>>, operator = '当前调度员'): RetestBatch {
    const now = new Date().toISOString()
    const batch: RetestBatch = {
      id: uid('RB'),
      entries: entries.map((entry) => ({ ...entry, entryId: uid('RE') })),
      state: '待提交',
      operator,
      createdAt: now,
      attempts: 0
    }
    batches.value.push(batch)
    addAudit(batch.id, '复测批次登记', operator, `批次含${batch.entries.length}条复测补录，等待网络提交`, `batch:${batch.id}:enqueue`, now)
    void flushBatches()
    return batch
  }

  function setOnline(value: boolean) {
    online.value = value
    if (value) void flushBatches()
  }

  function setFlaky(value: boolean) {
    flaky.value = value
    if (!value) void flushBatches()
  }

  /** 网络恢复 / 页面加载后串行重放所有未完成批次，避免交叉覆盖 */
  async function flushBatches() {
    if (flushRunning) return
    flushRunning = true
    try {
      while (true) {
        const batch = batches.value.find((item) => item.state === '待提交')
        if (!batch) break
        batch.attempts += 1
        try {
          await networkWrite(online, flaky)
        } catch (error) {
          // 写入失败：批次原样保留（仍为待提交），不留半套结果，等待下一次重试
          batch.lastError = error instanceof Error ? error.message : '写入失败'
          break
        }
        batch.lastError = undefined
        batch.submittedAt = new Date().toISOString()
        // 送达后同步原子提交；终态批次会被 confirmBatch 幂等短路
        const result = confirmBatch(batch.id)
        if (!result.ok) {
          batch.lastError = result.message
          break
        }
      }
    } finally {
      flushRunning = false
    }
  }

  function toRetest(entry: RetestBatchEntry, batchId: string, late = false): RetestResult {
    return {
      entryId: entry.entryId, batchId, round: entry.round, passed: entry.passed,
      measuredValue: entry.measuredValue, limit: entry.limit, note: entry.note,
      tester: entry.tester, crew: entry.crew, testedAt: entry.testedAt, late
    }
  }

  /**
   * 同步原子提交一个已送达批次（可安全重复回放）：
   * 1. 同一轮已有生效结论 -> 先到先得，迟到值双方保留挂待核对，调度确认前状态/限速不动；
   * 2. 首条记录生效；缺陷已有未决核对时，新值只登记不结论；
   * 3. 每条缺陷处理完，缺陷状态与所属区段临时限速在同一事务里一起重算；
   * 4. 全部条目落库后批次才进入终态；任一步失败整体回滚，不留半套结果；
   * 5. 审计全部带幂等键，重复回放不会多出审计记录。
   */
  function confirmBatch(batchId: string): { ok: boolean; message: string } {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.state === '已生效') return { ok: true, message: '批次已生效（重复回放已忽略）' }
    if (batch.state === '待核对') return { ok: true, message: '批次含迟到记录，已挂待核对' }

    const arrivedAt = new Date().toISOString()
    // 快照：任何校验失败时整体回滚，保证复测值/状态/限速同生共死
    const defectsSnapshot = snapshot(defects.value)
    const segmentsSnapshot = snapshot(segments.value)
    const auditSnapshot = snapshot(audit.value)
    const batchSnapshot = snapshot(batch)

    const touchedSegments = new Set<string>()
    let openedRecheck = false
    try {
      for (const entry of batch.entries) {
        const defect = defects.value.find((item) => item.id === entry.defectId)
        if (!defect) throw new Error(`缺陷${entry.defectId}不存在，批次整体回滚`)
        const winnerEntryId = defect.roundWinners[String(entry.round)]

        if (defect.recheck) {
          // 调度尚未核对：新送达的值只登记，不结论、不重算
          defect.retests.push(toRetest(entry, batch.id, true))
          touchedSegments.add(defect.segmentId)
          openedRecheck = true
          addAudit(defect.id, '复测值登记（待核对期间）', entry.tester,
            `第${entry.round}轮${entry.crew}补录值${entry.measuredValue}已保留，待调度核对既有争议`,
            `entry:${entry.entryId}:late`, arrivedAt)
          continue
        }

        if (winnerEntryId) {
          // 同轮先到结论已生效：迟到旧记录不能重开缺陷，双方值保留等核对
          const winner = defect.retests.find((item) => item.entryId === winnerEntryId)
          if (!winner) throw new Error(`第${entry.round}轮生效结论丢失，批次整体回滚`)
          const newerRound = Math.max(...defect.retests.filter((item) => !item.late).map((item) => item.round), 0) > entry.round
          defect.retests.push(toRetest(entry, batch.id, true))
          defect.recheck = {
            round: entry.round,
            reason: newerRound ? '旧轮迟到' : '同轮冲突',
            winner: {
              batchId: winner.batchId ?? '', entryId: winner.entryId ?? '',
              tester: winner.tester, crew: winner.crew ?? '', measuredValue: winner.measuredValue,
              passed: winner.passed, testedAt: winner.testedAt, arrivedAt: winner.testedAt
            },
            late: {
              batchId: batch.id, entryId: entry.entryId, tester: entry.tester, crew: entry.crew,
              measuredValue: entry.measuredValue, passed: entry.passed, testedAt: entry.testedAt, arrivedAt
            }
          }
          touchedSegments.add(defect.segmentId)
          openedRecheck = true
          addAudit(defect.id, '复测迟到·双方值待核对', entry.tester,
            `第${entry.round}轮先到结论（${winner.crew ?? winner.tester}：${winner.measuredValue}，${winner.passed ? '合格' : '不合格'}）维持生效；` +
            `迟到记录（${entry.crew} ${entry.tester}：${entry.measuredValue}）已保留，缺陷维持「${defect.status}」`,
            `entry:${entry.entryId}:recheck`, arrivedAt)
          continue
        }

        // 首条到达：成为本轮生效结论
        defect.retests.unshift(toRetest(entry, batch.id))
        defect.roundWinners[String(entry.round)] = entry.entryId
        defect.status = entry.passed ? '已关闭' : '复测不合格'
        defect.version += 1
        touchedSegments.add(defect.segmentId)
        addAudit(defect.id, '复测生效', entry.tester,
          `第${entry.round}轮先到结论生效：${entry.crew} ${entry.tester} 复测${entry.passed ? '合格，缺陷关闭' : `不合格，实测${entry.measuredValue}超限`}`,
          `entry:${entry.entryId}:apply`, arrivedAt)
      }

      // 缺陷状态与区段限速在同一提交里一起重算
      for (const segmentId of touchedSegments) {
        const frozen = defects.value.some((item) => item.segmentId === segmentId && item.recheck)
        if (frozen) {
          addAudit(segmentId, '区段限速冻结', '系统', '存在迟到复测待调度核对，临时限速维持现值不重算', `segment:${segmentId}:${batch.id}:freeze`, arrivedAt)
          continue
        }
        recalculateSegmentSpeed(segmentId, batch.operator, arrivedAt)
      }

      batch.arrivedAt = arrivedAt
      batch.appliedAt = new Date().toISOString()
      batch.state = openedRecheck ? '待核对' : '已生效'
      addAudit(batch.id, openedRecheck ? '批次提交完成（含待核对）' : '批次提交生效', batch.operator,
        openedRecheck ? '先到结论已生效，迟到值双方保留，等待调度核对后重算' : '复测值、缺陷状态与区段限速已一并提交',
        `batch:${batch.id}:commit`, arrivedAt)
      return { ok: true, message: openedRecheck ? '已提交：先到结论生效，迟到记录待核对' : '批次已整体生效' }
    } catch (error) {
      // 整体回滚：复测值、缺陷状态、限速、审计都不留半套
      defects.value = snapshot(defectsSnapshot)
      segments.value = snapshot(segmentsSnapshot)
      audit.value = snapshot(auditSnapshot)
      Object.assign(batch, snapshot(batchSnapshot))
      return { ok: false, message: error instanceof Error ? error.message : '提交失败，已整体回滚' }
    }
  }

  /**
   * 调度核对迟到记录：采纳一方后解除冻结，
   * 缺陷状态与区段限速按最终轮次结论一起重算。核对动作本身幂等。
   */
  function resolveRecheck(defectId: string, adopt: 'winner' | 'late', operator = '调度值班员'): { ok: boolean; message: string } {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (!defect.recheck) {
      const alreadyResolved = audit.value.some((item) => (item.idempotencyKey ?? '').startsWith(`recheck:${defectId}:`))
      return alreadyResolved
        ? { ok: true, message: '该核对已完成（重复提交已忽略）' }
        : { ok: false, message: '没有待核对记录' }
    }
    const pending = defect.recheck
    if (pending.resolvedAt) return { ok: true, message: '该核对已完成（重复提交已忽略）' }
    const key = `recheck:${defect.id}:${pending.round}`
    if (audit.value.some((item) => item.idempotencyKey === key)) return { ok: true, message: '该核对已生效（重复回放已忽略）' }

    const now = new Date().toISOString()
    const chosen = adopt === 'winner' ? pending.winner : pending.late
    const dropped = adopt === 'winner' ? pending.late : pending.winner

    defect.roundWinners[String(pending.round)] = chosen.entryId
    for (const record of defect.retests) {
      if (record.entryId === chosen.entryId) record.late = false
      if (record.entryId === dropped.entryId) record.late = true
    }
    // 以采纳方所在的最终生效轮次重算状态
    const latestWinnerEntryId = Object.entries(defect.roundWinners)
      .sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1]
    const latestWinner = defect.retests.find((item) => item.entryId === latestWinnerEntryId)
    defect.status = latestWinner?.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    pending.resolvedAt = now
    pending.adoptedEntryId = chosen.entryId
    defect.recheck = null
    addAudit(defect.id, '复测争议核对', operator,
      `第${pending.round}轮采纳${chosen.crew} ${chosen.tester} 的${chosen.measuredValue}（${chosen.passed ? '合格' : '不合格'}），` +
      `${dropped.crew}的${dropped.measuredValue}保留为历史值；缺陷状态与区段限速已重算`, key, now)
    recalculateSegmentSpeed(defect.segmentId, operator, now)

    // 该批次挂起的全部争议都核对完后，批次进入已生效
    for (const batch of batches.value) {
      if (batch.state !== '待核对') continue
      const stillPending = defects.value.some((item) => item.recheck && batch.entries.some((entry) =>
        entry.entryId === item.recheck?.winner.entryId || entry.entryId === item.recheck?.late.entryId))
      if (!stillPending && batch.entries.some((entry) => entry.entryId === chosen.entryId || entry.entryId === dropped.entryId)) {
        batch.state = '已生效'
        batch.appliedAt = now
      }
    }
    return { ok: true, message: `已采纳${chosen.crew}结论，状态与限速已重算` }
  }

  /**
   * 区段限速随缺陷状态重算（仅在复测/核对事务内调用）：
   * 存在未关闭一级缺陷 -> 保留更低的人工临时限速，否则压到正式限速以下；
   * 最后一个一级缺陷关闭 -> 解除临时限速。无变化时不递增版本、不写审计。
   * 有待核对争议的区段冻结，等调度核对后再重算。
   */
  function recalculateSegmentSpeed(segmentId: string, operator: string, now = new Date().toISOString()) {
    const segment = segments.value.find((item) => item.id === segmentId)
    if (!segment) return
    if (defects.value.some((item) => item.segmentId === segmentId && item.recheck)) return
    const openLevel1 = defects.value.filter((item) => item.segmentId === segmentId && item.status !== '已关闭' && item.severity === '一级')
    let requiredTemp: number | undefined
    if (openLevel1.length) {
      const fallback = segment.speedLimit - 40
      requiredTemp = segment.temporarySpeedLimit && segment.temporarySpeedLimit < segment.speedLimit
        ? Math.min(segment.temporarySpeedLimit, fallback)
        : fallback
    }
    if (requiredTemp === (segment.temporarySpeedLimit ?? undefined)) return
    const previous = segment.temporarySpeedLimit
    segment.temporarySpeedLimit = requiredTemp
    segment.version += 1
    addAudit(segmentId, '区段限速联动重算', operator,
      requiredTemp
        ? `${openLevel1.length}处一级缺陷未关闭，临时限速${previous ?? '无'} -> ${requiredTemp} km/h`
        : `一级缺陷全部关闭，解除临时限速（原${previous} km/h），恢复${segment.speedLimit} km/h`,
      `segment:${segmentId}:speed:${segment.version}`, now)
  }

  function reset() {
    segments.value = structuredClone(seedSegments)
    defects.value = structuredClone(seedDefects).map(normalizeDefect)
    audit.value = structuredClone(seedAudit)
    batches.value = []
    online.value = true
    flaky.value = false
  }

  watch(
    [segments, defects, audit, batches, online],
    () => localStorage.setItem(STORAGE_KEY, JSON.stringify({
      segments: segments.value, defects: defects.value, audit: audit.value,
      batches: batches.value, online: online.value
    })),
    { deep: true }
  )

  // 浏览器网络恢复后自动重放未完成批次
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { online.value = true; void flushBatches() })
  }
  void flushBatches()

  return {
    segments, defects, audit, batches, online, flaky, keyword, status,
    selectedSegmentId, filtered, selectedSegment, pendingBatches, recheckDefects,
    assign, addAction, transition, updateSegmentSpeed,
    enqueueRetestBatch, confirmBatch, flushBatches, resolveRecheck, setOnline, setFlaky, reset
  }
})
