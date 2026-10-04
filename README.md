# 机场地面保障作业管理平台

面向航班保障、机位分配、廊桥靠接、摆渡车调度、行李装卸、航油加注、除冰作业与延误处置的一体化机场地面保障作业工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   │                         shuttle-domain.ts 为摆渡车到站收尾的唯一领域逻辑
│   ├── src/stores/           会话与筛选状态
│   ├── test/                 到站收尾、幂等、越级挡回、台账回写与导出的测试
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 航班保障 | `flight` | 航班保障任务 | 保障编号、航班号、机型 |
| 机位分配 | `stand` | 停机位 | 机位编号、机位类型、适用机型 |
| 廊桥靠接 | `bridge` | 廊桥作业 | 作业编号、廊桥编号、对应机位 |
| 摆渡车调度 | `shuttle` | 摆渡车 | 车辆编号、核载人数、驾驶员 |
| 行李装卸 | `baggage` | 行李作业 | 作业编号、航班号、行李件数 |
| 机务勤务 | `line` | 勤务任务 | 任务编号、航班号、勤务项目 |
| 航油加注 | `fueling` | 加油作业 | 作业编号、航班号、油品规格 |
| 除冰作业 | `deice` | 除冰任务 | 任务编号、航班号、除冰液型号 |
| 地面电源 | `gpu` | 电源车 | 设备编号、设备类型、功率等级 |
| 航空器牵引 | `tow` | 牵引任务 | 任务编号、航班号、牵引车号 |
| 航空配餐 | `catering` | 配餐作业 | 作业编号、航班号、餐食数量 |
| 客舱清洁 | `cabin` | 清洁作业 | 作业编号、航班号、清洁班组 |
| 保障班组 | `team` | 保障班组 | 班组编号、班组名称、负责区域 |
| 特种车辆维保 | `vehmaint` | 维保记录 | 维保单号、车辆编号、维保类型 |
| 要客保障 | `vip` | 要客保障单 | 保障编号、航班号、要客等级 |
| 延误处置 | `delay` | 延误事件 | 事件编号、航班号、延误原因 |
| 机坪安全巡查 | `apron` | 巡查记录 | 巡查编号、巡查区域、巡查人员 |
| 保障资源调度 | `resplan` | 资源计划 | 计划编号、保障时段、机位需求 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `airport-ground-ops:entries` 与
  `airport-ground-ops:shuttle-arrivals` 两项，或调用 `resetModule(模块)`。
  数据结构带版本号（`airport-ground-ops:schema-version`），版本不符会自动重新播种。

### 摆渡车到站收尾（两个入口，一份逻辑）

司机在车上点「确认到站」与调度在后台批量勾选到站，都只调用
`frontend/src/data/shuttle-domain.ts` 里的同一段纯函数收尾，接口层
（`local-service.ts` 的 `confirmShuttleArrival` / `batchConfirmShuttleArrivals`）负责事务落盘：

1. **状态守卫**：车辆只能从「执行中」回到「待命」；维保中、充电中的车辆不能确认到站，
   也不能被派新任务，越级操作一律挡回。
2. **幂等**：以 `车辆编号 + 当前任务 + 发车时间` 构成 `tripId`，同一趟任务无论从哪个入口、
   提交多少次，里程只累计一次，状态不会重复变更。
3. **原子性**：状态回待命、里程读数累加、到站明细落账、维保台账回写在同一个
   `local-store.commit` 事务里完成，不会再出现「状态改了里程没改」或「里程加了状态没动」。
4. **到站明细导出**：页面合计与 CSV 导出共用 `listArrivalGroups`，按车辆编号分组打包成
   一份文件，导出的里程合计与页面看到的合计必然一致。

### 里程口径：以摆渡车里程读数为准

摆渡车「里程读数」与特种车辆维保「台账里程」不一致时，**以摆渡车里程读数为准**：

- 里程读数由车辆每一趟行驶连续累计，实时更新，且能与到站明细逐趟对账；
- 维保台账只在进厂/出厂等离散时点手工抄录，天然存在滞后与抄写误差
  （种子数据里 VEHM-0001 抄录于保养出厂时，比里程表少 38.4 km）。

每次到站收尾都会把最新里程读数回写该车辆的维保台账；维保页面读出时再按摆渡车读数对齐，
保证维保那边看到的里程与摆渡车是同一份。

## 测试

```bash
cd frontend
npm test
```

领域层（`shuttle-domain.ts` 纯函数）与接口+持久化层（`local-service.ts` +
`local-store.ts`）都有用例：覆盖两个入口共用收尾、重复提交幂等、越级派单/到站挡回、
台账回写与导出合计一致性。测试运行器为 `frontend/test/run.mjs`，用仓库已装的 esbuild
把 TS 测试打包后交给 Node 执行，不引入额外测试框架。
