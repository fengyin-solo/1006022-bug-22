import type { EntryRow, ShuttleArrivalOutcome, TripArrival } from './types'

/**
 * 摆渡车到站收尾的唯一领域逻辑（纯函数，不碰 localStorage）。
 *
 * 历史上「司机车上确认到站」和「调度后台批量勾选到站」各自实现了一套收尾：
 * 车上那套把状态改回了待命、漏了里程累加；后台那套里程加了两次、状态却停在执行中。
 * 现在两个入口都只能调用 finalizeArrivals，收尾规则只有这一份：
 *   1. 状态守卫：只有「执行中」的车能到站，待命/维保中/充电中一律挡回；
 *   2. 幂等：同一趟任务（车辆编号 + 当前任务 + 发车时间 构成 tripId）只结算一次，
 *      第二次提交（无论从哪个入口、来几次）里程不再累加；
 *   3. 原子性：状态回「待命」、里程读数累加、写到站明细三件事在同一次结算里一起发生。
 */

export const SHUTTLE_STATUSES = ['待命', '执行中', '充电中', '维保中'] as const
export const SHUTTLE_READY = '待命'
export const SHUTTLE_WORKING = '执行中'

export function tripIdOf(vehicle: EntryRow): string {
  return [
    String(vehicle['车辆编号'] ?? ''),
    String(vehicle['当前任务'] ?? ''),
    String(vehicle['发车时间'] ?? ''),
  ].join('|')
}

/** 安全解析里程读数；种子或手工数据里混进非数字时按 0 处理，不能把 NaN 写进台账。 */
export function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

/** 里程统一保留一位小数，页面合计、导出 CSV、维保台账看到的是同一个精度。 */
export function roundMileage(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10
}

/**
 * 本趟行驶里程：同一 tripId 永远得出同一个值。
 * 纯前端演示没有 GPS/里程表接口，用 tripId 做确定性推算，
 * 这样司机确认和调度批量勾选同一趟时算出来的里程必然一致。
 */
