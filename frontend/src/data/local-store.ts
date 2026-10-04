import { SEED_ARRIVALS, SEED_ROWS } from './seed'
import type { EntryRow, TripArrival } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const ENTRIES_KEY = 'airport-ground-ops:entries'
const ARRIVALS_KEY = 'airport-ground-ops:shuttle-arrivals'
// 结构版本：旧版没有到站明细键、摆渡车里程是文本样例；版本不符就整体重新播种。
const SCHEMA_VERSION = 2
const VERSION_KEY = 'airport-ground-ops:schema-version'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type Database = {
  entries: Record<string, EntryRow[]>
  arrivals: TripArrival[]
}

function seedDatabase(): Database {
  return { entries: clone(SEED_ROWS), arrivals: clone(SEED_ARRIVALS) }
}

function persist(database: Database): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(ENTRIES_KEY, JSON.stringify(database.entries))
  window.localStorage.setItem(ARRIVALS_KEY, JSON.stringify(database.arrivals))
  window.localStorage.setItem(VERSION_KEY, String(SCHEMA_VERSION))
}

function readDatabase(): Database {
  const fallback = seedDatabase()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }

  // 旧版本（结构改造前播种的数据）：清掉旧键，按新结构重新播种。
  if (window.localStorage.getItem(VERSION_KEY) !== String(SCHEMA_VERSION)) {
    window.localStorage.removeItem(ENTRIES_KEY)
    window.localStorage.removeItem(ARRIVALS_KEY)
    persist(fallback)
    return fallback
  }

  const rawEntries = window.localStorage.getItem(ENTRIES_KEY)
  const rawArrivals = window.localStorage.getItem(ARRIVALS_KEY)

  let entries: Record<string, EntryRow[]> = fallback.entries
  if (rawEntries) {
    try {
      entries = { ...fallback.entries, ...(JSON.parse(rawEntries) as Record<string, EntryRow[]>) }
    } catch {
      entries = fallback.entries
    }
  }

  let arrivals: TripArrival[] = fallback.arrivals
  if (rawArrivals) {
    try {
      arrivals = JSON.parse(rawArrivals) as TripArrival[]
    } catch {
      arrivals = fallback.arrivals
    }
  }

  return { entries, arrivals }
}

let cache: Database | null = null

function db(): Database {
  if (cache === null) {
    cache = readDatabase()
  }
  return cache
}

/**
 * 事务提交：mutator 在同一份快照上改多个集合（摆渡车状态、里程、到站明细、维保台账），
 * 全部改完才整体落盘，避免出现「状态改了里程没改」这类半成品状态。
 */
export function commit(mutator: (snapshot: Database) => void): void {
  const snapshot = db()
  const draft: Database = {
    entries: Object.fromEntries(Object.entries(snapshot.entries).map(([k, v]) => [k, [...v]])),
    arrivals: [...snapshot.arrivals],
  }
  mutator(draft)
  cache = draft
  persist(draft)
}

export function allRows(): Record<string, EntryRow[]> {
  return db().entries
}

export function listRows(key: string): EntryRow[] {
  return db().entries[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit((snapshot) => {
    snapshot.entries[key] = rows
  })
}

export function listArrivals(): TripArrival[] {
  return db().arrivals
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 测试辅助：把整库恢复成种子数据。 */
export function resetDatabase(): void {
  const seeded = seedDatabase()
  cache = seeded
  persist(seeded)
}

export function storageKeys(): { entries: string; arrivals: string } {
  return { entries: ENTRIES_KEY, arrivals: ARRIVALS_KEY }
}
