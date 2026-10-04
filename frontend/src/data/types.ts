/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 单趟到站收尾的结果：在 ActionResult 上带出趟次、本次累计里程与是否幂等命中。 */
export type ArrivalOutcome = ActionResult & {
  trip?: string
  addedMileage?: number
  duplicated?: boolean
}

/** 后台批量勾选到站的汇总：新到站几辆、幂等跳过几辆、被挡回哪些。 */
export type BatchArrivalResult = {
  ok: boolean
  message: string
  arrived: number
  duplicated: number
  rejected: string[]
  addedMileage: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
