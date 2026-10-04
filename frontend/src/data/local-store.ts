import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'

// 同一个仓库里的两个伪模块 key：
// - shuttle_arrivals：摆渡车到站明细，一趟一条，「趟次」是幂等键；
// - vehicle_mileage：车辆里程台账，一辆车一行，是里程读数的唯一权威副本。
// 摆渡车调度与特种车辆维保读到的里程都来自这张台账，不写第二份。
export const SHUTTLE_ARRIVALS_KEY = 'shuttle_arrivals'
export const VEHICLE_MILEAGE_KEY = 'vehicle_mileage'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---- 摆渡车到站明细：一趟一条，按「趟次」去重，是到站幂等的持久化兜底 ----

export function listArrivalRows(): EntryRow[] {
  return listRows(SHUTTLE_ARRIVALS_KEY)
}

export function findArrivalByTrip(trip: string): EntryRow | undefined {
  return listArrivalRows().find((row) => String(row['趟次']) === trip)
}

/** 追加一条到站明细；同一趟次已存在时直接返回旧记录，不重复落库。 */
export function appendArrivalRow(row: EntryRow): EntryRow {
  const trip = String(row['趟次'] ?? '')
  const existing = trip ? findArrivalByTrip(trip) : undefined
  if (existing) {
    return existing
  }
  const rows = listArrivalRows()
  const id =
    Number(row.id) > 0
      ? Number(row.id)
      : rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const stored = { ...row, id }
  saveRows(SHUTTLE_ARRIVALS_KEY, [...rows, stored])
  return stored
}

// ---- 车辆里程台账：里程读数的唯一权威副本，摆渡车调度与特种车辆维保共用 ----

export function getMileageRow(vehicleNo: string): EntryRow | undefined {
  return listRows(VEHICLE_MILEAGE_KEY).find((row) => String(row['车辆编号']) === vehicleNo)
}

function mileageBaseline(vehicleNo: string): number {
  const shuttleRow = listRows('shuttle').find((row) => String(row['车辆编号']) === vehicleNo)
  const baseline = Number(shuttleRow?.['里程读数'])
  return Number.isFinite(baseline) ? baseline : 0
}

/**
 * 读到某辆车的台账行；台账还没有就用摆渡车档案上的里程底数建一行。
 * 底数只在这一个地方取，先开哪个页面、先读哪个模块，建出来的台账都一样。
 */
export function ensureMileageRow(vehicleNo: string): EntryRow {
  const existing = getMileageRow(vehicleNo)
  if (existing) {
    return existing
  }
  const rows = listRows(VEHICLE_MILEAGE_KEY)
  const created: EntryRow = {
    id: rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status: '在册',
    pending: false,
    abnormal: false,
    车辆编号: vehicleNo,
    里程读数: mileageBaseline(vehicleNo),
    最近趟次: '',
    更新时间: '',
  }
  saveRows(VEHICLE_MILEAGE_KEY, [...rows, created])
  return created
}

/** 台账累加：到站收尾唯一的里程写入口，返回累加后的台账行。 */
export function addMileage(vehicleNo: string, km: number, trip: string, at: string): EntryRow {
  ensureMileageRow(vehicleNo)
  const rows = listRows(VEHICLE_MILEAGE_KEY).map((row) => {
    if (String(row['车辆编号']) !== vehicleNo) {
      return row
    }
    return {
      ...row,
      里程读数: Number((Number(row['里程读数']) + km).toFixed(1)),
      最近趟次: trip,
      更新时间: at,
    }
  })
  saveRows(VEHICLE_MILEAGE_KEY, rows)
  return rows.find((row) => String(row['车辆编号']) === vehicleNo) as EntryRow
}
