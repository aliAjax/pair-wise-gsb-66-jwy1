<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'
import type { Defect, RetestBatch } from '../types'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const crews = ['工务一工区复测班', '工务二工区复测班']
const crewTesters: Record<string, string> = { 工务一工区复测班: '王磊', 工务二工区复测班: '赵鹏' }
const retest = reactive({ crew: crews[0], round: 1, measuredValue: 0, tester: crewTesters[crews[0]], note: '' })
const message = ref('')

const roundOptions = computed(() => {
  if (!defect.value) return [1]
  const applied = defect.value.retests.filter((item) => !item.late).map((item) => item.round)
  const next = Math.max(0, ...applied) + 1
  return Array.from(new Set([1, ...applied, next])).sort((a, b) => a - b)
})

const defectBatches = computed<RetestBatch[]>(() =>
  store.batches.filter((batch) => batch.entries.some((entry) => entry.defectId === selectedId.value))
)

function syncRound() {
  const applied = defect.value?.retests.filter((item) => !item.late).map((item) => item.round) ?? []
  retest.round = Math.max(0, ...applied) + 1
  retest.measuredValue = Number((defect.value?.limit ?? 0).toFixed(1))
}

function selectDefect(id: string) {
  selectedId.value = id
  syncRound()
  message.value = ''
}

function switchCrew(crew: string) {
  retest.crew = crew
  retest.tester = crewTesters[crew] ?? retest.tester
}

function addAction() {
  if (!defect.value || !action.note) return
  store.addAction(defect.value.id, { ...action, method: action.method as any, recordedAt: new Date().toISOString() })
  action.note = ''
}

/** 班组补录复测值：先本地登记批次，断网时保留，恢复后自动重试提交 */
function submitRetestBatch() {
  if (!defect.value) return
  const limit = defect.value.limit
  const passed = retest.measuredValue <= limit
  const batch = store.enqueueRetestBatch([{
    defectId: defect.value.id,
    round: retest.round,
    passed,
    measuredValue: retest.measuredValue,
    limit,
    tester: retest.tester,
    crew: retest.crew,
    note: retest.note || (passed ? '复测合格（天窗补录）' : '仍超过限值（天窗补录）'),
    testedAt: new Date().toISOString()
  }], `${retest.crew} ${retest.tester}`)
  message.value = `批次${batch.id}已登记，将在网络可用时提交`
  retest.note = ''
  syncRound()
}

async function retry() {
  await store.flushBatches()
}

function onToggleOnline(value: boolean | null | undefined) {
  store.setOnline(Boolean(value))
}

function onToggleFlaky(value: boolean | null | undefined) {
  store.setFlaky(Boolean(value))
}

function onPickCrew(crew: string | null | undefined) {
  if (crew) switchCrew(crew)
}

function resolve(adopt: 'winner' | 'late') {
  if (!defect.value) return
  const result = store.resolveRecheck(defect.value.id, adopt)
  message.value = result.message
}

function closeDefect() {
  if (!defect.value) return
  message.value = store.transition(defect.value.id, '已关闭').message
}

function stateColor(state: RetestBatch['state']) {
  return state === '待提交' ? 'warning' : state === '待核对' ? 'error' : 'success'
}

function retestKey(item: Defect['retests'][number]) {
  return item.entryId ?? `legacy-${item.round}-${item.testedAt}`
}

syncRound()
</script>

