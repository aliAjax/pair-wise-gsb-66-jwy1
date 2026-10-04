<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrackStore } from '../stores/track'

const store = useTrackStore()
const keyword = ref('')
const rows = computed(() => store.audit.filter((item) => `${item.entityId} ${item.action} ${item.operator} ${item.detail}`.includes(keyword.value)))
function exportReport() {
  const payload = { generatedAt: new Date().toISOString(), segments: store.segments, defects: store.defects, audit: store.audit }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '轨道几何整治报告.json'; anchor.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page audit-page">
    <div class="section-head"><div><h2>整治审计与版本追溯</h2><p>检测数据、批量派工、限速调整、离线补录和复测轮次全部留痕。</p></div><v-btn color="primary" @click="exportReport">导出整治报告</v-btn></div>
    <div class="toolbar single"><v-text-field v-model="keyword" density="compact" variant="outlined" hide-details prepend-inner-icon="mdi-magnify" placeholder="搜索实体、动作、操作人或说明" /><span>共{{ rows.length }}条</span></div>
    <v-table density="compact">
      <thead><tr><th>时间</th><th>实体</th><th>动作</th><th>操作人</th><th>说明</th><th>批次</th></tr></thead>
      <tbody><tr v-for="item in rows" :key="item.id"><td>{{ item.createdAt.replace('T', ' ').slice(0, 16) }}</td><td>{{ item.entityId }}</td><td>{{ item.action }}</td><td>{{ item.operator }}</td><td>{{ item.detail }}</td><td>{{ item.batchId ?? '—' }}</td></tr></tbody>
    </v-table>
  </section>
</template>

<style scoped>
.audit-page :deep(.v-table) { background: white; border: 1px solid #dae1e2; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head h2 { margin: 0 0 5px; font-size: 19px; }.section-head p { margin: 0; color: #71807e; font-size: 12px; }
.toolbar.single { display: grid; grid-template-columns: 420px auto; gap: 12px; margin-bottom: 10px; }.toolbar.single span { align-self: center; color: #71807e; font-size: 11px; }
</style>
