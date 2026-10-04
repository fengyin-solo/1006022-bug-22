// 到站收尾的端到端验证：两个入口共用同一实现、幂等、状态机门禁、台账一致性。
import {
  exportEntries,
  listEntries,
  runAction,
} from '@/api/local-service'
import {
  arrivalMileageTotal,
  batchConfirmArrivals,
  exportArrivalDetails,
  listArrivals,
} from '@/api/shuttle-service'
import { getMileageRow, listRows, saveRows } from '@/data/local-store'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}`, detail ?? '')
  }
}

function shuttleRow(id: number) {
  return listEntries('shuttle').items.find((row) => Number(row.id) === id)
}

// A. 初始读数：页面读到的是台账注水后的一致口径
check('A1 初始里程注水=档案底数', Number(shuttleRow(1)?.['里程读数']) === 1280.5, shuttleRow(1))
check('A2 台账已按底数建账', Number(getMileageRow('SHUT-0001')?.['里程读数']) === 1280.5)

// B. 派发：待命→执行中；执行中再派、充电中派车都挡回
const dispatch1 = runAction('shuttle', 1, '派发任务')
check('B1 待命车派发成功', dispatch1.ok && shuttleRow(1)?.status === '执行中', dispatch1)
check('B2 派发生成趟次', String(shuttleRow(1)?.['当前趟次'] ?? '').startsWith('SHUT-0001-'))
check('B3 执行中再派被挡回', !runAction('shuttle', 1, '派发任务').ok)
check('B4 充电中派新任务被挡回', !runAction('shuttle', 3, '派发任务').ok)
check('B5 执行中申请维保被挡回', !runAction('shuttle', 1, '申请维保').ok)

// C. 入口一：车上确认到站——状态回待命且里程累加
const arrive1 = runAction('shuttle', 1, '确认到站')
check('C1 车上确认到站成功', arrive1.ok, arrive1)
check('C2 状态回待命', shuttleRow(1)?.status === '待命')
check('C3 里程累加 1280.5+9.6=1290.1', Number(shuttleRow(1)?.['里程读数']) === 1290.1, shuttleRow(1)?.['里程读数'])
check('C4 台账同步为 1290.1', Number(getMileageRow('SHUT-0001')?.['里程读数']) === 1290.1)
check('C5 到站明细落一条', listArrivals().length === 1, listArrivals())

// D. 同一趟重复提交：第二次不许再加里程
const again = runAction('shuttle', 1, '确认到站')
check('D1 重复提交幂等返回成功', again.ok, again)
check('D2 里程没有再加', Number(getMileageRow('SHUT-0001')?.['里程读数']) === 1290.1)
check('D3 明细仍只有一条', listArrivals().length === 1)

// E. 入口二：后台批量勾选——与入口一共用同一收尾
const batch = batchConfirmArrivals([1, 2, 3])
check('E1 批量里已到站的幂等跳过', batch.duplicated === 1, batch)
check('E2 批量新到站一辆', batch.arrived === 1 && Number(batch.addedMileage) === 12.4, batch)
check('E3 充电中被挡回', batch.rejected.length === 1 && !batch.ok, batch)
check('E4 车2状态回待命', shuttleRow(2)?.status === '待命')
check('E5 车2里程 864+12.4=876.4', Number(getMileageRow('SHUT-0002')?.['里程读数']) === 876.4)
const batchAgain = batchConfirmArrivals([2, 2])
check('E6 批量重复提交不再累计', batchAgain.arrived === 0 && batchAgain.duplicated === 2 && batchAgain.addedMileage === 0, batchAgain)
check('E7 里程纹丝不动', Number(getMileageRow('SHUT-0002')?.['里程读数']) === 876.4)

// F. 页面合计与导出合计一致
const total = arrivalMileageTotal()
check('F1 页面合计=9.6+12.4=22', total === 22, total)
const csv = exportArrivalDetails().content
check('F2 导出按车辆编号分组', csv.includes('车辆编号,SHUT-0001') && csv.includes('车辆编号,SHUT-0002'))
check('F3 导出小计正确', csv.includes('小计（SHUT-0001）,,,,,9.6') && csv.includes('小计（SHUT-0002）,,,,,12.4'), csv)
check('F4 导出合计=页面合计', csv.includes(`合计（全部车辆）,,,,,${total}`))

// G. 维保模块读到同一份里程
const maintRow = listEntries('vehmaint').items.find((row) => String(row['车辆编号']) === 'SHUT-0001')
check('G1 维保页里程=台账同一份', Number(maintRow?.['里程读数']) === 1290.1, maintRow)
check('G2 维保清单导出同口径', exportEntries('vehmaint').content.includes('1290.1'))

// H. 里程不一致时以台账为准：档案行被改也不影响读口径
const tampered = listRows('shuttle').map((row) =>
  Number(row.id) === 1 ? { ...row, 里程读数: 999 } : row,
)
saveRows('shuttle', tampered)
check('H1 行字段被改成999后仍读台账1290.1', Number(shuttleRow(1)?.['里程读数']) === 1290.1, shuttleRow(1)?.['里程读数'])
check('H2 调度清单导出仍是台账值', exportEntries('shuttle').content.includes('1290.1'))

// I. 再派发生成新趟次，可再次到站累计
const dispatch2 = runAction('shuttle', 1, '派发任务')
const trip2 = String(shuttleRow(1)?.['当前趟次'])
check('I1 到站后回待命可再派发', dispatch2.ok && trip2 !== '', dispatch2)
check('I2 新趟次与上一趟不同', !listArrivals().some((row) => String(row['趟次']) === trip2), trip2)
runAction('shuttle', 1, '确认到站')
check('I3 第二趟里程 1290.1+9.6=1299.7', Number(getMileageRow('SHUT-0001')?.['里程读数']) === 1299.7)
check('I4 合计变为 31.6', arrivalMileageTotal() === 31.6, arrivalMileageTotal())

// J. 维保状态门禁：待命→维保中→不许派车
check('J1 待命车可申请维保', runAction('shuttle', 1, '申请维保').ok)
check('J2 维保中派新任务被挡回', !runAction('shuttle', 1, '派发任务').ok)
// 维保中车辆的上一趟已到站：重复提交幂等认账，但里程绝不再加
const beforeJ3 = Number(getMileageRow('SHUT-0001')?.['里程读数'])
const j3 = runAction('shuttle', 1, '确认到站')
check('J3 维保中重复提交幂等且不加里程', j3.ok && Number(getMileageRow('SHUT-0001')?.['里程读数']) === beforeJ3, j3)
check('J4 充电中且无趟次的车确认到站被挡回', !runAction('shuttle', 3, '确认到站').ok)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
