import assert from 'node:assert/strict'

// 在导入数据层之前准备 localStorage 内存桩，并清掉上一批测试可能残留的状态。
const memory = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
} as unknown as Window & typeof globalThis

const { resetDatabase } = await import('@/data/local-store')
resetDatabase()

const service = await import('@/api/local-service')
const { tripDistance } = await import('@/data/shuttle-domain')

let passed = 0
const failures: string[] = []
function test(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`  ✗ ${name}`)
    console.error(error instanceof Error ? `    ${error.message}` : error)
  }
}

function shuttleRows() {
  return service.listEntries('shuttle').items
}
function findVehicle(no: string) {
  const row = shuttleRows().find((r) => String(r['车辆编号']) === no)
  assert.ok(row, `种子数据中应存在 ${no}`)
  return row
}
function idOf(no: string) {
  return Number(findVehicle(no).id)
}

console.log('接口层 + 持久化层：两个到站入口共用收尾')

test('种子：SHUT-0002 执行中、里程读数 48860.0；SHUT-0004 维保中', () => {
  assert.equal(findVehicle('SHUT-0002').status, '执行中')
  assert.equal(findVehicle('SHUT-0002')['里程读数'], 48860.0)
  assert.equal(findVehicle('SHUT-0004').status, '维保中')
})

test('司机车上确认到站：状态回待命且里程读数累加（原车上入口漏里程的缺陷）', () => {
  const before = findVehicle('SHUT-0002')['里程读数'] as number
  const distance = tripDistance(findVehicle('SHUT-0002'))
  const result = service.confirmShuttleArrival(idOf('SHUT-0002'))
  assert.equal(result.ok, true, result.message)
  const after = findVehicle('SHUT-0002')
  assert.equal(after.status, '待命')
  assert.equal(after['里程读数'], Math.round((before + distance) * 10) / 10)
})

test('同一趟重复提交（司机再点一次）：里程不加第二遍，状态仍待命', () => {
  const readingBefore = findVehicle('SHUT-0002')['里程读数']
  const result = service.confirmShuttleArrival(idOf('SHUT-0002'))
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'duplicate')
  assert.equal(findVehicle('SHUT-0002')['里程读数'], readingBefore)
  assert.equal(findVehicle('SHUT-0002').status, '待命')
})

test('到站明细只落一条，里程与车辆读数一致；来源标记为司机', () => {
  const { groups, totalCount } = service.listArrivalGroups({ 车辆编号: 'SHUT-0002' })
  assert.equal(totalCount, 1)
  const item = groups[0].items[0]
  assert.equal(item.source, 'driver')
  assert.equal(item.odometer, findVehicle('SHUT-0002')['里程读数'])
})

test('调度批量勾选（跨入口重复提交同一趟）：判重，里程不翻倍（原后台双加缺陷）', () => {
  const readingBefore = findVehicle('SHUT-0002')['里程读数']
  const result = service.batchConfirmShuttleArrivals([idOf('SHUT-0002')])
  assert.equal(result.arrived.length, 0)
  assert.equal(result.duplicates.length, 1)
  assert.equal(result.mileageDelta, 0)
  assert.equal(findVehicle('SHUT-0002')['里程读数'], readingBefore)
  assert.equal(findVehicle('SHUT-0002').status, '待命')
})

test('维保中车辆越级派单：挡回；充电中越级派单：挡回', () => {
  const r1 = service.runAction('shuttle', idOf('SHUT-0004'), '派发任务')
  assert.equal(r1.ok, false)
  assert.match(r1.message, /挡回/)
  const r2 = service.runAction('shuttle', idOf('SHUT-0003'), '派发任务')
  assert.equal(r2.ok, false)
  assert.match(r2.message, /挡回/)
})

test('待命车辆派单成功后进入执行中；未到站再次派单被挡回', () => {
  const r1 = service.runAction('shuttle', idOf('SHUT-0002'), '派发任务')
  assert.equal(r1.ok, true, r1.message)
  assert.equal(findVehicle('SHUT-0002').status, '执行中')
  const r2 = service.runAction('shuttle', idOf('SHUT-0002'), '派发任务')
  assert.equal(r2.ok, false)
})

