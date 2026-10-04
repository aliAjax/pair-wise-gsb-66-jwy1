import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'
import type { AuditEntry, Defect, DefectStatus, RectificationAction, RetestBatch, TrackSegment } from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
const OUTBOX_KEY = 'gsb66:retest-outbox'
let idSeed = 10

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { segments: seedSegments, defects: seedDefects, audit: seedAudit }
  } catch {
    return { segments: seedSegments, defects: seedDefects, audit: seedAudit }
  }
}

// 复测批次队列是本机待提交现场，独立于业务快照，断网也要落本地
function loadOutbox(): RetestBatch[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as RetestBatch[]
  } catch {
    return []
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const retestBatches = ref<RetestBatch[]>(loadOutbox())
  // 模拟夜间驻地时断时续的网络：开启后所有持久化写入都会失败
  const offline = ref(false)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingBatches = computed(() => retestBatches.value.filter((item) => item.status === '待提交'))

  function writeStorage() {
    if (offline.value) throw new Error('网络中断，写入失败')
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ segments: segments.value, defects: defects.value, audit: audit.value }))
  }

  function writeOutbox() {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(retestBatches.value))
  }

  function persistQuietly() {
    try { writeStorage() } catch { /* 离线期间业务数据由复测批次队列保留现场，恢复后重试 */ }
  }

  function persistOutbox() {
    try { writeOutbox() } catch { /* 本机存储不可用时队列仍留在内存 */ }
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

  // 复测值先入批次队列再提交：同一轮先到的结论生效，迟到记录保留双方值待核对
  function submitRetestBatch(defectId: string, input: { measuredValue: number; note: string; tester: string; testedAt: string; batchId?: string; round?: number }) {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    const id = input.batchId ?? `RB-${Date.now()}-${idSeed++}`
    if (!retestBatches.value.some((item) => item.id === id)) {
      const round = input.round ?? defect.retests.reduce((max, item) => Math.max(max, item.round), 0) + 1
      retestBatches.value.push({
        id, defectId, round,
        measuredValue: input.measuredValue,
        limit: defect.limit,
        note: input.note,
        tester: input.tester,
        testedAt: input.testedAt,
        createdAt: new Date().toISOString(),
        status: '待提交',
        attempts: 0
      })
      persistOutbox()
    }
    return flushRetestBatches()
  }

  function flushRetestBatches() {
    const pending = retestBatches.value.filter((item) => item.status === '待提交')
    if (!pending.length) return { ok: true, message: '没有待提交的复测批次' }
    let committed = 0
    let lastError = ''
    for (const batch of pending) {
      const result = commitBatch(batch)
      if (result.ok) committed += 1
      else { lastError = result.message; break }
    }
    const remaining = retestBatches.value.filter((item) => item.status === '待提交').length
    if (remaining) return { ok: false, message: `${lastError}，已提交${committed}批，剩余${remaining}批保留待重试` }
    return { ok: true, message: `已提交${committed}批复测` }
  }

  // 原子提交一个批次：缺陷、区段限速、审计一起落账；任何一步失败整体回滚，批次保留待重试
  function commitBatch(batch: RetestBatch) {
    const defect = defects.value.find((item) => item.id === batch.defectId)
    if (!defect) {
      batch.status = '已驳回'
      batch.lastError = '缺陷不存在'
      return { ok: false, message: `批次${batch.id}对应的缺陷不存在` }
    }
    // 幂等回放：该批次已落过审计，只同步状态，不再重复写入
    if (audit.value.some((item) => item.batchId === batch.id)) {
      batch.status = defect.retests.some((item) => item.batchId === batch.id) ? '已确认' : '待核对'
      batch.lastError = undefined
      return { ok: true, message: `批次${batch.id}已提交，跳过重复回放` }
    }
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    const snapshot = { defect: clone(defect), segment: segment ? clone(segment) : undefined, auditLength: audit.value.length }
    batch.attempts += 1
    try {
      const concluded = defect.retests.some((item) => item.round === batch.round)
      if (concluded) {
        // 同一轮已有先达结论：迟到记录留档待核对，缺陷维持原状态
        batch.status = '待核对'
        addAudit(defect.id, '迟到复测待核对', batch.tester, `第${batch.round}轮已有先达结论，迟到值${batch.measuredValue}/${batch.limit}保留待核对`, batch.id)
      } else {
        const passed = batch.measuredValue <= batch.limit
        defect.retests.unshift({ round: batch.round, passed, measuredValue: batch.measuredValue, limit: batch.limit, note: batch.note, tester: batch.tester, testedAt: batch.testedAt, batchId: batch.id })
        batch.status = '已确认'
        addAudit(defect.id, '提交复测', batch.tester, passed ? `第${batch.round}轮复测通过` : `第${batch.round}轮复测未通过`, batch.id)
        recalcDefectAndSegment(defect, segment, batch.id)
      }
      writeStorage()
      batch.lastError = undefined
      persistOutbox()
      return { ok: true, message: concluded ? `第${batch.round}轮已有先达结论，迟到记录待核对` : `批次${batch.id}提交成功` }
    } catch (error) {
      Object.assign(defect, snapshot.defect)
      if (segment && snapshot.segment) Object.assign(segment, snapshot.segment)
      audit.value.splice(0, audit.value.length - snapshot.auditLength)
      batch.status = '待提交'
      batch.lastError = error instanceof Error ? error.message : String(error)
      persistOutbox()
      return { ok: false, message: `批次${batch.id}写入失败：${batch.lastError}` }
    }
  }

  // 调度核对迟到记录：维持先达结论或采纳迟到值，缺陷状态与区段限速一起重算
  function resolveConflict(batchId: string, adoptLate: boolean, dispatcher = '调度员 方林') {
    const batch = retestBatches.value.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }
    if (batch.status !== '待核对') return { ok: false, message: '该批次已核对，不能重复处理' }
    const defect = defects.value.find((item) => item.id === batch.defectId)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    const snapshot = { defect: clone(defect), segment: segment ? clone(segment) : undefined, auditLength: audit.value.length }
    try {
      if (adoptLate) {
        const passed = batch.measuredValue <= batch.limit
        const late = { round: batch.round, passed, measuredValue: batch.measuredValue, limit: batch.limit, note: batch.note, tester: batch.tester, testedAt: batch.testedAt, batchId: batch.id }
        const index = defect.retests.findIndex((item) => item.round === batch.round)
        if (index >= 0) defect.retests.splice(index, 1, late)
        else defect.retests.unshift(late)
        batch.status = '已确认'
        addAudit(defect.id, '迟到复测核对：采纳迟到值', dispatcher, `第${batch.round}轮改采${batch.tester}的${batch.measuredValue}/${batch.limit}，缺陷与区段限速同步重算`, `${batch.id}:resolve`)
      } else {
        batch.status = '已驳回'
        addAudit(defect.id, '迟到复测核对：维持先达结论', dispatcher, `第${batch.round}轮迟到值${batch.measuredValue}/${batch.limit}已留档，维持先达结论`, `${batch.id}:resolve`)
      }
      recalcDefectAndSegment(defect, segment, `${batch.id}:resolve`)
      writeStorage()
      persistOutbox()
      return { ok: true, message: adoptLate ? '已采纳迟到值，缺陷状态与区段限速已重算' : '已维持先达结论，迟到值留档' }
    } catch (error) {
      Object.assign(defect, snapshot.defect)
      if (segment && snapshot.segment) Object.assign(segment, snapshot.segment)
      audit.value.splice(0, audit.value.length - snapshot.auditLength)
      batch.status = '待核对'
      persistOutbox()
      return { ok: false, message: `核对写入失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // 缺陷状态由已确认复测结论推导；区段临时限速随一级缺陷开闭联动重算
  function recalcDefectAndSegment(defect: Defect, segment: TrackSegment | undefined, batchId: string) {
    const latest = defect.retests.reduce((top, item) => (item.round > (top?.round ?? 0) ? item : top), defect.retests[0])
    let next: DefectStatus = defect.status
    if (latest) next = latest.passed ? '已关闭' : '复测不合格'
    else if (defect.actions.length) next = '待复测'
    if (next !== defect.status) {
      addAudit(defect.id, `状态流转：${next}`, '系统', `复测批次提交后由${defect.status}重算为${next}`, batchId)
      defect.status = next
      defect.version += 1
    }
    if (!segment) return
    const hasOpenPrimary = defects.value.some((item) => item.segmentId === segment.id && item.severity === '一级' && item.status !== '已关闭')
    const before = segment.temporarySpeedLimit
    if (hasOpenPrimary) {
      if (!segment.temporarySpeedLimit || segment.temporarySpeedLimit >= segment.speedLimit) segment.temporarySpeedLimit = Math.max(45, segment.speedLimit - 40)
    } else {
      segment.temporarySpeedLimit = undefined
    }
    if (before !== segment.temporarySpeedLimit) {
      segment.version += 1
      addAudit(segment.id, '区段限速联动重算', '系统', `一级缺陷${hasOpenPrimary ? '未关闭' : '已全部关闭'}，临时限速${before ?? '无'}→${segment.temporarySpeedLimit ?? '取消'}`, batchId)
    }
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const prev = defect.status
    defect.status = next
    defect.version += 1
    addAudit(id, `状态流转：${next}`, '当前用户', `由${prev}流转至${next}`)
    return { ok: true, message: `已流转至${next}` }
  }

  // 同一批次同一动作只写一条审计，重复回放不会多出记录
  function addAudit(entityId: string, action: string, operator: string, detail: string, batchId?: string) {
    if (batchId && audit.value.some((item) => item.batchId === batchId && item.action === action)) return
    audit.value.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString(), batchId })
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

  function reset() {
    segments.value = structuredClone(seedSegments)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    retestBatches.value = []
  }

  watch([segments, defects, audit], persistQuietly, { deep: true })
  watch(retestBatches, persistOutbox, { deep: true })

  // 启动时恢复上次未完成的批次，继续重试提交
  if (pendingBatches.value.length) flushRetestBatches()

  return { segments, defects, audit, retestBatches, offline, keyword, status, selectedSegmentId, filtered, selectedSegment, pendingBatches, assign, addAction, submitRetestBatch, flushRetestBatches, resolveConflict, transition, updateSegmentSpeed, reset }
})