export function tripDistance(vehicle: EntryRow): number {
  const id = tripIdOf(vehicle)
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return roundMileage(5 + (hash % 350) / 10) // 5.0 ~ 39.9 km
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** 派发任务：只有待命的车能接新任务，维保中/充电中/执行中越级派单一律挡回。 */
export function dispatchTrip(vehicle: EntryRow, now: string = nowText()): ShuttleArrivalOutcome {
  const vehicleNo = String(vehicle['车辆编号'] ?? '')
  const task = String(vehicle['当前任务'] ?? '')
  const id = tripIdOf(vehicle)
  if (vehicle.status !== SHUTTLE_READY) {
    return {
      status: 'rejected',
      vehicleNo,
      task,
      tripId: id,
      message:
        vehicle.status === SHUTTLE_WORKING
          ? `车辆 ${vehicleNo} 正在执行任务，未到站前不能重复派单`
          : `车辆 ${vehicleNo} 当前为「${vehicle.status}」，只有待命车辆能派发新任务，已挡回`,
    }
  }
  const taskLabel = `摆渡任务#${now.replace(/[-: ]/g, '')}`
  return {
    status: 'arrived',
    vehicleNo,
    task: taskLabel,
    tripId: id,
    message: `车辆 ${vehicleNo} 已派发任务`,
    vehicle: {
      ...vehicle,
      status: SHUTTLE_WORKING,
      pending: true,
      abnormal: false,
      当前任务: taskLabel,
      发车时间: now,
    },
  }
}

/**
 * 单台车的到站收尾（幂等）。
 * @param vehicle 车辆当前快照
 * @param settled 已经结算过的 tripId 集合（由到站明细派生，持久化层注入）
 * @returns arrived = 本次完成收尾；duplicate = 同一趟重复提交，不再累计；rejected = 越级/状态不符
 */
export function finalizeOne(
  vehicle: EntryRow,
  settled: ReadonlySet<string>,
  source: 'driver' | 'dispatch',
): ShuttleArrivalOutcome {
  const vehicleNo = String(vehicle['车辆编号'] ?? '')
  const task = String(vehicle['当前任务'] ?? '')
  const tripId = tripIdOf(vehicle)

  // 守卫：车辆只能从「执行中」回到「待命」。
  // 已经是待命且这趟已结算 → 幂等命中（第二次点击走这里，里程绝不再加）；
  // 维保中/充电中或其他状态 → 越级操作，挡回。
  if (vehicle.status !== SHUTTLE_WORKING) {
    if (settled.has(tripId)) {
      return {
        status: 'duplicate',
        vehicleNo,
        task,
        tripId,
        message: `车辆 ${vehicleNo} 的「${task}」已到站结算过，里程不重复累计`,
      }
    }
    return {
      status: 'rejected',
      vehicleNo,
      task,
      tripId,
      message:
        vehicle.status === SHUTTLE_READY
          ? `车辆 ${vehicleNo} 已在待命，没有执行中的任务可到站`
          : `车辆 ${vehicleNo} 当前为「${vehicle.status}」，只能从执行中回到待命，已挡回`,
    }
  }

  // 执行中但这趟已经结算：理论上不该出现（结算成功即回待命），仍按幂等处理，杜绝双加。
  if (settled.has(tripId)) {
    return {
      status: 'duplicate',
      vehicleNo,
      task,
      tripId,
      message: `车辆 ${vehicleNo} 的「${task}」已到站结算过，里程不重复累计`,
    }
  }

  const distance = tripDistance(vehicle)
  const odometer = roundMileage(toNumber(vehicle['里程读数']) + distance)
  const arrival: TripArrival = {
    tripId,
    vehicleNo,
    task,
    departTime: String(vehicle['发车时间'] ?? ''),
    arriveTime: nowText(),
    distance,
    odometer,
    source,
  }

  // 一次结算里同时完成：状态回待命 + 里程累加 + 到站明细落账，缺一不可。
  const updated: EntryRow = {
    ...vehicle,
    status: SHUTTLE_READY,
    pending: false,
    abnormal: false,
    里程读数: odometer,
    lastSettledTrip: tripId,
  }

  return {
    status: 'arrived',
    vehicleNo,
    task,
    tripId,
    distance,
    odometer,
    vehicle: updated,
    arrival,
    message: `车辆 ${vehicleNo} 已到站：里程 +${distance} km，读数 ${odometer} km，状态回「待命」`,
  }
}

/**
 * 批量收尾：与单个确认共用 finalizeOne，没有第二份到站逻辑。
 * 入参顺序即页面勾选顺序；同一台车在一批里重复出现也只结算一次。
 */
export function finalizeArrivals(
  vehicles: EntryRow[],
  priorArrivals: readonly TripArrival[],
  source: 'driver' | 'dispatch',
): {
  updatedVehicles: Map<string, EntryRow>
  newArrivals: TripArrival[]
  outcomes: ShuttleArrivalOutcome[]
  mileageDelta: number
} {
  const settled = new Set(priorArrivals.map((item) => item.tripId))
  const updatedVehicles = new Map<string, EntryRow>()
  const newArrivals: TripArrival[] = []
  const outcomes: ShuttleArrivalOutcome[] = []
  let mileageDelta = 0

  for (const original of vehicles) {
    const vehicleNo = String(original['车辆编号'] ?? '')
    // 一批里同一台车被勾选了多次：后续行直接判重，保证「第二次点不许再加一遍」。
    const current = updatedVehicles.get(vehicleNo) ?? original
    const outcome = finalizeOne(current, settled, source)
    outcomes.push(outcome)
    if (outcome.status === 'arrived' && outcome.vehicle && outcome.arrival) {
      updatedVehicles.set(vehicleNo, outcome.vehicle)
      newArrivals.push(outcome.arrival)
      settled.add(outcome.tripId)
      mileageDelta = roundMileage(mileageDelta + (outcome.distance ?? 0))
    }
  }

  return { updatedVehicles, newArrivals, outcomes, mileageDelta }
}
