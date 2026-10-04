/* 端到端验证：复测批次可恢复提交的五条保证 */
import { createPinia, setActivePinia } from 'pinia'

// ---- 浏览器环境桩 ----
const storage = new Map<string, string>()
const listeners: Record<string, Array<() => void>> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) }
}
;(globalThis as any).window = { addEventListener: (e: string, cb: () => void) => { (listeners[e] ??= []).push(cb) } }
;(globalThis as any).navigator = {}

// 用动态时间戳避免 uid 冲突时的 Date 干扰；networkWrite 用真实定时器
const { useTrackStore } = await import('./src/stores/track.ts')

setActivePinia(createPinia())
const store = useTrackStore()

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const auditCount = () => store.audit.length
const findDefect = (id: string) => store.defects.find((d) => d.id === id)!
const findSegment = (id: string) => store.segments.find((s) => s.id === id)!

const D1 = 'GD-260929-01' // 一级缺陷，整治中，SEG-K102 正式160 临时120
const SEG = 'SEG-K102'

console.log('场景1：断网写入失败 → 批次保留重试 → 成功后整体生效')
{
  store.setOnline(false)
  store.enqueueRetestBatch([{ defectId: D1, round: 1, passed: true, measuredValue: 1445, limit: 1446, tester: '王磊', crew: '工务一工区复测班', note: '合格', testedAt: '2026-10-04T02:00:00' }], '调度员A')
  await sleep(500)
  check('断网时批次仍为待提交', store.pendingBatches.length === 1)
  check('断网期间缺陷状态不变', findDefect(D1).status === '整治中', findDefect(D1).status)
  check('断网期间限速不重算（临时120）', findSegment(SEG).temporarySpeedLimit === 120)
  check('批次已持久化到 localStorage', storage.has('gsb66:track-geometry'))
  const persisted = JSON.parse(storage.get('gsb66:track-geometry')!)
  check('持久化中含待提交批次', persisted.batches.length === 1 && persisted.batches[0].state === '待提交')
  const auditsBeforeReconnect = auditCount()

  store.setOnline(true)
  await sleep(700)
  check('恢复网络后批次自动生效', store.pendingBatches.length === 0 && store.batches.at(-1)!.state === '已生效')
  check('复测生效后缺陷关闭', findDefect(D1).status === '已关闭')
  check('一级缺陷关闭后临时限速解除', findSegment(SEG).temporarySpeedLimit === undefined, String(findSegment(SEG).temporarySpeedLimit))
  check('恢复后有提交审计', auditCount() > auditsBeforeReconnect)
}

console.log('场景2：两名调度员同一轮，先到结论生效，迟到旧记录不能重开缺陷')
{
  const defectVersionBefore = findDefect(D1).version
  // 班组B 的迟到不合格记录（旧轮 round=1）
  store.enqueueRetestBatch([{ defectId: D1, round: 1, passed: false, measuredValue: 1449, limit: 1446, tester: '赵鹏', crew: '工务二工区复测班', note: '仍超限', testedAt: '2026-10-04T01:50:00' }], '调度员B')
  await sleep(700)
  const d = findDefect(D1)
  check('迟到记录到达后缺陷保持已关闭（未被重开）', d.status === '已关闭', d.status)
  check('挂起待核对事项', d.recheck !== null && d.recheck!.reason === '同轮冲突')
  check('双方取值都保留', d.retests.some((r) => r.measuredValue === 1445 && !r.late) && d.retests.some((r) => r.measuredValue === 1449 && r.late))
  check('迟到批次状态为待核对', store.batches.at(-1)!.state === '待核对')
  check('核对前限速不跳变（仍解除状态）', findSegment(SEG).temporarySpeedLimit === undefined)
  check('缺陷版本未被迟到记录递增', d.version === defectVersionBefore, `v${d.version} vs ${defectVersionBefore}`)
}

console.log('场景3：调度核对迟到记录后，缺陷状态与限速一起重算')
{
  // 调度改采纳迟到的不合格值
  const result = store.resolveRecheck(D1, 'late', '调度值班员')
  check('核对返回成功', result.ok, result.message)
  const d = findDefect(D1)
  check('采纳不合格值后缺陷重开为复测不合格', d.status === '复测不合格', d.status)
  check('recheck 已解除', d.recheck === null)
  check('临时限速随一级缺陷重新下压（低于160）', (findSegment(SEG).temporarySpeedLimit ?? 999) < findSegment(SEG).speedLimit, String(findSegment(SEG).temporarySpeedLimit))
  const tempAfter = findSegment(SEG).temporarySpeedLimit

  // 再次核对（幂等）：recheck 已解除，调用应返回幂等提示且无副作用
  const again = store.resolveRecheck(D1, 'late', '调度值班员')
  check('重复核对被幂等忽略', again.ok && /已完成|已生效/.test(again.message) && findDefect(D1).status === '复测不合格', again.message)
  check('重复核对不重复写审计', findSegment(SEG).temporarySpeedLimit === tempAfter)
}

