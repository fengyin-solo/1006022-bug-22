<template>
  <section class="page" data-module="shuttle">
    <header class="page-head">
      <div>
        <h2>摆渡车调度管理</h2>
        <p class="page-desc">维护摆渡车，围绕车辆编号、核载人数、驾驶员、当前任务做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记摆渡车</button>
        <button class="btn" type="button" @click="exportRows">导出摆渡车调度清单</button>
        <button class="btn" type="button" @click="exportArrivals">导出到站明细</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
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
      <button
        class="btn primary"
        type="button"
        :disabled="!selectedIds.length"
        @click="runBatchArrival"
      >
        批量确认到站（已选 {{ selectedIds.length }} 辆）
      </button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              :checked="allArrivableSelected"
              :disabled="!arrivableIds.length"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :checked="selectedIds.includes(Number(row.id))"
              :disabled="row.status !== '执行中'"
              @change="toggleOne(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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

    <footer class="page-foot">
      <span>共 {{ total }} 条摆渡车调度记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  arrivalMileageTotal,
  batchConfirmArrivals,
  downloadArrivalDetails,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('shuttle')
const columns = ["车辆编号", "核载人数", "驾驶员", "当前任务", "发车时间", "行驶路线", "里程读数", "车辆状态"]
const actions = ["派发任务", "确认到站", "申请维保"]
const statuses = ["待命", "执行中", "充电中", "维保中"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedIds = ref<number[]>([])
const mileageTotal = ref(0)
const filterFields = columns.slice(0, 3)

// 统计卡与「到站里程合计」直接读接口层的合计函数，
// 导出到站明细文件里的合计行用的是同一个函数，两边必然一致。
const stats = computed(() => [
  { label: '在册摆渡车', value: rows.value.length },
  { label: '执行中车辆', value: rows.value.filter((row) => row.status === '执行中').length },
  { label: '维保中车辆', value: rows.value.filter((row) => row.status === '维保中').length },
  { label: '到站里程合计(km)', value: mileageTotal.value },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 后台批量入口只允许勾选「执行中」的车，与到站状态机一致。
const arrivableIds = computed(() =>
  rows.value.filter((row) => row.status === '执行中').map((row) => Number(row.id)),
)
const allArrivableSelected = computed(
  () =>
    arrivableIds.value.length > 0 &&
    arrivableIds.value.every((id) => selectedIds.value.includes(id)),
)

function toggleOne(id: number) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleAll() {
  selectedIds.value = allArrivableSelected.value ? [] : [...arrivableIds.value]
}

function resetFilters() {
  filters.value = {}
  errorMessage.value = ''
  noticeMessage.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportArrivals() {
  downloadArrivalDetails()
}

function openCreate() {
  errorMessage.value = '摆渡车登记入口尚未接入审批流'
}

// 入口一：司机在车上对单车点「确认到站」。
function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
}

// 入口二：调度在后台批量勾选到站。与车上确认共用同一个到站收尾。
function runBatchArrival() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = batchConfirmArrivals(selectedIds.value)
  selectedIds.value = []
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
  } else {
    noticeMessage.value = result.message
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    mileageTotal.value = arrivalMileageTotal()
    selectedIds.value = selectedIds.value.filter((id) =>
      payload.items.some((row) => Number(row.id) === id && row.status === '执行中'),
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '摆渡车调度列表读取失败'
  }
}

onMounted(reload)
</script>