<template>
  <section class="page">
    <div class="work-layout">
      <div class="work-list">
        <button v-for="item in store.defects" :key="item.id" :class="{ active: item.id === selectedId }" @click="selectDefect(item.id)">
          <span>{{ item.id }} · V{{ item.version }}</span><strong>{{ item.type }}超限</strong>
          <small>{{ item.owner }} · {{ item.status }}</small>
          <em v-if="item.recheck" class="recheck-flag">迟到记录待核对</em>
        </button>
      </div>
      <div v-if="defect" class="work-main">
        <div class="section-head">
          <div><span>{{ defect.segmentId }} · K{{ Math.floor(defect.mileage / 1000) }}+{{ String(defect.mileage % 1000).padStart(3, '0') }}</span>
            <h2>{{ defect.type }}缺陷整治</h2>
            <p>{{ defect.measuredValue }} / 限值 {{ defect.limit }} · {{ defect.severity }} · {{ defect.status }}</p>
          </div>
          <v-chip :color="defect.status === '已关闭' ? 'success' : defect.recheck ? 'error' : 'warning'">{{ defect.status }}</v-chip>
        </div>

        <div class="queue-band">
          <div class="queue-controls">
            <v-switch :model-value="store.online" density="compact" color="success" hide-details :label="store.online ? '驻地网络：在线' : '驻地网络：中断'" @update:model-value="onToggleOnline" />
            <v-switch :model-value="store.flaky" density="compact" color="warning" hide-details label="模拟写入抖动" @update:model-value="onToggleFlaky" />
            <v-btn size="small" variant="outlined" :disabled="!store.pendingBatches.length" @click="retry">立即重试</v-btn>
          </div>
          <div v-if="store.pendingBatches.length" class="queue-list">
            <div v-for="batch in store.pendingBatches" :key="batch.id" class="queue-item">
              <v-chip size="x-small" color="warning">{{ batch.state }}</v-chip>
              <span>{{ batch.id }} · {{ batch.operator }} · {{ batch.entries.length }}条 · 第{{ batch.attempts }}次尝试</span>
              <small v-if="batch.lastError">{{ batch.lastError }}</small>
            </div>
          </div>
          <small v-else class="queue-empty">无未完成批次，提交为原子事务：复测值、缺陷状态、区段限速同进同退</small>
        </div>

        <div class="offline-band"><strong>天窗补录批次</strong><span>两个班组各自补录同一轮复测值时，先到结论生效；迟到旧记录保留双方值，调度核对前缺陷与限速维持原状。</span></div>

        <div v-if="defect.recheck" class="recheck-panel">
          <h3>第{{ defect.recheck.round }}轮复测存在迟到记录（{{ defect.recheck.reason === '旧轮迟到' ? '旧轮补录' : '同轮冲突' }}），等待调度核对</h3>
          <div class="recheck-grid">
            <div class="recheck-card winner">
              <strong>先到结论（当前生效）</strong>
              <span>{{ defect.recheck.winner.crew }} · {{ defect.recheck.winner.tester }}</span>
              <b>{{ defect.recheck.winner.measuredValue }} / {{ defect.limit }} · {{ defect.recheck.winner.passed ? '合格' : '不合格' }}</b>
              <v-btn size="small" color="primary" @click="resolve('winner')">采纳先到值</v-btn>
            </div>
            <div class="recheck-card late">
              <strong>迟到记录（已冻结）</strong>
              <span>{{ defect.recheck.late.crew }} · {{ defect.recheck.late.tester }}</span>
              <b>{{ defect.recheck.late.measuredValue }} / {{ defect.limit }} · {{ defect.recheck.late.passed ? '合格' : '不合格' }}</b>
              <v-btn size="small" variant="outlined" @click="resolve('late')">改采纳迟到值</v-btn>
            </div>
          </div>
          <small>核对前缺陷维持「{{ defect.status }}」，区段临时限速不按迟到值重算；核对后两者一起重算。</small>
        </div>

        <div class="action-form">
          <v-select v-model="action.method" :items="['打磨', '捣固', '更换', '垫板调整', '测量复核']" label="整治方式" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.note" label="现场记录" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.operator" label="操作人" density="compact" variant="outlined" hide-details />
          <v-btn color="primary" :disabled="!action.note" @click="addAction">提交整治记录</v-btn>
        </div>
        <div class="retest-form">
          <v-select v-model="retest.crew" :items="crews" label="复测班组" density="compact" variant="outlined" hide-details @update:model-value="onPickCrew" />
          <v-select v-model.number="retest.round" :items="roundOptions" label="复测轮次" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="retest.measuredValue" type="number" label="复测值" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.tester" label="复测人" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.note" label="复测说明" density="compact" variant="outlined" hide-details />
          <v-btn color="secondary" @click="submitRetestBatch">补录复测批次</v-btn>
        </div>
        <div v-if="message" class="validation-message">{{ message }}</div>

        <div class="two-column">
          <div>
            <h3>整治记录</h3>
            <div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}</strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small></div>
          </div>
          <div>
            <h3>复测轮次（先到结论生效，迟到值保留）</h3>
            <div v-for="item in defect.retests" :key="retestKey(item)" class="record-item" :class="{ late: item.late }">
              <strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }}<v-chip v-if="item.late" size="x-small" color="error" class="late-chip">迟到待核对</v-chip><v-chip v-else size="x-small" color="success">生效</v-chip></strong>
              <span>{{ item.measuredValue }} / {{ item.limit }} · {{ item.crew ?? item.tester }}</span>
              <small>{{ item.tester }} · {{ item.note }}</small>
            </div>
          </div>
        </div>

        <div v-if="defectBatches.length" class="batch-history">
          <h3>本缺陷复测批次（可恢复提交）</h3>
          <div v-for="batch in defectBatches" :key="batch.id" class="batch-row">
            <v-chip size="small" :color="stateColor(batch.state)">{{ batch.state }}</v-chip>
            <span>{{ batch.id }} · {{ batch.operator }}</span>
            <small>尝试{{ batch.attempts }}次<template v-if="batch.appliedAt"> · 生效 {{ batch.appliedAt.replace('T', ' ').slice(0, 16) }}</template><template v-else-if="batch.lastError"> · {{ batch.lastError }}</template></small>
          </div>
        </div>

        <v-btn variant="outlined" :disabled="Boolean(defect.recheck)" @click="closeDefect">申请关闭缺陷</v-btn>
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
.recheck-flag { color: #a63e38; font-style: normal; font-size: 11px; font-weight: 700; }
.work-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head span { color: #807e7e; font-size: 11px; }.section-head h2 { margin: 4px 0; }.section-head p { margin: 0; color: #667573; }
.queue-band { border: 1px solid #d8cfa9; background: #fcf9ef; padding: 10px 12px; margin-bottom: 12px; display: grid; gap: 8px; }
.queue-controls { display: flex; align-items: center; gap: 14px; }
.queue-list { display: grid; gap: 6px; }
.queue-item { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.queue-item small { color: #a63e38; }
.queue-empty { color: #8a8268; }
.offline-band { display: flex; justify-content: space-between; padding: 11px; border-left: 3px solid #b08735; background: #fbf6e9; font-size: 12px; gap: 16px; }.offline-band span { color: #736d5b; }
.recheck-panel { border: 1px solid #c8836f; background: #fdf2ee; padding: 12px; margin: 12px 0; display: grid; gap: 10px; }
.recheck-panel h3 { margin: 0; font-size: 13px; color: #a63e38; }
.recheck-panel > small { color: #8a5c52; }
.recheck-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.recheck-card { border: 1px solid #d8b5a8; background: white; padding: 10px; display: grid; gap: 6px; }
.recheck-card.winner { border-color: #6f9a78; }
.recheck-card span, .recheck-card small { color: #6d7b79; font-size: 11px; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; }
.retest-form { display: grid; grid-template-columns: 170px 110px 110px 120px 1fr auto; gap: 10px; margin: 13px 0; align-items: center; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
.record-item.late { background: #fdf4f2; padding-left: 8px; border-left: 3px solid #c8836f; }
.late-chip { margin-left: 6px; }
.batch-history { margin: 14px 0; }.batch-history h3 { font-size: 13px; margin-bottom: 8px; }
.batch-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid #e2e7e7; font-size: 12px; }
.batch-row small { color: #738180; }
</style>
