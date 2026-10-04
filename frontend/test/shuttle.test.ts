import assert from 'node:assert/strict'

import {
  SHUTTLE_WORKING,
  dispatchTrip,
  finalizeArrivals,
  finalizeOne,
  roundMileage,
  toNumber,
  tripDistance,
  tripIdOf,
} from '@/data/shuttle-domain'
import type { EntryRow, TripArrival } from '@/data/types'

// ---- 极简断言框架 ----------------------------------------------------------
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

function vehicle(partial: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 2,
    status: SHUTTLE_WORKING,
    pending: true,
    abnormal: false,
    车辆编号: 'SHUT-0002',
    核载人数: 45,
    驾驶员: '李航',
    当前任务: 'T2→卫星厅 摆渡#20261003091500',
    发车时间: '2026-10-03 09:15',
    行驶路线: 'T2航站楼 → 卫星厅',
    里程读数: 48860.0,
    车辆状态: '正常',
    ...partial,
  }
}

console.log('领域层：摆渡车到站收尾纯函数')

test('里程解析对脏数据回退为 0，且统一保留一位小数', () => {
  assert.equal(toNumber('abc'), 0)
  assert.equal(toNumber(undefined), 0)
  assert.equal(roundMileage(1.235), 1.2)
})

test('同一趟任务的里程推算确定且唯一（两个入口算出同一个数）', () => {
  const v = vehicle()
  const d1 = tripDistance(v)
  const d2 = tripDistance(v)
  assert.ok(d1 >= 5 && d1 < 40)
  assert.equal(d1, d2)
})

// ---- 幂等：同一趟重复提交只累计一次 ---------------------------------------
test('首次到站：状态回待命、里程累加、生成到站明细，一次完成', () => {
  const v = vehicle()
  const distance = tripDistance(v)
  const outcome = finalizeOne(v, new Set(), 'driver')
  assert.equal(outcome.status, 'arrived')
  assert.equal(outcome.vehicle?.status, '待命')
  assert.equal(outcome.vehicle?.['里程读数'], roundMileage(48860.0 + distance))
  assert.equal(outcome.arrival?.distance, distance)
  assert.equal(outcome.arrival?.source, 'driver')
})

test('第二次提交同一趟：判重，里程不再累加（司机入口）', () => {
  const v = vehicle()
  const first = finalizeOne(v, new Set(), 'driver')
  assert.equal(first.status, 'arrived')
  // 首次收尾后的车辆已经回到待命、读数已更新
  const second = finalizeOne(
    first.vehicle as EntryRow,
    new Set([tripIdOf(v)]),
    'driver',
  )
  assert.equal(second.status, 'duplicate')
  assert.equal(second.vehicle, undefined)
  assert.equal(second.arrival, undefined)
})

test('调度换个入口再提交同一趟：同样判重，里程绝不加第二遍', () => {
  const v = vehicle()
  const first = finalizeOne(v, new Set(), 'driver')
  const second = finalizeOne(
    first.vehicle as EntryRow,
    new Set([tripIdOf(v)]),
    'dispatch',
  )
  assert.equal(second.status, 'duplicate')
})

// ---- 状态守卫：只能从执行中回到待命 ---------------------------------------
test('维保中/充电中的车辆确认到站：越级挡回', () => {
  for (const status of ['维保中', '充电中']) {
    const outcome = finalizeOne(vehicle({ status }), new Set(), 'dispatch')
    assert.equal(outcome.status, 'rejected')
    assert.match(outcome.message, /挡回/)
  }
})

test('待命且没有结算记录的车辆确认到站：挡回（无执行中任务）', () => {
  const outcome = finalizeOne(vehicle({ status: '待命' }), new Set(), 'driver')
  assert.equal(outcome.status, 'rejected')
})

// ---- 批量入口与单个入口共用同一段收尾 -------------------------------------
test('批量收尾与单个确认同源：成功/判重/挡回混合时只结算成功的车', () => {
  const working = vehicle()
  const charging = vehicle({ id: 3, 车辆编号: 'SHUT-0003', status: '充电中' })
  // SHUT-0002 这趟此前已经结算过（模拟司机先点了一次）
  const settled: TripArrival[] = [
    {
      tripId: tripIdOf(working),
      vehicleNo: 'SHUT-0002',
      task: String(working['当前任务']),
      departTime: String(working['发车时间']),
      arriveTime: '2026-10-03 09:40',
      distance: tripDistance(working),
      odometer: roundMileage(48860.0 + tripDistance(working)),
      source: 'driver',
    },
  ]
  const { updatedVehicles, newArrivals, outcomes, mileageDelta } = finalizeArrivals(
    [working, charging],
    settled,
    'dispatch',
  )
  assert.equal(outcomes[0].status, 'duplicate') // 司机已结算 → 调度批量不再加
  assert.equal(outcomes[1].status, 'rejected') // 充电中 → 挡回
  assert.equal(newArrivals.length, 0)
  assert.equal(mileageDelta, 0)
  assert.equal(updatedVehicles.size, 0)
})

test('一批里同一台车被勾选两次：只结算一次', () => {
  const working = vehicle()
  const { newArrivals, mileageDelta, outcomes } = finalizeArrivals(
    [working, vehicle()],
    [],
    'dispatch',
  )
  assert.equal(newArrivals.length, 1)
  assert.equal(mileageDelta, tripDistance(working))
  assert.equal(outcomes[1].status, 'duplicate')
})

// ---- 派发任务守卫 ----------------------------------------------------------
test('派发任务：只有待命车辆能接单，维保中/充电中/执行中越级派单挡回', () => {
  const ready = vehicle({ status: '待命', 当前任务: '—', 发车时间: '—' })
  const ok = dispatchTrip(ready, '2026-10-04 08:00:00')
  assert.equal(ok.status, 'arrived')
  assert.equal(ok.vehicle?.status, '执行中')
  assert.match(String(ok.vehicle?.['当前任务']), /^摆渡任务#/)
  for (const status of ['维保中', '充电中', '执行中']) {
    const denied = dispatchTrip(vehicle({ status }))
    assert.equal(denied.status, 'rejected')
  }
})

console.log(`\n领域层：${passed} 通过，${failures.length} 失败`)
if (failures.length > 0) {
  process.exitCode = 1
}
