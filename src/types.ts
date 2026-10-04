export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

/**
 * 复测批次状态机：
 * 待提交 -> 已送达 -> 已生效 / 待核对
 * 写入失败时停留在 待提交（lastError 记录原因），批次原样保留继续重试。
 * 已生效、待核对都是终态：重复回放按批次 id 与审计幂等键直接短路。
 */
export type BatchState = '待提交' | '已送达' | '已生效' | '待核对'

export interface GeometryMeasurement {
  id: string
  mileage: number
  gauge: number
  level: number
  alignment: number
  twist: number
  measuredAt: string
  detector: string
}

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  version: number
  measurements: GeometryMeasurement[]
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
}

export interface RetestResult {
  entryId?: string
  batchId?: string
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  crew?: string
  testedAt: string
  /** 迟到记录核对后补登的历史值，保留双方取值，但不参与生效结论 */
  late?: boolean
}

/** 一个班组在夜间天窗对一条缺陷补录的复测值 */
export interface RetestBatchEntry {
  entryId: string
  defectId: string
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  tester: string
  crew: string
  note: string
  testedAt: string
}

/** 同一轮复测的两个班组取值，核对面板需要双方的完整信息 */
export interface RecheckOption {
  batchId: string
  entryId: string
  tester: string
  crew: string
  measuredValue: number
  passed: boolean
  testedAt: string
  arrivedAt: string
}

/** 挂在缺陷上的待核对事项；核对完成前缺陷状态冻结，限速不按迟到值重算 */
export interface RecheckPending {
  round: number
  reason: '同轮冲突' | '旧轮迟到'
  winner: RecheckOption
  late: RecheckOption
  resolvedAt?: string
  adoptedEntryId?: string
}

export interface Defect {
  id: string
  segmentId: string
  mileage: number
  type: DefectType
  severity: Severity
  measuredValue: number
  limit: number
  status: DefectStatus
  owner: string
  discoveredAt: string
  dueDate: string
  actions: RectificationAction[]
  retests: RetestResult[]
  /** 每一轮的生效结论（先到先得）：round -> 生效条目 entryId */
  roundWinners: Record<string, string>
  /** 迟到记录待调度核对；存在期间状态维持确认前原样 */
  recheck: RecheckPending | null
  version: number
}

/**
 * 复测批次：复测值、缺陷状态、区段限速三者组成的可恢复提交单元。
 * 批次先本地持久化（断网也不丢），网络恢复后按创建顺序逐条重试；
 * 提交（confirmBatch）是同步原子且幂等的，重复回放不产生第二条审计。
 */
export interface RetestBatch {
  id: string
  entries: RetestBatchEntry[]
  state: BatchState
  operator: string
  createdAt: string
  submittedAt?: string
  arrivedAt?: string
  appliedAt?: string
  attempts: number
  lastError?: string
}

export interface AuditEntry {
  id: string
  /** 幂等键：同一逻辑事件重复回放时，只保留第一条审计 */
  idempotencyKey?: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
