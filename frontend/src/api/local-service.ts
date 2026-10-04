import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commit,
  listArrivals,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import {
  dispatchTrip,
  finalizeArrivals,
  finalizeOne,
  roundMileage,
  toNumber,
} from '@/data/shuttle-domain'
import type {
  ActionResult,
  BatchArrivalResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TripArrival,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 里程口径：摆渡车里程表读数是唯一权威来源。
// 理由：里程读数由车辆每一趟行驶连续累计，实时、可与到站明细逐趟对账；
// 特种车辆维保的里程台账只在进厂/出厂等离散时点抄录，存在滞后与手工抄写误差
// （种子数据里 VEHM-0001 的 51980.0 就比里程表少 38.4 km）。
// 因此两处不一致时以摆渡车里程读数为准，到站收尾时把读数回写维保台账。
const VEHMAINT_LEDGER_FIELD = '台账里程'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/** 各车辆最新里程表读数：取自摆渡车里程读数（唯一权威来源）。 */
export function shuttleOdometerByVehicle(): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of listRows('shuttle')) {
    map.set(String(row['车辆编号'] ?? ''), roundMileage(toNumber(row['里程读数'])))
  }
  return map
}

/**
 * 维保记录读出时做台账对齐：台账里程一律以摆渡车里程表读数为准展示，
 * 保证「维保那边读到的里程」和摆渡车这边是同一份；车辆编号在摆渡车里不存在时保留台账原值。
 */
