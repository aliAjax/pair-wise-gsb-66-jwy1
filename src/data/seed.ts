import type { AuditEntry, Defect, GeometryMeasurement, TrackSegment } from '../types'

const measurements = (start: number, values: number[]): GeometryMeasurement[] => values.map((value, index) => ({
  id: `GM-${start + index * 200}`,
  mileage: start + index * 200,
  gauge: value,
  level: +(1.5 + Math.sin(index) * 1.1).toFixed(2),
  alignment: +(0.8 + Math.cos(index / 2) * .8).toFixed(2),
  twist: +(1.0 + Math.sin(index / 3) * .9).toFixed(2),
  measuredAt: `2026-09-${String(25 + Math.floor(index / 6)).padStart(2, '0')}T0${index % 6 + 2}:00:00`,
  detector: index % 2 ? 'GJ-6型轨检车' : '便携式激光测量仪'
}))

export const seedSegments: TrackSegment[] = [
  { id: 'SEG-K102', line: '京广上行 K102', startMileage: 102000, endMileage: 104800, speedLimit: 160, temporarySpeedLimit: 120, version: 4, measurements: measurements(102000, [1433, 1435, 1438, 1443, 1447, 1444, 1437, 1434, 1436, 1439, 1442, 1439, 1435, 1433]) },
  { id: 'SEG-K208', line: '沪昆下行 K208', startMileage: 208000, endMileage: 210600, speedLimit: 200, version: 3, measurements: measurements(208000, [1434, 1433, 1435, 1432, 1431, 1433, 1436, 1438, 1437, 1435, 1434, 1432, 1433, 1434]) }
]

export const seedDefects: Defect[] = [
  {
    id: 'GD-260929-01', segmentId: 'SEG-K102', mileage: 102800, type: '轨距', severity: '一级', measuredValue: 1447, limit: 1446, status: '整治中', owner: '工务一工区', discoveredAt: '2026-09-29T02:10:00', dueDate: '2026-09-29', version: 3,
    actions: [{ method: '捣固', note: '完成轨向调整，待复测轨距', operator: '李海', recordedAt: '2026-09-29T07:20:00' }], retests: []
  },
  {
    id: 'GD-260929-02', segmentId: 'SEG-K102', mileage: 103400, type: '高低', severity: '二级', measuredValue: 8.6, limit: 8.0, status: '待复测', owner: '工务一工区', discoveredAt: '2026-09-29T02:20:00', dueDate: '2026-09-30', version: 4,
    actions: [{ method: '打磨', note: '波磨处理完成', operator: '周旭', recordedAt: '2026-09-29T09:10:00' }],
    retests: [{ round: 1, passed: false, measuredValue: 8.4, limit: 8.0, note: '仍高于限值', tester: '王磊', testedAt: '2026-09-29T11:30:00' }]
  },
  {
    id: 'GD-260928-07', segmentId: 'SEG-K208', mileage: 209200, type: '三角坑', severity: '三级', measuredValue: 7.5, limit: 8.0, status: '已关闭', owner: '工务二工区', discoveredAt: '2026-09-28T03:00:00', dueDate: '2026-09-29', version: 5,
    actions: [{ method: '垫板调整', note: '调整连续三块垫板', operator: '陈伟', recordedAt: '2026-09-28T08:40:00' }],
    retests: [{ round: 1, passed: true, measuredValue: 6.8, limit: 8.0, note: '满足验收标准', tester: '魏强', testedAt: '2026-09-28T15:20:00' }]
  }
]

export const seedAudit: AuditEntry[] = [
  { id: 'A-1', entityId: 'SEG-K102', action: '导入检测数据', operator: 'GJ-6轨检车', detail: '导入K102+000至K104+800共14个采样点', createdAt: '2026-09-29T02:00:00' },
  { id: 'A-2', entityId: 'GD-260929-01', action: '批量派工', operator: '调度员 方林', detail: '超限点分配至工务一工区，要求24小时内整治', createdAt: '2026-09-29T04:15:00' },
  { id: 'A-3', entityId: 'GD-260929-02', action: '提交复测', operator: '王磊', detail: '第1轮复测未通过，重新进入整治', createdAt: '2026-09-29T11:30:00' }
]
