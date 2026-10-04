<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { Defect, TrackSegment } from '../types'

const props = defineProps<{ segment?: TrackSegment; defects: Defect[] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const zoom = ref(1)
const selectedMileage = ref<number | null>(null)

function draw() {
  const element = canvas.value
  if (!element || !props.segment) return
  const ctx = element.getContext('2d')
  if (!ctx) return
  const ratio = window.devicePixelRatio || 1
  const width = element.clientWidth
  const height = 230
  element.width = width * ratio
  element.height = height * ratio
  ctx.scale(ratio, ratio)
  ctx.clearRect(0, 0, width, height)
  const padding = 38
  const trackY = 138
  ctx.fillStyle = '#f8faf9'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#9aa8a7'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(padding, trackY)
  ctx.lineTo(width - padding, trackY)
  ctx.stroke()
  for (let index = 0; index <= 10; index += 1) {
    const x = padding + (index / 10) * (width - padding * 2)
    ctx.beginPath(); ctx.moveTo(x, trackY - 8); ctx.lineTo(x, trackY + 8); ctx.stroke()
    ctx.fillStyle = '#657473'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'
    const mileage = props.segment.startMileage + index * (props.segment.endMileage - props.segment.startMileage) / 10
    ctx.fillText(`K${Math.floor(mileage / 1000)}+${String(mileage % 1000).padStart(3, '0')}`, x, trackY + 28)
  }
  const maxGauge = Math.max(...props.segment.measurements.map((item) => item.gauge))
  props.segment.measurements.forEach((point, index) => {
    const x = padding + (index / Math.max(props.segment!.measurements.length - 1, 1)) * (width - padding * 2)
    const y = 60 + (maxGauge - point.gauge) * 18
    ctx.strokeStyle = '#2e6678'; ctx.lineWidth = 2
    if (index) {
      const previous = props.segment!.measurements[index - 1]
      const px = padding + ((index - 1) / Math.max(props.segment!.measurements.length - 1, 1)) * (width - padding * 2)
      const py = 60 + (maxGauge - previous.gauge) * 18
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke()
    }
    ctx.fillStyle = point.gauge > 1446 ? '#b84239' : '#2e6678'
    ctx.beginPath(); ctx.arc(x, y, point.gauge > 1446 ? 4.5 : 3, 0, Math.PI * 2); ctx.fill()
  })
  props.defects.filter((item) => item.segmentId === props.segment!.id).forEach((defect) => {
    const x = padding + ((defect.mileage - props.segment!.startMileage) / (props.segment!.endMileage - props.segment!.startMileage)) * (width - padding * 2)
    ctx.fillStyle = defect.status === '已关闭' ? '#43876b' : '#b84239'
    ctx.beginPath(); ctx.moveTo(x, trackY - 18); ctx.lineTo(x - 7, trackY - 31); ctx.lineTo(x + 7, trackY - 31); ctx.closePath(); ctx.fill()
    ctx.fillStyle = '#334241'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(defect.type, x, trackY - 36)
  })
  if (selectedMileage.value !== null) {
    const x = padding + ((selectedMileage.value - props.segment.startMileage) / (props.segment.endMileage - props.segment.startMileage)) * (width - padding * 2)
    ctx.strokeStyle = '#b18b38'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, trackY + 8); ctx.stroke(); ctx.setLineDash([])
  }
}

function locate(event: MouseEvent) {
  if (!props.segment || !canvas.value) return
  const rect = canvas.value.getBoundingClientRect()
  const x = event.clientX - rect.left
  const ratio = Math.min(1, Math.max(0, (x - 38) / (rect.width - 76)))
  selectedMileage.value = Math.round(props.segment.startMileage + ratio * (props.segment.endMileage - props.segment.startMileage))
}

onMounted(() => { draw(); window.addEventListener('resize', draw) })
watch([() => props.segment, () => props.defects, zoom, selectedMileage], draw, { deep: true })
</script>

<template>
  <div class="canvas-panel">
    <div class="canvas-head">
      <div><strong>里程—轨距分布</strong><span v-if="selectedMileage">定位 K{{ Math.floor(selectedMileage / 1000) }}+{{ String(selectedMileage % 1000).padStart(3, '0') }}</span></div>
      <div><v-btn size="x-small" variant="outlined" @click="zoom = Math.max(.7, zoom - .1)">缩小</v-btn><v-btn size="x-small" variant="outlined" @click="zoom = Math.min(1.3, zoom + .1)">放大</v-btn></div>
    </div>
    <canvas ref="canvas" :style="{ transform: `scale(${zoom})`, transformOrigin: 'left center' }" @click="locate" />
    <div class="canvas-note">红点表示超限，三角标记表示缺陷；点击里程可定位到最近明细。</div>
  </div>
</template>