function withAuthoritativeMileage(rows: EntryRow[]): EntryRow[] {
  const odometers = shuttleOdometerByVehicle()
  return rows.map((row) => {
    const vehicleNo = String(row['车辆编号'] ?? '')
    const odometer = odometers.get(vehicleNo)
    if (odometer === undefined) {
      return row
    }
    return { ...row, [VEHMAINT_LEDGER_FIELD]: odometer }
  })
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = key === 'vehmaint' ? withAuthoritativeMileage(listRows(key)) : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// ---------------------------------------------------------------------------
// 摆渡车：到站收尾的两个入口（司机车上确认 / 调度后台批量勾选）共用同一份领域逻辑
// ---------------------------------------------------------------------------

function shuttleRow(id: number): EntryRow | undefined {
  return listRows('shuttle').find((row) => Number(row.id) === id)
}

/** 司机在车上点「确认到站」（单个入口）。收尾规则全部来自 shuttle-domain，本层不另写一套。 */
export function confirmShuttleArrival(id: number): ActionResult {
  const vehicle = shuttleRow(id)
  if (!vehicle) {
    return { ok: false, message: `没有找到编号为 ${id} 的摆渡车` }
  }
  // 先在快照上试算，rejected/duplicate 不落库，只有 arrived 才进事务。
  const preview = finalizeOne(vehicle, new Set(listArrivals().map((a) => a.tripId)), 'driver')
  if (preview.status !== 'arrived' || !preview.vehicle || !preview.arrival) {
    return {
      ok: preview.status === 'duplicate',
      kind: preview.status === 'duplicate' ? 'duplicate' : 'rejected',
      message: preview.message,
    }
  }
  commitArrivals([{ vehicle: preview.vehicle, arrival: preview.arrival }])
  return { ok: true, kind: 'arrived', message: preview.message }
}

/** 调度在后台批量勾选到站（批量入口）。与单个确认共用 finalizeArrivals，不允许第二份收尾。 */
export function batchConfirmShuttleArrivals(ids: number[]): BatchArrivalResult {
  const rows = listRows('shuttle')
  const vehicles = ids
    .map((id) => rows.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => Boolean(row))

  const { updatedVehicles, newArrivals, outcomes, mileageDelta } = finalizeArrivals(
    vehicles,
    listArrivals(),
    'dispatch',
  )

  if (newArrivals.length > 0) {
    commit((snapshot) => {
      // 1) 摆渡车：状态回待命 + 里程读数累加（在领域层算好，这里只负责落盘）
      const shuttle = snapshot.entries.shuttle.map((row) => {
        const updated = updatedVehicles.get(String(row['车辆编号'] ?? ''))
        return updated ?? row
      })
      snapshot.entries.shuttle = shuttle
      // 2) 到站明细落账：同一 tripId 只此一条，天然防重复累计
      snapshot.arrivals.push(...newArrivals)
      // 3) 回写特种车辆维保里程台账（同一份读数）
      applyMileageLedger(snapshot, newArrivals)
    })
  }

  const arrived = outcomes
    .filter((o) => o.status === 'arrived')
    .map((o) => ({
      vehicleNo: o.vehicleNo,
      distance: o.distance ?? 0,
      odometer: o.odometer ?? 0,
    }))
  const duplicates = outcomes
    .filter((o) => o.status === 'duplicate')
    .map((o) => ({ vehicleNo: o.vehicleNo, message: o.message }))
  const rejected = outcomes
    .filter((o) => o.status === 'rejected')
    .map((o) => ({ vehicleNo: o.vehicleNo, message: o.message }))

  const parts: string[] = []
  if (arrived.length > 0) {
    parts.push(`${arrived.length} 台到站，新增里程合计 ${mileageDelta.toFixed(1)} km`)
  }
  if (duplicates.length > 0) {
    parts.push(`${duplicates.length} 台本趟已结算，未重复累计`)
  }
  if (rejected.length > 0) {
    parts.push(`${rejected.length} 台被挡回`)
  }

  return {
    ok: rejected.length === 0,
    message: parts.length ? parts.join('；') : '没有可结算的车辆',
    arrived,
    duplicates,
    rejected,
    mileageDelta,
  }
}

/** 司机单入口的落库事务，与批量入口写同一组集合，保证两处收口一致。 */
function commitArrivals(
  items: { vehicle: EntryRow; arrival: TripArrival }[],
): void {
  commit((snapshot) => {
    for (const item of items) {
      const index = snapshot.entries.shuttle.findIndex(
        (row) => String(row['车辆编号'] ?? '') === item.arrival.vehicleNo,
      )
      if (index >= 0) {
        snapshot.entries.shuttle[index] = item.vehicle
      }
      snapshot.arrivals.push(item.arrival)
    }
    applyMileageLedger(
      snapshot,
      items.map((item) => item.arrival),
    )
  })
}

/**
 * 到站结论回写维保里程台账：把车辆最新里程读数写到该车辆的维保记录上。
 * 维保记录可以有多张（历史单/在修单），逐张更新为同一读数；没有维保单则只存在里程表上，
 * 维保页面读出时会再按摆渡车读数对齐，两边永远是同一份。
 */
function applyMileageLedger(snapshot: { entries: Record<string, EntryRow[]> }, arrivals: TripArrival[]): void {
  const latest = new Map<string, number>()
  for (const row of snapshot.entries.shuttle) {
    latest.set(String(row['车辆编号'] ?? ''), roundMileage(toNumber(row['里程读数'])))
  }
  const touchedVehicles = new Set(arrivals.map((a) => a.vehicleNo))
  snapshot.entries.vehmaint = snapshot.entries.vehmaint.map((record) => {
    const vehicleNo = String(record['车辆编号'] ?? '')
    if (!touchedVehicles.has(vehicleNo)) {
      return record
    }
    const odometer = latest.get(vehicleNo)
    if (odometer === undefined) {
      return record
    }
    return { ...record, [VEHMAINT_LEDGER_FIELD]: odometer }
  })
}

/** 派发任务：只有待命车辆能接新任务；维保中、充电中、执行中越级派单一律挡回。 */
export function dispatchShuttleTask(id: number): ActionResult {
  const vehicle = shuttleRow(id)
  if (!vehicle) {
    return { ok: false, message: `没有找到编号为 ${id} 的摆渡车` }
  }
  const outcome = dispatchTrip(vehicle)
  if (outcome.status !== 'arrived' || !outcome.vehicle) {
    return { ok: false, message: outcome.message }
  }
  saveRows(
    'shuttle',
    listRows('shuttle').map((row) => (Number(row.id) === id ? (outcome.vehicle as EntryRow) : row)),
  )
  return { ok: true, kind: 'arrived', message: outcome.message }
}

/** 申请维保：只有待命车辆允许进厂，执行中/充电中需先完成当前环节。 */
export function requestShuttleMaint(id: number): ActionResult {
  const vehicle = shuttleRow(id)
  if (!vehicle) {
    return { ok: false, message: `没有找到编号为 ${id} 的摆渡车` }
  }
  if (vehicle.status !== '待命') {
    return {
      ok: false,
      message: `车辆 ${String(vehicle['车辆编号'] ?? '')} 当前为「${vehicle.status}」，只有待命车辆能申请维保，已挡回`,
    }
  }
  const updated: EntryRow = { ...vehicle, status: '维保中', pending: false }
  saveRows(
    'shuttle',
    listRows('shuttle').map((row) => (Number(row.id) === id ? updated : row)),
  )
  return { ok: true, kind: 'arrived', message: `车辆 ${String(vehicle['车辆编号'] ?? '')} 已进入维保中` }
}

/** 摆渡车动作路由：本模块的状态判断不允许走通用 runAction 的简单置状态。 */
function runShuttleAction(id: number, action: string): ActionResult {
  if (action === '派发任务') {
    return dispatchShuttleTask(id)
  }
  if (action === '确认到站') {
    return confirmShuttleArrival(id)
  }
  if (action === '申请维保') {
    return requestShuttleMaint(id)
  }
  return { ok: false, message: `摆渡车没有登记「${action}」这个动作` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'shuttle') {
    return runShuttleAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// ---------------------------------------------------------------------------
// 到站明细：页面合计与导出文件共用同一个分组/合计函数，保证两份数字必然一致
// ---------------------------------------------------------------------------

export type ArrivalGroup = {
  vehicleNo: string
  items: TripArrival[]
  mileage: number
}

export function listArrivalGroups(filters: Record<string, string> = {}): {
  groups: ArrivalGroup[]
  totalMileage: number
  totalCount: number
} {
  const text = (filters['车辆编号'] ?? '').trim()
  const task = (filters['当前任务'] ?? '').trim()
  const driver = (filters['驾驶员'] ?? '').trim()
  const driverByVehicle = new Map<string, string>()
  for (const row of listRows('shuttle')) {
    driverByVehicle.set(String(row['车辆编号'] ?? ''), String(row['驾驶员'] ?? ''))
  }

  const arrivals = listArrivals().filter((arrival) => {
    if (text && !arrival.vehicleNo.includes(text)) return false
    if (task && !arrival.task.includes(task)) return false
    if (driver && !(driverByVehicle.get(arrival.vehicleNo) ?? '').includes(driver)) return false
    return true
  })

  const byVehicle = new Map<string, TripArrival[]>()
  for (const arrival of arrivals) {
    const list = byVehicle.get(arrival.vehicleNo) ?? []
    list.push(arrival)
    byVehicle.set(arrival.vehicleNo, list)
  }

  const groups: ArrivalGroup[] = [...byVehicle.entries()]
    .map(([vehicleNo, items]) => ({
      vehicleNo,
      items: [...items].sort((a, b) => a.arriveTime.localeCompare(b.arriveTime)),
      mileage: roundMileage(items.reduce((sum, item) => sum + item.distance, 0)),
    }))
    .sort((a, b) => a.vehicleNo.localeCompare(b.vehicleNo))

  return {
    groups,
    totalMileage: roundMileage(groups.reduce((sum, group) => sum + group.mileage, 0)),
    totalCount: arrivals.length,
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 按车辆编号打包成一份文件：每台车一个分组小节，末尾合计与页面合计同源。 */
export function exportArrivals(filters: Record<string, string> = {}): { filename: string; content: string } {
  const { groups, totalMileage, totalCount } = listArrivalGroups(filters)
  const lines: string[] = ['摆渡车到站明细（按车辆编号分组）']
  lines.push(`生成时间,${csvCell(new Date().toLocaleString('zh-CN'))}`)
  lines.push(`到站趟次合计,${totalCount}`)
  lines.push(`到站里程合计(km),${totalMileage.toFixed(1)}`)
  lines.push('')

  for (const group of groups) {
    lines.push(`车辆编号,${csvCell(group.vehicleNo)}`)
    lines.push(['任务', '发车时间', '到站时间', '本趟里程(km)', '到站后里程读数(km)', '提交入口'].join(','))
    for (const item of group.items) {
      lines.push(
        [
          csvCell(item.task),
          csvCell(item.departTime),
          csvCell(item.arriveTime),
          item.distance.toFixed(1),
          item.odometer.toFixed(1),
          item.source === 'driver' ? '司机车上确认' : '调度批量勾选',
        ].join(','),
      )
    }
    lines.push(`车辆里程小计(km),${group.mileage.toFixed(1)}`)
    lines.push('')
  }

  return {
    filename: `摆渡车到站明细-按车辆分组-${new Date().toISOString().slice(0, 10)}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

export function downloadCsv(filename: string, content: string): void {
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

export function downloadArrivals(filters: Record<string, string> = {}): void {
  const { filename, content } = exportArrivals(filters)
  downloadCsv(filename, content)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of listEntries(key).items) {
    lines.push(
      [row.id, ...meta.fields.map((field) => csvCell(row[field] ?? '')), csvCell(row.status)].join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadCsv(filename, content)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
