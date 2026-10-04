import {
  addMileage,
  appendArrivalRow,
  ensureMileageRow,
  findArrivalByTrip,
  getMileageRow,
  listArrivalRows,
  listRows,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  ArrivalOutcome,
  BatchArrivalResult,
  EntryRow,
} from '@/data/types'

// 摆渡车域服务：到站收尾只有这一个实现（finalizeArrival），
// 车上确认与后台批量两个入口都调它，里程、状态、幂等、回写维保台账都在这里收口。

// 车辆状态机：越级的一律挡回，消息里说明为什么。
const DISPATCH_FROM = ['待命']
const ARRIVE_FROM = ['执行中']
const MAINTAIN_FROM = ['待命', '充电中']

// 线路里程表：本趟里程的唯一来源，页面合计与导出都从这里算，天然一致。
const ROUTE_KM: Record<string, number> = {
  'T2航站楼—A岛远机位': 9.6,
  'T2航站楼—B岛远机位': 12.4,
  'T1航站楼—货运区': 6.8,
}
const DEFAULT_TRIP_KM = 10

const MILEAGE_FIELDS = new Set(['shuttle', 'vehmaint'])

function round1(value: number): number {
  return Number(value.toFixed(1))
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function todayText(): string {
  return nowText().slice(0, 10)
}

function tripMileageOf(row: EntryRow): number {
  const route = String(row['行驶路线'] ?? '')
  return ROUTE_KM[route] ?? DEFAULT_TRIP_KM
}

function findShuttle(id: number): { rows: EntryRow[]; index: number } {
  const rows = listRows('shuttle')
  return { rows, index: rows.findIndex((row) => Number(row.id) === id) }
}

function guardStatus(row: EntryRow, allowed: string[], action: string): string | null {
  const current = String(row.status)
  if (!allowed.includes(current)) {
    return `摆渡车「${row['车辆编号']}」当前是「${current}」，不能${action}（只允许${allowed.join('、')}），已挡回`
  }
  return null
}

/** 下一趟的趟次号：车辆编号 + 日期 + 该车第几趟，是到站幂等的业务键。 */
function nextTripNo(vehicleNo: string): string {
  const seq =
    listArrivalRows().filter((row) => String(row['车辆编号']) === vehicleNo).length + 1
  return `${vehicleNo}-${todayText().replace(/-/g, '')}-${String(seq).padStart(2, '0')}`
}

/**
 * 到站收尾的唯一实现。车上点「确认到站」和后台批量勾选都走这里：
 * 1. 同一趟已有到站记录 → 幂等返回，里程绝不再加一遍；
 * 2. 只有「执行中」能回到「待命」，其余状态挡回；
 * 3. 里程只累加一次，写进车辆里程台账（vehicle_mileage），
 *    特种车辆维保读到的就是这份台账，不再另存副本。
 */
export function finalizeArrival(id: number, entry: string): ArrivalOutcome {
  const { rows, index } = findShuttle(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的摆渡车` }
  }
  const row = rows[index]
  const vehicleNo = String(row['车辆编号'])
  const trip = String(row['当前趟次'] ?? '')

  // 幂等：这一趟已经收尾过（哪个入口点的都算），直接认账，不再动里程和状态。
  if (trip && findArrivalByTrip(trip)) {
    return {
      ok: true,
      message: `${vehicleNo} 的 ${trip} 已确认过到站，里程不重复累计`,
      trip,
      addedMileage: 0,
      duplicated: true,
    }
  }

  const rejected = guardStatus(row, ARRIVE_FROM, '确认到站')
  if (rejected) {
    return { ok: false, message: rejected }
  }

  const km = tripMileageOf(row)
  const tripNo = trip || nextTripNo(vehicleNo)
  const arrivedAt = nowText()

  // 1) 到站明细落库（持久化层按趟次再去一次重，双保险）。
  appendArrivalRow({
    id: 0,
    status: '已到站',
    pending: false,
    abnormal: false,
    趟次: tripNo,
    车辆编号: vehicleNo,
    驾驶员: String(row['驾驶员'] ?? ''),
    当前任务: String(row['当前任务'] ?? ''),
    发车时间: String(row['发车时间'] ?? ''),
    到站时间: arrivedAt,
    确认入口: entry,
    本趟里程: km,
  })

  // 2) 里程台账累加：全系统唯一的里程写入口，维保模块读的也是它。
  const ledger = addMileage(vehicleNo, km, tripNo, arrivedAt)

  // 3) 车辆回待命。当前趟次保留在档案上：同一趟再提交（哪个入口都行）
  //    会被开头的幂等检查拦下；下一次派发时才生成新趟次覆盖。
  const next = [...rows]
  next[index] = {
    ...row,
    status: '待命',
    pending: false,
    abnormal: false,
    当前趟次: tripNo,
    里程读数: ledger['里程读数'],
  }
  saveRows('shuttle', next)

  return {
    ok: true,
    message: `${vehicleNo} 已确认到站（${tripNo}），本趟 ${km} km，台账累计 ${ledger['里程读数']} km`,
    trip: tripNo,
    addedMileage: km,
    duplicated: false,
  }
}

/** 入口一：司机在车上点「确认到站」。 */
export function confirmArrival(id: number): ArrivalOutcome {
  return finalizeArrival(id, '车上确认')
}

/** 入口二：调度在后台批量勾选到站。与车上确认共用同一个 finalizeArrival。 */
export function batchConfirmArrivals(ids: number[]): BatchArrivalResult {
  const result: BatchArrivalResult = {
    ok: true,
    message: '',
    arrived: 0,
    duplicated: 0,
    rejected: [],
    addedMileage: 0,
  }
  for (const id of ids) {
    const outcome = finalizeArrival(id, '后台批量')
    if (!outcome.ok) {
      result.rejected.push(outcome.message)
      continue
    }
    if (outcome.duplicated) {
      result.duplicated += 1
      continue
    }
    result.arrived += 1
    result.addedMileage = round1(result.addedMileage + (outcome.addedMileage ?? 0))
  }
  result.ok = result.rejected.length === 0
  const parts = [
    `本次到站 ${result.arrived} 辆、累计里程 ${result.addedMileage} km`,
    result.duplicated > 0 ? `重复提交跳过 ${result.duplicated} 辆` : '',
    result.rejected.length > 0 ? `挡回 ${result.rejected.length} 辆：${result.rejected.join('；')}` : '',
  ].filter(Boolean)
  result.message = parts.join('；')
  return result
}

/** 派发任务：只有「待命」能进「执行中」，维保中、充电中的一律挡回。 */
export function dispatchShuttle(id: number): ActionResult {
  const { rows, index } = findShuttle(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的摆渡车` }
  }
  const rejected = guardStatus(rows[index], DISPATCH_FROM, '派发新任务')
  if (rejected) {
    return { ok: false, message: rejected }
  }
  const vehicleNo = String(rows[index]['车辆编号'])
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: '执行中',
    pending: true,
    abnormal: false,
    当前趟次: nextTripNo(vehicleNo),
    发车时间: todayText(),
  }
  saveRows('shuttle', next)
  return { ok: true, message: `摆渡车「${vehicleNo}」已派发任务，趟次 ${next[index]['当前趟次']}` }
}