test('批量到站：执行中的车成功结算、维保中的车挡回；状态不再停在执行中', () => {
  const result = service.batchConfirmShuttleArrivals([idOf('SHUT-0002'), idOf('SHUT-0004')])
  assert.equal(result.arrived.length, 1)
  assert.equal(result.rejected.length, 1)
  assert.ok(result.mileageDelta > 0)
  assert.equal(findVehicle('SHUT-0002').status, '待命')
  assert.equal(findVehicle('SHUT-0004').status, '维保中')
})

test('同一趟批量重复勾选：第二批全部判重，里程合计为 0', () => {
  const again = service.batchConfirmShuttleArrivals([idOf('SHUT-0002'), idOf('SHUT-0002')])
  assert.equal(again.arrived.length, 0)
  assert.equal(again.duplicates.length, 2)
  assert.equal(again.mileageDelta, 0)
})

test('到站结论回写维保里程台账：VEHM-0003 的台账里程对齐 SHUT-0002 读数', () => {
  const odometer = findVehicle('SHUT-0002')['里程读数']
  const veh = service
    .listEntries('vehmaint')
    .items.find((r) => String(r['维保单号']) === 'VEHM-0003')
  assert.ok(veh)
  // 读出即权威值（与摆渡车里程读数同一份）
  assert.equal(veh!['台账里程'], odometer)
})

test('种子里的台账过期值（VEHM-0001 少 38.4km）以里程读数为准展示', () => {
  const veh = service
    .listEntries('vehmaint')
    .items.find((r) => String(r['维保单号']) === 'VEHM-0001')
  assert.equal(veh!['台账里程'], findVehicle('SHUT-0001')['里程读数'])
  assert.notEqual(veh!['台账里程'], 51980.0)
})

console.log('接口层 + 持久化层：导出一致性')

test('导出文件的里程合计与页面合计一致（按车辆编号分组，一份文件）', () => {
  const { groups, totalMileage, totalCount } = service.listArrivalGroups({})
  const { filename, content } = service.exportArrivals({})
  assert.match(filename, /^摆渡车到站明细-按车辆分组-/)
  for (const group of groups) {
    assert.ok(content.includes(`车辆编号,${group.vehicleNo}`), `文件应包含 ${group.vehicleNo} 分组`)
    assert.ok(content.includes(`车辆里程小计(km),${group.mileage.toFixed(1)}`))
  }
  assert.ok(content.includes(`到站里程合计(km),${totalMileage.toFixed(1)}`))
  assert.ok(content.includes(`到站趟次合计,${totalCount}`))
  // 页面合计 = 各分组小计之和 = 文件合计
  const sumOfGroups = Math.round(groups.reduce((s, g) => s + g.mileage, 0) * 10) / 10
  assert.equal(sumOfGroups, totalMileage)
})

test('筛选后导出与筛选后页面合计仍一致', () => {
  const filters = { 车辆编号: 'SHUT-0002' }
  const { totalMileage } = service.listArrivalGroups(filters)
  const { content } = service.exportArrivals(filters)
  assert.ok(content.includes(`到站里程合计(km),${totalMileage.toFixed(1)}`))
})

test('数据已持久化：localStorage 中同时写入 entries 与到站明细两个集合', () => {
  assert.ok(memory.has('airport-ground-ops:entries'))
  const arrivalsRaw = memory.get('airport-ground-ops:shuttle-arrivals')
  assert.ok(arrivalsRaw)
  const arrivals = JSON.parse(arrivalsRaw)
  const tripIds = arrivals.map((a: { tripId: string }) => a.tripId)
  assert.equal(new Set(tripIds).size, tripIds.length, 'tripId 不允许重复')
})

console.log(`\n接口层：${passed} 通过，${failures.length} 失败`)
if (failures.length > 0) {
  process.exitCode = 1
}
