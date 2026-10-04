<template>
  <section class="page" data-module="shuttle">
    <header class="page-head">
      <div>
        <h2>摆渡车调度管理</h2>
        <p class="page-desc">维护摆渡车，围绕车辆编号、核载人数、驾驶员、当前任务做登记、筛选与状态流转。司机车上确认到站与调度后台批量勾选共用同一套到站收尾。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记摆渡车</button>
        <button class="btn" type="button" @click="exportRows">导出摆渡车调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stringStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">到站累计里程（km）</span>
        <strong class="stat-value">{{ arrivalSummary.totalMileage.toFixed(1) }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <button class="btn primary" type="button" :disabled="selectedIds.length === 0" @click="runBatchArrival">
        批量确认到站（已选 {{ selectedIds.length }} 台）
      </button>
      <span class="batch-hint">批量勾选与司机车上确认走同一段收尾：只对执行中的车生效，同一趟重复提交里程只计一次。</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">勾选</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="col-check">
            <input
              type="checkbox"
              :value="Number(row.id)"
              v-model="selectedIds"
              :disabled="String(row.status) !== '执行中'"
              :title="String(row.status) === '执行中' ? '勾选后批量确认到站' : '仅执行中的车辆可勾选到站'"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无摆渡车调度数据，可先登记摆渡车</td>
        </tr>
      </tbody>
    </table>

    <section class="arrival-panel">
      <header class="arrival-head">
        <div>
          <h3>到站明细（按车辆编号分组）</h3>
          <p class="page-desc">
            共 {{ arrivalSummary.totalCount }} 趟到站，里程合计
            <strong>{{ arrivalSummary.totalMileage.toFixed(1) }} km</strong>；
            导出文件与本页合计同源同口径。里程口径：以摆渡车里程读数为准（车辆每趟连续累计、可逐趟对账），
            维保台账里程为离散抄录、可能滞后，到站时自动回写对齐。
          </p>
        </div>
        <button class="btn primary" type="button" @click="downloadArrivalFile">导出到站明细（一份文件）</button>
      </header>

      <div v-for="group in arrivalSummary.groups" :key="group.vehicleNo" class="arrival-group">
        <h4 class="group-title">
          车辆 {{ group.vehicleNo }}
          <span class="group-sub">到站 {{ group.items.length }} 趟 · 里程小计 {{ group.mileage.toFixed(1) }} km</span>
        </h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>发车时间</th>
              <th>到站时间</th>
              <th>本趟里程(km)</th>
              <th>到站后里程读数(km)</th>
              <th>提交入口</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in group.items" :key="item.tripId">
              <td>{{ item.task }}</td>
              <td>{{ item.departTime }}</td>
              <td>{{ item.arriveTime }}</td>
              <td>{{ item.distance.toFixed(1) }}</td>
              <td>{{ item.odometer.toFixed(1) }}</td>
              <td>{{ item.source === 'driver' ? '司机车上确认' : '调度批量勾选' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="arrivalSummary.groups.length === 0" class="empty-state">暂无到站明细</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条摆渡车调度记录</span>
      <span v-if="notice" :class="notice.kind === 'rejected' ? 'error-text' : 'info-text'">{{ notice.text }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  batchConfirmShuttleArrivals,
  downloadArrivals,
  downloadEntries,
  listArrivalGroups,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('shuttle')
const columns = ["车辆编号", "核载人数", "驾驶员", "当前任务", "发车时间", "行驶路线", "里程读数"]
const actions = ["派发任务", "确认到站", "申请维保"]
const statuses = ["待命", "执行中", "充电中", "维保中"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const notice = ref<{ kind: 'ok' | 'duplicate' | 'rejected'; text: string } | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = ["车辆编号", "驾驶员", "当前任务"]
const selectedIds = ref<number[]>([])

const stringStats = computed(() => [
  { label: '在册摆渡车', value: rows.value.length },
  { label: '执行中车辆', value: rows.value.filter((row) => String(row.status) === '执行中').length },
  { label: '维保中车辆', value: rows.value.filter((row) => String(row.status) === '维保中').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 页面合计与导出共用 listArrivalGroups，数字必然一致。
const arrivalSummary = computed(() => listArrivalGroups(filters.value))

function resetFilters() {
  filters.value = {}
  reload()
}

function formatCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === null || value === undefined || value === '') return '—'
  return column === '里程读数' && typeof value === 'number' ? value.toFixed(1) : String(value)
}

function exportRows() {
  downloadEntries(meta.key)
}

function downloadArrivalFile() {
  downloadArrivals(filters.value)
}

function openCreate() {
  notice.value = { kind: 'rejected', text: '摆渡车登记入口尚未接入审批流' }
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  notice.value = {
    kind: result.kind === 'duplicate' ? 'duplicate' : result.ok ? 'ok' : 'rejected',
    text: result.message,
  }
  if (result.ok) {
    selectedIds.value = selectedIds.value.filter((id) => id !== Number(row.id))
  }
  reload()
}

function runBatchArrival() {
  const result = batchConfirmShuttleArrivals(selectedIds.value)
  notice.value = {
    kind: result.rejected.length > 0 ? 'rejected' : 'ok',
    text: result.message,
  }
  selectedIds.value = []
  reload()
}

function reload() {
  notice.value = null
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    notice.value = {
      kind: 'rejected',
      text: error instanceof Error ? error.message : '摆渡车调度列表读取失败',
    }
  }
}

onMounted(reload)
</script>

<style scoped>
.col-check {
  width: 40px;
  text-align: center;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 10px;
}
.batch-hint {
  font-size: 12px;
  color: var(--muted);
}
.arrival-panel {
  margin-top: 20px;
}
.arrival-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.arrival-group {
  margin-bottom: 14px;
}
.group-title {
  margin: 0 0 6px;
  font-size: 14px;
}
.group-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  margin-left: 8px;
}
.info-text {
  color: #175cd3;
}
</style>