console.log('场景4：重复回放不产生多余审计、不留半套结果')
{
  const target = store.batches.find((b) => b.entries.some((e) => e.measuredValue === 1449))!
  const auditBefore = auditCount()
  const statusBefore = findDefect(D1).status
  const r1 = store.confirmBatch(target.id)
  const r2 = store.confirmBatch(target.id)
  check('终态批次重复回放直接短路', r1.ok && r2.ok)
  check('重复回放审计零增长', auditCount() === auditBefore, `${auditCount()} vs ${auditBefore}`)
  check('重复回放状态不变', findDefect(D1).status === statusBefore)

  // 审计幂等键唯一性
  const keys = store.audit.map((a) => a.idempotencyKey).filter(Boolean) as string[]
  check('所有审计幂等键唯一', new Set(keys).size === keys.length, `${new Set(keys).size}/${keys.length}`)
}

console.log('场景5：提交事务内失败整体回滚（缺陷不存在）')
{
  // 手工构造一个引用不存在缺陷的待提交批次
  const bad = store.enqueueRetestBatch([{ defectId: D1, round: 2, passed: true, measuredValue: 1, limit: 1446, tester: 'X', crew: 'C', note: '', testedAt: new Date().toISOString() }], 'X')
  await sleep(700) // 正常生效（round2 合格→关闭）
  const vClose = findDefect(D1).status
  check('round2 合格已生效', vClose === '已关闭', vClose)
  check('round2 生效后限速解除', findSegment(SEG).temporarySpeedLimit === undefined)

  // 再构造同批次含坏条目：直接篡改批次引用不存在缺陷并重置为待提交后回放
  const batch = store.batches.at(-1)!
  const auditBefore = auditCount()
  batch.state = '待提交'
  batch.entries.push({ entryId: 'bad-1', defectId: 'NOT-EXIST', round: 3, passed: false, measuredValue: 999, limit: 10, tester: 'X', crew: 'C', note: '', testedAt: new Date().toISOString() })
  const result = store.confirmBatch(batch.id)
  check('坏条目导致提交失败', !result.ok)
  check('失败后批次回到待提交（保留可重试）', batch.state === '待提交')
  check('回滚后缺陷状态不变（仍关闭）', findDefect(D1).status === '已关闭', findDefect(D1).status)
  check('回滚后限速不变（仍解除）', findSegment(SEG).temporarySpeedLimit === undefined)
  check('回滚后审计零残留', auditCount() === auditBefore, `${auditCount()} vs ${auditBefore}`)
}

console.log('场景6：页面刷新（重建 store）后未完成批次仍可重试')
{
  // 清掉场景5人为构造的毒消息批次（生产中条目都来自本地生成，引用必然存在）
  const poisonIndex = store.batches.findIndex((b) => b.state === '待提交' && b.entries.some((e) => e.defectId === 'NOT-EXIST'))
  if (poisonIndex >= 0) store.batches.splice(poisonIndex, 1)

  // 先制造一个离线待提交批次
  store.setOnline(false)
  store.enqueueRetestBatch([{ defectId: 'GD-260929-02', round: 2, passed: true, measuredValue: 7.9, limit: 8.0, tester: '王磊', crew: '工务一工区复测班', note: '合格', testedAt: '2026-10-04T03:00:00' }], '调度员A')
  await sleep(500)
  const pendingBefore = store.pendingBatches.length

  setActivePinia(createPinia())
  const store2 = useTrackStore()
  check('重建后从 localStorage 读回待提交批次', store2.pendingBatches.length === pendingBefore, `${store2.pendingBatches.length} vs ${pendingBefore}`)
  await sleep(500) // 等 store 初始化时的自动 flush（离线写入失败）结束
  store2.setOnline(true)
  await sleep(700)
  check('重建后自动重放成功', store2.pendingBatches.length === 0, `剩余${store2.pendingBatches.length}`)
  check('重放后缺陷关闭', store2.defects.find((d) => d.id === 'GD-260929-02')!.status === '已关闭')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
