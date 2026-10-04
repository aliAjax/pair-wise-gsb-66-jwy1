<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const retest = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const message = ref('')
const nextRound = computed(() => defect.value ? defect.value.retests.reduce((max, item) => Math.max(max, item.round), 0) + 1 : 1)
const defectBatches = computed(() => store.retestBatches.filter((item) => item.defectId === selectedId.value).slice().reverse())
const pendingBatches = computed(() => defectBatches.value.filter((item) => item.status === '待提交'))
const conflictBatches = computed(() => defectBatches.value.filter((item) => item.status === '待核对'))
function concludedValue(round: number) {
  return defect.value?.retests.find((item) => item.round === round)
}
function addAction() {
  if (!defect.value || !action.note) return
  store.addAction(defect.value.id, { ...action, method: action.method as any, recordedAt: new Date().toISOString() })
  action.note = ''
}
function addRetest() {
  if (!defect.value) return
  const result = store.submitRetestBatch(defect.value.id, {
    measuredValue: retest.measuredValue,
    note: retest.note || (retest.measuredValue <= defect.value.limit ? '复测合格' : '仍超过限值'),
    tester: retest.tester,
    testedAt: new Date().toISOString()
  })
  message.value = result.message
}
function retryFlush() {
  const result = store.flushRetestBatches()
  message.value = result.message
}
function resolve(batchId: string, adoptLate: boolean) {
  const result = store.resolveConflict(batchId, adoptLate)
  message.value = result.message
}
function closeDefect() {
  if (!defect.value) return
  const result = store.transition(defect.value.id, '已关闭')
  message.value = result.message
}
</script>

<template>
  <section class="page">
    <div class="work-layout">
      <div class="work-list">
        <button v-for="item in store.defects" :key="item.id" :class="{ active: item.id === selectedId }" @click="selectedId = item.id">
          <span>{{ item.id }} · V{{ item.version }}</span><strong>{{ item.type }}超限</strong><small>{{ item.owner }} · {{ item.status }}</small>
        </button>
      </div>
      <div v-if="defect" class="work-main">
        <div class="section-head"><div><span>{{ defect.segmentId }} · K{{ Math.floor(defect.mileage / 1000) }}+{{ String(defect.mileage % 1000).padStart(3, '0') }}</span><h2>{{ defect.type }}缺陷整治</h2><p>{{ defect.measuredValue }} / 限值 {{ defect.limit }} · {{ defect.severity }} · {{ defect.status }}</p></div><v-chip :color="defect.status === '已关闭' ? 'success' : 'warning'">{{ defect.status }}</v-chip></div>
        <div class="offline-band">
          <div><strong>离线补录模式</strong><span>复测值先写入批次队列，提交失败自动保留，网络恢复后继续重试；同一轮先到的结论生效。</span></div>
          <v-switch v-model="store.offline" color="warning" density="compact" hide-details label="模拟驻地网络中断" />
        </div>
        <div class="action-form">
          <v-select v-model="action.method" :items="['打磨', '捣固', '更换', '垫板调整', '测量复核']" label="整治方式" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.note" label="现场记录" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.operator" label="操作人" density="compact" variant="outlined" hide-details />
          <v-btn color="primary" :disabled="!action.note" @click="addAction">提交整治记录</v-btn>
        </div>
        <div class="action-form">
          <v-text-field v-model.number="retest.measuredValue" type="number" :label="`复测值（第${nextRound}轮）`" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.tester" label="复测人" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.note" label="复测说明" density="compact" variant="outlined" hide-details />
          <v-btn color="secondary" @click="addRetest">提交复测批次</v-btn>
        </div>
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div v-if="pendingBatches.length" class="batch-band pending">
          <div class="batch-head"><strong>待提交批次（{{ pendingBatches.length }}）</strong><v-btn size="small" color="primary" @click="retryFlush">立即重试</v-btn></div>
          <div v-for="item in pendingBatches" :key="item.id" class="record-item">
            <strong>{{ item.id }} · 第{{ item.round }}轮 · {{ item.measuredValue }} / {{ item.limit }}</strong>
            <span>{{ item.tester }} · 已尝试{{ item.attempts }}次</span>
            <small v-if="item.lastError">最近失败：{{ item.lastError }}，批次保留待重试</small>
          </div>
        </div>
        <div v-if="conflictBatches.length" class="batch-band conflict">
          <div class="batch-head"><strong>迟到记录待核对（{{ conflictBatches.length }}）</strong><span>调度确认前缺陷维持原状态</span></div>
          <div v-for="item in conflictBatches" :key="item.id" class="record-item">
            <strong>第{{ item.round }}轮 · 先达值 {{ concludedValue(item.round)?.measuredValue ?? '—' }}（{{ concludedValue(item.round)?.tester ?? '—' }}） ↔ 迟到值 {{ item.measuredValue }}（{{ item.tester }}）</strong>
            <span>双方值均已保留，核对后缺陷状态与区段限速一起重算</span>
            <div class="resolve-actions">
              <v-btn size="small" variant="outlined" @click="resolve(item.id, false)">维持先达结论</v-btn>
              <v-btn size="small" color="warning" @click="resolve(item.id, true)">采纳迟到值</v-btn>
            </div>
          </div>
        </div>
        <div class="two-column">
          <div><h3>整治记录</h3><div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}</strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small></div></div>
          <div><h3>复测轮次（已确认结论）</h3><div v-for="item in defect.retests" :key="item.round" class="record-item"><strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }}</strong><span>{{ item.measuredValue }} / {{ item.limit }}</span><small>{{ item.tester }} · {{ item.note }}<template v-if="item.batchId"> · {{ item.batchId }}</template></small></div></div>
        </div>
        <v-btn variant="outlined" @click="closeDefect">申请关闭缺陷</v-btn>
      </div>
    </div>
  </section>
</template>

<style scoped>
.work-layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.work-list { display: grid; gap: 8px; }
.work-list button { border: 1px solid #dae1e2; background: white; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; }
.work-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.work-list span, .work-list small { color: #738180; font-size: 11px; }
.work-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head span { color: #71807e; font-size: 11px; }.section-head h2 { margin: 4px 0; }.section-head p { margin: 0; color: #667573; }
.offline-band { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 11px; border-left: 3px solid #b08735; background: #fbf6e9; font-size: 12px; }.offline-band strong { display: block; }.offline-band span { color: #736d5b; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.batch-band { border: 1px solid #e0d3ae; background: #fdf9ee; padding: 12px; margin-bottom: 12px; }
.batch-band.conflict { border-color: #d8a13c; background: #fbf3e2; }
.batch-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }.batch-head span { color: #736d5b; font-size: 11px; }
.resolve-actions { display: flex; gap: 8px; margin-top: 8px; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
</style>
