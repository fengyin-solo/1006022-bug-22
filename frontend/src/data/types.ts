/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryValue = string | number | boolean | null

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: EntryValue
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
  /** duplicate = 命中幂等、未重复写数据；rejected = 越级/状态不符被挡回；缺省为普通成功或失败 */
  kind?: 'arrived' | 'duplicate' | 'rejected'
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 摆渡车一趟任务：从派发到确认到站之间，里程只允许结算一次。 */
export type TripArrival = {
  /** 幂等键：同一车辆同一趟任务（当前任务 + 发车时间）只有一条到站明细。 */
  tripId: string
  vehicleNo: string
  task: string
  departTime: string
  /** 到站时间，由收尾逻辑在首次结算时写入；重复提交不再覆盖。 */
  arriveTime: string
  /** 本趟新增里程（公里），只在首次到站时累计一次。 */
  distance: number
  /** 到站结算后车辆里程表读数（公里），也是回写维保里程台账的口径。 */
  odometer: number
  /** 首次提交入口：司机车上确认 / 调度后台批量勾选。 */
  source: 'driver' | 'dispatch'
}

/** 单台车一次到站结算的领域结果（纯函数产物，不含持久化）。 */
export type ShuttleArrivalOutcome = {
  status: 'arrived' | 'duplicate' | 'rejected'
  vehicleNo: string
  task: string
  tripId: string
  message: string
  distance?: number
  odometer?: number
  vehicle?: EntryRow
  arrival?: TripArrival
}

/** 后台批量勾选到站的汇总结果：两个入口共用同一份收尾逻辑。 */
export type BatchArrivalResult = ActionResult & {
  arrived: { vehicleNo: string; distance: number; odometer: number }[]
  duplicates: { vehicleNo: string; message: string }[]
  rejected: { vehicleNo: string; message: string }[]
  /** 本批首次结算的里程合计；重复提交不重复计入。 */
  mileageDelta: number
}