/** 申请维保：执行中的车不能越级进维保，先跑完这一趟。 */
export function requestShuttleMaintenance(id: number): ActionResult {
  const { rows, index } = findShuttle(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的摆渡车` }
  }
  const rejected = guardStatus(rows[index], MAINTAIN_FROM, '申请维保')
  if (rejected) {
    return { ok: false, message: rejected }
  }
  const next = [...rows]
  next[index] = { ...rows[index], status: '维保中', pending: true, abnormal: false }
  saveRows('shuttle', next)
  return { ok: true, message: `摆渡车「${rows[index]['车辆编号']}」已转维保中` }
}

// ---- 里程读数：全系统只有台账一份，列表与导出读到这里统一注水 ----

/** 页面/导出读到某辆车时的里程口径：一律取台账；台账没有就按档案底数先建账。 */
export function mileageOf(vehicleNo: string): number | null {
  if (!vehicleNo) {
    return null
  }
  return Number(ensureMileageRow(vehicleNo)['里程读数'])
}

/** 给 shuttle / vehmaint 的行注水里程，两个模块、页面与导出看到的都是台账同一份。 */
export function hydrateMileage(key: string, rows: EntryRow[]): EntryRow[] {
  if (!MILEAGE_FIELDS.has(key)) {
    return rows
  }
  const shuttleFleet = new Set(listRows('shuttle').map((row) => String(row['车辆编号'] ?? '')))
  return rows.map((row) => {
    const vehicleNo = String(row['车辆编号'] ?? '')
    if (!vehicleNo) {
      return row
    }
    if (key === 'vehmaint' && !getMileageRow(vehicleNo) && !shuttleFleet.has(vehicleNo)) {
      // 台账和摆渡车档案里都没有这辆车（非摆渡车队），不强行建账，保持原样。
      return row
    }
    return { ...row, 里程读数: mileageOf(vehicleNo) ?? row['里程读数'] }
  })
}

// ---- 到站明细：页面合计与导出文件共用同一份数据、同一个合计函数 ----

export function listArrivals(): EntryRow[] {
  return listArrivalRows()
}

/** 到站里程合计：页面统计卡与导出文件的合计行都调这一个函数。 */
export function arrivalMileageTotal(): number {
  return round1(listArrivalRows().reduce((sum, row) => sum + Number(row['本趟里程'] ?? 0), 0))
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 到站明细按车辆编号打包成一份 CSV：逐车分组、逐车小计、末尾合计。 */
export function exportArrivalDetails(): { filename: string; content: string } {
  const arrivals = listArrivals()
  const byVehicle = new Map<string, EntryRow[]>()
  for (const row of arrivals) {
    const vehicleNo = String(row['车辆编号'] ?? '未登记')
    byVehicle.set(vehicleNo, [...(byVehicle.get(vehicleNo) ?? []), row])
  }
  const lines: string[] = [`摆渡车到站明细（按车辆编号打包）,导出时间,${csvCell(nowText())}`]
  for (const vehicleNo of [...byVehicle.keys()].sort()) {
    const group = byVehicle.get(vehicleNo) ?? []
    lines.push(`车辆编号,${csvCell(vehicleNo)},到站 ${group.length} 趟`)
    lines.push('趟次,当前任务,发车时间,到站时间,确认入口,本趟里程(km)')
    let subtotal = 0
    for (const row of group) {
      subtotal = round1(subtotal + Number(row['本趟里程'] ?? 0))
      lines.push(
        [row['趟次'], row['当前任务'], row['发车时间'], row['到站时间'], row['确认入口'], row['本趟里程']]
          .map(csvCell)
          .join(','),
      )
    }
    lines.push(`小计（${csvCell(vehicleNo)}）,,,,,${subtotal}`)
  }
  lines.push(`合计（全部车辆）,,,,,${arrivalMileageTotal()}`)
  return { filename: '摆渡车到站明细-按车辆编号.csv', content: `\uFEFF${lines.join('\n')}` }
}

export function downloadArrivalDetails(): void {
  const { filename, content } = exportArrivalDetails()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
