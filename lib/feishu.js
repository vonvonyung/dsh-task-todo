/**
 * dsh-task-todo -- Feishu (Lark) Bitable sync.
 *
 * Mirrors every task -- with its status -- into a Feishu 多维表格 (Bitable).
 * The plugin stays zero-dependency: the transport is the runtime's global
 * `fetch`, and the client accepts an injected one so the whole engine can be
 * exercised offline by the gates.
 *
 * Two design choices are load-bearing, and both exist because the opposite
 * behaviour is a recorded failure mode in this workspace:
 *
 *  - Matching is by a stable key field (`任务ID` by default), NOT by row order
 *    or title. Re-running a sync must be a no-op, so the planner only emits the
 *    rows that actually differ. If the remote table has rows but none of them
 *    carry the key field, the sync REFUSES rather than creating a parallel copy
 *    of every task.
 *  - Only rows that carry our key are ever deleted. A table shared with other
 *    tooling must not lose its own rows because it happens to live at the
 *    configured app/table id.
 *
 * Every value that leaves this module is plain lossless JSON: strings, numbers
 * and booleans only -- DSH discards a whole reply that contains an `undefined`,
 * a `Date` or a `NaN` anywhere.
 */

import { createHash } from 'node:crypto'

import {
  compareDates, dateOnly, describeRecurrence, nowStamp, toDateStr, today as todayStr,
} from './recurrence.js'
import { priorityName } from './store.js'

/** Settings for the Feishu half, plus the defaults the schema mirrors. */
export const FEISHU_DEFAULTS = {
  enabled: false,
  appId: '',
  appSecret: '',
  appToken: '',
  tableId: '',
  baseUrl: 'https://open.feishu.cn',
  autoSync: false,
  syncSubtasks: true,
  includeDone: true,
  // OFF by default, and even when ON it only ever deletes a row this workspace
  // has a tombstone for. `true` used to mean "delete every remote row whose key
  // is not a local task", which silently destroyed rows the table owned: a
  // workspace with A, B syncing against a table holding A, B, C, D wiped C and D.
  deleteRemoved: false,
  keyField: '任务ID',
}

/**
 * Column names this plugin writes. Fixed on purpose: the field map is the
 * contract a user sets up once in the Bitable, and a half-renamed column would
 * fail mid-sync. The key column is the one name that stays configurable,
 * because it is what existing tables are most likely to call something else.
 */
export const FEISHU_FIELDS = {
  title: '标题',
  status: '状态',
  done: '完成',
  overdue: '逾期',
  list: '清单',
  priority: '优先级',
  due: '截止时间',
  start: '开始时间',
  tags: '标签',
  parent: '父任务',
  subtasks: '子任务进度',
  repeat: '重复',
  note: '备注',
  completionRecords: '完成记录',
  relatedFollowUps: '关联跟进',
  createdAt: '创建时间',
  updatedAt: '更新时间',
}

/** Feishu caps a batch write at 500 records. */
export const BATCH_LIMIT = 500

const stringOr = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
const boolOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** Canonicalise whatever the settings document handed us; never throws. */
export function normalizeFeishuSettings(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const baseUrl = stringOr(src.baseUrl, FEISHU_DEFAULTS.baseUrl)
  return {
    enabled: boolOr(src.enabled, FEISHU_DEFAULTS.enabled),
    appId: stringOr(src.appId, ''),
    appSecret: stringOr(src.appSecret, ''),
    appToken: stringOr(src.appToken, ''),
    tableId: stringOr(src.tableId, ''),
    // A base URL that is not a URL would fail later with an opaque fetch error;
    // falling back here makes the failure happen where it can be explained.
    baseUrl: /^https?:\/\/\S+$/i.test(baseUrl) ? baseUrl.replace(/\/+$/, '') : FEISHU_DEFAULTS.baseUrl,
    autoSync: boolOr(src.autoSync, FEISHU_DEFAULTS.autoSync),
    syncSubtasks: boolOr(src.syncSubtasks, FEISHU_DEFAULTS.syncSubtasks),
    includeDone: boolOr(src.includeDone, FEISHU_DEFAULTS.includeDone),
    deleteRemoved: boolOr(src.deleteRemoved, FEISHU_DEFAULTS.deleteRemoved),
    keyField: stringOr(src.keyField, FEISHU_DEFAULTS.keyField),
  }
}

/** Which of the four secrets/ids are still blank, as settings paths. */
export function missingFeishuSettings(config) {
  const missing = []
  if (config.appId === '') missing.push('feishu.appId')
  if (config.appSecret === '') missing.push('feishu.appSecret')
  if (config.appToken === '') missing.push('feishu.appToken')
  if (config.tableId === '') missing.push('feishu.tableId')
  return missing
}

/** Stable, non-secret identity for one table's conflict baseline. */
export function feishuSyncScope(config) {
  const identity = [
    String(config?.baseUrl ?? FEISHU_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    String(config?.appToken ?? ''),
    String(config?.tableId ?? ''),
    String(config?.keyField || FEISHU_DEFAULTS.keyField),
  ]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Canonicalise JSON values so confirmation tokens ignore key insertion order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

/** A short-lived confirmation token for an exact local/remote preview snapshot. */
function fieldFingerprint(value) {
  return `sha256:${createHash('sha256').update(asText(value)).digest('hex')}`
}

function previewToken(config, localRows, remoteRows, options = {}) {
  const snapshot = {
    scope: feishuSyncScope(config),
    local: [...localRows].sort((a, b) => String(a.key).localeCompare(String(b.key))),
    remote: [...remoteRows]
      .map((row) => ({ recordId: row.recordId, fields: row.fields }))
      .sort((a, b) => String(a.recordId).localeCompare(String(b.recordId))),
    options,
  }
  return createHash('sha256').update(JSON.stringify(canonicalJson(snapshot))).digest('hex')
}

/**
 * A Bitable cell as text.
 *
 * The API returns text-ish fields in several shapes depending on the column's
 * UI type: a bare string, an array of `{ type, text }` segments, a number, or a
 * link object. Comparing raw values across a round trip would report every row
 * as changed, so both sides of the diff go through here first.
 */
export function asText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((item) => asText(item)).join('')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.name === 'string') return value.name
    if (typeof value.value === 'string') return value.value
    return ''
  }
  return ''
}

/** The one-line status a user reads in the table. */
export function statusLabel(task, opts = {}) {
  const today = opts.today ?? todayStr()
  if (task.done) return '已完成'
  const due = dateOnly(task.due)
  if (due !== null && compareDates(due, today) < 0) return '已逾期'
  if (due !== null && due === today) return '今天到期'
  return '未完成'
}

const MAX_FEISHU_TEXT_LENGTH = 20000

/** Preserve recent completion history in a readable text cell. */
function completionRecordsText(task) {
  const records = Array.isArray(task.completionRecords) ? task.completionRecords : []
  if (records.length === 0) return ''
  const lines = []
  let used = 0
  let omitted = 0
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    const stamp = String(record?.at ?? '').replace('T', ' ')
    const prefix = stamp === '' ? '' : `${stamp}｜`
    const summary = String(record?.summary ?? '').trim() || '（未填写完成情况）'
    const separator = lines.length > 0 ? 1 : 0
    const room = MAX_FEISHU_TEXT_LENGTH - used - separator
    if (room <= 0) { omitted = index + 1; break }
    if (prefix.length + summary.length > room) {
      if (lines.length === 0) {
        lines.unshift(`${prefix}${summary.slice(0, Math.max(0, room - prefix.length))}`)
        omitted = index
      } else omitted = index + 1
      break
    }
    lines.unshift(`${prefix}${summary}`)
    used += separator + prefix.length + summary.length
  }
  if (omitted > 0) {
    const marker = `…已省略 ${omitted} 条较早记录`
    if (lines.join('\n').length + marker.length + (lines.length > 0 ? 1 : 0) <= MAX_FEISHU_TEXT_LENGTH) {
      lines.unshift(marker)
    }
  }
  return lines.join('\n')
}

/** Describe the other end of any follow-up link on a task row. */
function relatedFollowUpsText(task, store) {
  const lines = []
  if (typeof task.followUpOf === 'string' && task.followUpOf !== '') {
    const source = store.get(task.followUpOf)
    lines.push(source === null
      ? `来源任务 ID：${task.followUpOf}`
      : `来源任务：${source.title}（${source.id}）`)
  }
  const tasks = Array.isArray(store.tasks) ? store.tasks : []
  for (const followUp of tasks) {
    if (followUp.followUpOf !== task.id) continue
    const status = followUp.done ? '已完成' : '未完成'
    const due = followUp.due ? `；截止 ${followUp.due}` : ''
    lines.push(`跟进任务：${followUp.title}（${followUp.id}；${status}${due}）`)
  }
  return lines.join('\n').slice(0, MAX_FEISHU_TEXT_LENGTH)
}

/**
 * One task as a Bitable row.
 *
 * Values are strings on purpose: a column can be created as 文本 in one click
 * and then accepts every field below, whereas sending numbers/booleans would
 * require the user to guess the exact column type per field before the first
 * sync can succeed. The status columns (`状态` / `完成` / `逾期`) are the
 * "including each state" part: a table filtered on them is a live board.
 */
export function taskToFields(task, store, opts = {}) {
  const today = opts.today ?? todayStr()
  const keyField = opts.keyField ?? FEISHU_DEFAULTS.keyField
  const children = store.childrenOf(task.id)
  const parent = task.parentId === null ? null : store.get(task.parentId)
  const due = dateOnly(task.due)
  const overdue = !task.done && due !== null && compareDates(due, today) < 0
  const doneChildren = children.filter((child) => child.done).length
  return {
    [keyField]: task.id,
    [FEISHU_FIELDS.title]: task.title,
    [FEISHU_FIELDS.status]: statusLabel(task, { today }),
    [FEISHU_FIELDS.done]: task.done ? '是' : '否',
    [FEISHU_FIELDS.overdue]: overdue ? '是' : '否',
    [FEISHU_FIELDS.list]: store.listById(task.listId)?.name ?? '收集箱',
    [FEISHU_FIELDS.priority]: priorityName(task.priority),
    [FEISHU_FIELDS.due]: task.due ?? '',
    [FEISHU_FIELDS.start]: task.start ?? '',
    [FEISHU_FIELDS.tags]: task.tags.join(', '),
    [FEISHU_FIELDS.parent]: parent === null ? '' : parent.title,
    [FEISHU_FIELDS.subtasks]: `${doneChildren}/${children.length}`,
    [FEISHU_FIELDS.repeat]: task.recurrence === null ? '' : describeRecurrence(task.recurrence),
    [FEISHU_FIELDS.note]: task.note,
    [FEISHU_FIELDS.completionRecords]: completionRecordsText(task),
    [FEISHU_FIELDS.relatedFollowUps]: relatedFollowUpsText(task, store),
    [FEISHU_FIELDS.createdAt]: task.createdAt,
    [FEISHU_FIELDS.updatedAt]: task.updatedAt,
  }
}

/** Split a list into Feishu-sized batches. */
export function chunk(items, size = BATCH_LIMIT) {
  const out = []
  const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : BATCH_LIMIT
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step))
  return out
}

const keyOf = (fields, keyField) => asText(fields === null || typeof fields !== 'object' ? '' : fields[keyField])

/** How many remote rows actually belong to this plugin. */
export function keyedRemoteCount(remote, keyField) {
  return remote.filter((record) => keyOf(record.fields, keyField) !== '').length
}

/**
 * The pure diff between what the store holds and what the table holds.
 *
 * Returned as a plan rather than applied, so `dryRun` is the same computation
 * with the writes skipped -- a dry run that took a different code path would be
 * worthless as a preview.
 */
export function diffSync(opts = {}) {
  const rows = Array.isArray(opts.rows) ? opts.rows : []
  const remote = Array.isArray(opts.remote) ? opts.remote : []
  const keyField = opts.keyField ?? FEISHU_DEFAULTS.keyField
  const prune = opts.prune !== false

  const byKey = new Map()
  for (const record of remote) {
    const key = keyOf(record.fields, keyField)
    // Rows without our key are somebody else's; the first one wins if a hand-edited
    // table has duplicates, and the duplicate is left untouched.
    if (key !== '' && !byKey.has(key)) byKey.set(key, record)
  }

  const creates = []
  const updates = []
  let unchanged = 0
  const localKeys = new Set()
  for (const row of rows) {
    localKeys.add(row.key)
    const existing = byKey.get(row.key)
    if (existing === undefined) {
      creates.push(row.fields)
      continue
    }
    const changed = {}
    for (const [field, value] of Object.entries(row.fields)) {
      const want = asText(value)
      const have = asText(existing.fields?.[field])
      if (want !== have) changed[field] = value
    }
    if (Object.keys(changed).length === 0) unchanged++
    else updates.push({ recordId: existing.recordId, fields: changed })
  }

  const deletes = []
  // A sync may only delete what it can PROVE it owns: a row whose key this
  // workspace recorded as deleted on purpose (a tombstone). A row with a key we
  // have never seen is somebody else's -- another machine, another tool, a hand
  // edit -- and is reported as `unmanaged` instead of being wiped.
  const tombstones = new Set(
    (Array.isArray(opts.tombstones) ? opts.tombstones : []).map((id) => String(id)),
  )
  const deletedKeys = []
  let unmanaged = 0
  for (const record of remote) {
    const key = keyOf(record.fields, keyField)
    if (key === '' || localKeys.has(key)) continue
    if (prune && tombstones.has(key)) {
      deletes.push(record.recordId)
      deletedKeys.push(key)
    } else {
      unmanaged++
    }
  }

  return {
    creates, updates, deletes, deletedKeys, unchanged, unmanaged,
    matched: localKeys.size - creates.length,
  }
}

/**
 * A thin Feishu Open Platform client.
 *
 * `fetch` is injectable because the gates must exercise token caching, paging
 * and batch bodies without a network, and because the host may already have a
 * wrapped fetch worth reusing.
 */
const dataOf = (payload) => (payload.data !== null && typeof payload.data === 'object' ? payload.data : {})

/** Feishu's Bitable field type for 文本 (single line text). */
export const COLUMN_TYPE_TEXT = 1

/**
 * The columns this plugin needs in the table, in write order.
 *
 * The key column comes first: it is the one a half-built table is most likely
 * to be missing, and it is the one whose absence makes a sync refuse.
 */
export function requiredColumns(keyField) {
  const key = keyField || FEISHU_DEFAULTS.keyField
  const names = [key]
  for (const name of Object.values(FEISHU_FIELDS)) {
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Which needed columns the table does not have yet. */
export function missingColumns(existing, keyField) {
  const have = new Set((existing ?? []).map((name) => String(name)))
  return requiredColumns(keyField).filter((name) => !have.has(name))
}

/** The four priority names, indexed by the stored number. */
const PRIORITY_BY_NAME = new Map([0, 1, 2, 3].map((p) => [priorityName(p), p]))

/**
 * A remote row as a LOCAL task input — the read side of 「从飞书补洞」.
 *
 * Only columns that carry independent information are read back. `状态` /
 * `逾期` / `子任务进度` are derived from other fields on the local side; `重复`
 * is a natural-language sentence, and completion/link columns describe history
 * that the additive pull cannot safely recreate. Those columns are reported as
 * `notRestored` instead of guessed at.
 *
 * @param {object} fields - the row's `fields` object, keyed by column name.
 * @param {string} keyField - the key column's name.
 * @param {(title: string) => string | null} findIdByTitle - resolves a parent's
 *   display title back to a local id, or null when it cannot be resolved.
 * @returns {{ input: object, notRestored: string[], unlinkedParent: string | null }}
 */
export function remoteRowToTask(fields, keyField, findIdByTitle) {
  const get = (column) => asText(fields?.[column])
  const notRestored = []
  const due = get(FEISHU_FIELDS.due)
  const start = get(FEISHU_FIELDS.start)
  const parentTitle = get(FEISHU_FIELDS.parent)
  const parentId = parentTitle === '' || typeof findIdByTitle !== 'function'
    ? null
    : findIdByTitle(parentTitle)
  const priorityText = get(FEISHU_FIELDS.priority)
  if (get(FEISHU_FIELDS.repeat) !== '') notRestored.push(FEISHU_FIELDS.repeat)
  if (get(FEISHU_FIELDS.completionRecords) !== '') notRestored.push(FEISHU_FIELDS.completionRecords)
  if (get(FEISHU_FIELDS.relatedFollowUps) !== '') notRestored.push(FEISHU_FIELDS.relatedFollowUps)
  for (const column of [FEISHU_FIELDS.status, FEISHU_FIELDS.overdue, FEISHU_FIELDS.subtasks, FEISHU_FIELDS.updatedAt]) {
    if (get(column) !== '') notRestored.push(column)
  }
  const createdAt = get(FEISHU_FIELDS.createdAt)
  const input = {
    title: get(FEISHU_FIELDS.title),
    note: get(FEISHU_FIELDS.note),
    done: get(FEISHU_FIELDS.done) === '是',
    listName: get(FEISHU_FIELDS.list) || '收集箱',
    priority: PRIORITY_BY_NAME.get(priorityText) ?? 0,
    tags: get(FEISHU_FIELDS.tags).split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
    due: due === '' ? null : due,
    start: start === '' ? null : start,
  }
  if (parentId !== null) input.parentId = parentId
  // A creation stamp is history the row actually carries; anything unparseable
  // is dropped rather than turned into "now".
  if (/^\d{4}-\d{2}-\d{2}/.test(createdAt)) input.createdAt = createdAt
  return { input, notRestored, unlinkedParent: parentTitle !== '' && parentId === null ? parentTitle : null }
}

const REMOTE_IMPORT_COLUMNS = new Set([
  FEISHU_FIELDS.title, FEISHU_FIELDS.done, FEISHU_FIELDS.list, FEISHU_FIELDS.priority,
  FEISHU_FIELDS.due, FEISHU_FIELDS.start, FEISHU_FIELDS.tags, FEISHU_FIELDS.parent,
  FEISHU_FIELDS.note,
])

export class FeishuClient {
  constructor(config, opts = {}) {
    this.config = config
    this.fetch = typeof opts.fetch === 'function' ? opts.fetch : globalThis.fetch
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.token = null
    this.tokenExpiresAt = 0
    this.requests = 0
  }

  base() {
    return String(this.config.baseUrl || FEISHU_DEFAULTS.baseUrl).replace(/\/+$/, '')
  }

  /**
   * One authenticated (or auth) call, with Feishu's `code` envelope unwrapped.
   *
   * Returns the WHOLE envelope, not `payload.data`: the tenant-token endpoint
   * puts its token at the top level, while the Bitable endpoints nest their
   * payload under `data`. One shape here and each caller reads what it needs.
   */
  async request(pathname, options = {}) {
    if (typeof this.fetch !== 'function') {
      throw new Error('当前运行时没有 fetch，无法访问飞书接口')
    }
    const headers = { 'content-type': 'application/json; charset=utf-8' }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    const init = { method: options.method ?? 'POST', headers }
    if (options.body !== undefined) init.body = JSON.stringify(options.body)
    this.requests++
    let response = null
    try {
      response = await this.fetch(`${this.base()}${pathname}`, init)
    } catch (e) {
      throw new Error(`飞书接口请求失败：${String(e?.message ?? e)}`)
    }
    const text = await response.text()
    let payload = null
    try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
    if (response.ok !== true) {
      const detail = payload !== null && typeof payload.msg === 'string' ? payload.msg : text.slice(0, 200)
      throw new Error(`飞书接口 HTTP ${response.status}：${detail}`)
    }
    if (payload === null || typeof payload !== 'object') {
      throw new Error('飞书接口返回了非 JSON 内容（请检查 baseUrl / 网络代理）')
    }
    if (payload.code !== 0) {
      const extra = payload.error !== null && typeof payload.error?.message === 'string'
        ? `（${payload.error.message}）`
        : ''
      throw new Error(`飞书接口错误 code=${payload.code}：${String(payload.msg ?? '')}${extra}`)
    }
    return payload
  }

  /** The tenant token, cached until shortly before it expires. */
  async tenantToken(force = false) {
    const now = this.now()
    if (!force && this.token !== null && now < this.tokenExpiresAt) return this.token
    const payload = await this.request('/open-apis/auth/v3/tenant_access_token/internal', {
      body: { app_id: this.config.appId, app_secret: this.config.appSecret },
    })
    const token = typeof payload.tenant_access_token === 'string' ? payload.tenant_access_token : ''
    if (token === '') throw new Error('飞书未返回 tenant_access_token（请检查 appId / appSecret）')
    const expire = Number(payload.expire) > 0 ? Number(payload.expire) : 7200
    this.token = token
    // Refresh five minutes early: a token that expires mid-run would fail the
    // batch that follows the list call.
    this.tokenExpiresAt = now + Math.max(60, expire - 300) * 1000
    return token
  }

  recordsPath() {
    const appToken = encodeURIComponent(this.config.appToken)
    const tableId = encodeURIComponent(this.config.tableId)
    return `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`
  }

  /** The column endpoint of the same table. */
  fieldsPath() {
    const appToken = encodeURIComponent(this.config.appToken)
    const tableId = encodeURIComponent(this.config.tableId)
    return `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`
  }

  /** Every column of the table, following `page_token` until `has_more` is false. */
  async listFields() {
    const token = await this.tenantToken()
    const out = []
    let pageToken = ''
    for (let page = 0; page < 50; page++) {
      const query = `page_size=100${pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`
      const payload = await this.request(`${this.fieldsPath()}?${query}`, { method: 'GET', token })
      const data = dataOf(payload)
      const items = Array.isArray(data.items) ? data.items : []
      for (const item of items) {
        out.push({
          fieldId: String(item?.field_id ?? ''),
          name: String(item?.field_name ?? ''),
          type: Number(item?.type) || 0,
          primary: item?.is_primary === true,
        })
      }
      const next = typeof data.page_token === 'string' ? data.page_token : ''
      if (data.has_more === true && next !== '') { pageToken = next; continue }
      break
    }
    return out
  }

  /**
   * Add one 文本 column.
   *
   * Text on purpose: every value this plugin writes is a string, so one column
   * type accepts the whole row (see `taskToFields`). An existing column is never
   * touched — Feishu rejects a duplicate name, and that rejection is reported
   * rather than retried under a mangled name.
   */
  async createField(name, type = COLUMN_TYPE_TEXT) {
    const payload = await this.request(this.fieldsPath(), {
      token: await this.tenantToken(),
      body: { field_name: String(name), type },
    })
    const field = dataOf(payload).field
    return { name: String(name), fieldId: String(field?.field_id ?? '') }
  }

  /** Every row, following `page_token` until `has_more` is false. */
  async listRecords() {
    const token = await this.tenantToken()
    const out = []
    let pageToken = ''
    for (let page = 0; page < 200; page++) {
      const query = `page_size=${BATCH_LIMIT}${pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`
      const payload = await this.request(`${this.recordsPath()}?${query}`, { method: 'GET', token })
      const data = dataOf(payload)
      const items = Array.isArray(data.items) ? data.items : []
      for (const item of items) {
        out.push({
          recordId: String(item?.record_id ?? ''),
          fields: item?.fields !== null && typeof item?.fields === 'object' ? item.fields : {},
        })
      }
      const next = typeof data.page_token === 'string' ? data.page_token : ''
      if (data.has_more === true && next !== '') { pageToken = next; continue }
      break
    }
    return out
  }

  async batchCreate(fieldsList) {
    let count = 0
    for (const batch of chunk(fieldsList)) {
      if (batch.length === 0) continue
      const payload = await this.request(`${this.recordsPath()}/batch_create`, {
        token: await this.tenantToken(),
        body: { records: batch.map((fields) => ({ fields })) },
      })
      const records = dataOf(payload).records
      count += Array.isArray(records) ? records.length : batch.length
    }
    return count
  }

  async batchUpdate(updates) {
    let count = 0
    for (const batch of chunk(updates)) {
      if (batch.length === 0) continue
      const payload = await this.request(`${this.recordsPath()}/batch_update`, {
        token: await this.tenantToken(),
        body: {
          records: batch.map((update) => ({
            record_id: update.recordId,
            fields: update.fields,
          })),
        },
      })
      const records = dataOf(payload).records
      count += Array.isArray(records) ? records.length : batch.length
    }
    return count
  }

  async batchDelete(recordIds) {
    let count = 0
    for (const batch of chunk(recordIds)) {
      if (batch.length === 0) continue
      const payload = await this.request(`${this.recordsPath()}/batch_delete`, {
        token: await this.tenantToken(),
        body: { records: batch },
      })
      const records = dataOf(payload).records
      count += Array.isArray(records) ? records.length : batch.length
    }
    return count
  }
}

/**
 * Drives one sync: read the store, read the table, diff, apply.
 *
 * Kept apart from the service so it can run against any store-shaped object and
 * an injected client -- which is exactly what `scripts/test-feishu.mjs` does.
 */
export class FeishuSync {
  constructor(config, store, opts = {}) {
    this.config = config
    this.store = store
    // The two clocks are deliberately NOT the same function: `this.now` returns a
    // Date (for `nowStamp`), while the client needs epoch milliseconds. Passing
    // one through to the other made `tokenExpiresAt` a string, so the token was
    // re-fetched on every call.
    const clientOpts = {}
    if (typeof opts.fetch === 'function') clientOpts.fetch = opts.fetch
    if (typeof opts.clientNow === 'function') clientOpts.now = opts.clientNow
    this.client = opts.client ?? new FeishuClient(config, clientOpts)
    this.now = typeof opts.now === 'function' ? opts.now : () => new Date()
  }

  /** The rows this configuration wants in the table. */
  rows(opts = {}) {
    const today = opts.today ?? todayStr()
    const keyField = this.config.keyField || FEISHU_DEFAULTS.keyField
    const includeDone = opts.includeDone === undefined ? this.config.includeDone !== false : opts.includeDone === true
    const syncSubtasks = this.config.syncSubtasks !== false
    const out = []
    for (const task of this.store.all()) {
      if (task.parentId !== null && !syncSubtasks) continue
      if (task.done && !includeDone) continue
      out.push({ key: task.id, fields: taskToFields(task, this.store, { today, keyField }) })
    }
    return out
  }

  async run(opts = {}) {
    const startedAt = nowStamp(this.now())
    const keyField = this.config.keyField || FEISHU_DEFAULTS.keyField
    const remote = await this.client.listRecords()
    // Snapshot local values after the network read, so a user edit made while the
    // table was loading is not accidentally pushed from an older in-memory view.
    const rows = this.rows(opts)
    // Refusing beats duplicating: a table whose key column is missing or spelled
    // differently would otherwise receive a fresh copy of every task, every run.
    if (remote.length > 0 && keyedRemoteCount(remote, keyField) === 0) {
      throw new Error(`远端表格有 ${remote.length} 行，但没有一行带「${keyField}」字段：`
        + '请确认多维表格里有这个文本字段（可在设置里改 keyField），或先清空表格再同步')
    }
    const prune = opts.prune === undefined ? this.config.deleteRemoved === true : opts.prune === true
    const conflictPolicy = ['push', 'skip'].includes(opts.conflictPolicy) ? opts.conflictPolicy : 'stop'
    // The delete whitelist comes from the store's own record of what it deleted
    // on purpose; a store that cannot answer gives an empty list, which makes
    // this a create/update-only sync. Both it and the shared baseline influence
    // the plan, so confirmation must bind them as well as the visible row data.
    const tombstones = typeof this.store?.tombstones === 'function' ? this.store.tombstones() : []
    const scope = feishuSyncScope(this.config)
    const baseline = typeof this.store?.feishuBaseline === 'function'
      ? this.store.feishuBaseline(scope)
      : {}
    const confirmationToken = previewToken(this.config, rows, remote, {
      prune,
      tombstones: [...tombstones].sort(),
      baseline,
    })
    const plan = diffSync({ rows, remote, keyField, prune, tombstones })
    const remoteByRecordId = new Map(remote.map((record) => [record.recordId, record]))
    const localByKey = new Map(rows.map((row) => [row.key, row]))
    const safeUpdates = []
    const conflictsByKey = new Map()
    for (const update of plan.updates) {
      const record = remoteByRecordId.get(update.recordId)
      const key = record === undefined ? '' : keyOf(record.fields, keyField)
      const localRow = localByKey.get(key)
      if (record === undefined || localRow === undefined) {
        safeUpdates.push(update)
        continue
      }
      const baseFields = baseline[key] ?? {}
      const safeFields = {}
      const conflictChanges = []
      for (const [field, value] of Object.entries(update.fields)) {
        const localValue = asText(value)
        const remoteValue = asText(record.fields?.[field])
        if (!Object.prototype.hasOwnProperty.call(baseFields, field)) {
          conflictChanges.push({
            field, local: localValue, remote: remoteValue, baseline: null, reason: 'unknown',
          })
          continue
        }
        const baseFingerprint = String(baseFields[field])
        const localChanged = fieldFingerprint(localValue) !== baseFingerprint
        const remoteChanged = fieldFingerprint(remoteValue) !== baseFingerprint
        if (remoteChanged) {
          conflictChanges.push({
            field, local: localValue, remote: remoteValue,
            reason: localChanged ? 'both' : 'remote',
          })
        } else {
          safeFields[field] = value
        }
      }
      if (Object.keys(safeFields).length > 0) safeUpdates.push({ recordId: update.recordId, fields: safeFields })
      if (conflictChanges.length > 0) {
        conflictsByKey.set(key, {
          key,
          title: asText(localRow.fields[FEISHU_FIELDS.title]),
          fields: conflictChanges.map((change) => change.field),
          changes: conflictChanges,
        })
      }
    }
    // A local deletion can be just as destructive as a field update: another
    // person may have edited the remote row since the workspace deleted it.
    // Only delete when the row still matches the shared baseline. Missing
    // baselines and untracked non-empty remote columns are unknown conflicts.
    const remoteKeyCounts = new Map()
    for (const record of remote) {
      const key = keyOf(record.fields, keyField)
      if (key !== '') remoteKeyCounts.set(key, (remoteKeyCounts.get(key) ?? 0) + 1)
    }
    const safeDeletes = []
    for (const recordId of plan.deletes) {
      const record = remoteByRecordId.get(recordId)
      const key = record === undefined ? '' : keyOf(record.fields, keyField)
      const conflictKey = key || recordId
      const remoteFields = record?.fields !== null && typeof record?.fields === 'object' && !Array.isArray(record.fields)
        ? record.fields
        : {}
      const baseFields = baseline[key] ?? {}
      const conflictChanges = []
      if (record === undefined || key === '' || Object.keys(baseFields).length === 0) {
        conflictChanges.push({
          field: keyField,
          local: '（本地已删除）',
          remote: key || '无法读取远端任务ID',
          reason: 'unknown',
        })
      } else {
        if (remoteKeyCounts.get(key) > 1) {
          conflictChanges.push({
            field: keyField,
            local: '（本地已删除）',
            remote: `远端有 ${remoteKeyCounts.get(key)} 行使用此任务ID`,
            reason: 'unknown',
          })
        }
        const fieldsToCheck = new Set([...Object.keys(baseFields), ...Object.keys(remoteFields)])
        for (const field of fieldsToCheck) {
          const remoteValue = asText(remoteFields[field])
          if (!Object.prototype.hasOwnProperty.call(baseFields, field)) {
            if (remoteValue !== '') {
              conflictChanges.push({
                field, local: '（本地已删除）', remote: remoteValue, reason: 'unknown',
              })
            }
            continue
          }
          if (fieldFingerprint(remoteValue) !== String(baseFields[field])) {
            conflictChanges.push({
              field, local: '（本地已删除）', remote: remoteValue, reason: 'remote',
            })
          }
        }
      }
      if (conflictChanges.length === 0) {
        safeDeletes.push(recordId)
        continue
      }
      const current = conflictsByKey.get(conflictKey)
      if (current !== undefined) {
        const changesByField = new Map(current.changes.map((change) => [change.field, change]))
        for (const change of conflictChanges) changesByField.set(change.field, change)
        current.changes = [...changesByField.values()]
        current.fields = [...new Set([...current.fields, ...conflictChanges.map((change) => change.field)])]
      } else {
        conflictsByKey.set(conflictKey, {
          key: conflictKey,
          title: asText(remoteFields[FEISHU_FIELDS.title]) || conflictKey,
          fields: [...new Set(conflictChanges.map((change) => change.field))],
          changes: conflictChanges,
          operation: 'delete',
        })
      }
    }
    const conflicts = [...conflictsByKey.values()]
    const blocked = conflicts.length > 0 && conflictPolicy === 'stop'
    const conflictKeys = new Set(conflicts.map((conflict) => conflict.key))
    const updatesToApply = conflictPolicy === 'push'
      ? plan.updates
      : conflictPolicy === 'skip'
        ? safeUpdates.filter((update) => !conflictKeys.has(keyOf(remoteByRecordId.get(update.recordId)?.fields, keyField)))
        : (blocked ? [] : plan.updates)
    const deletesToApply = conflictPolicy === 'push'
      ? plan.deletes
      : conflictPolicy === 'skip'
        ? safeDeletes.filter((recordId) => !conflictKeys.has(keyOf(remoteByRecordId.get(recordId)?.fields, keyField)))
        : (blocked ? [] : plan.deletes)
    const writes = blocked
      ? { created: [], updates: [], deletes: [] }
      : { created: plan.creates, updates: updatesToApply, deletes: deletesToApply }
    const deletedKeysToApply = new Set(writes.deletes
      .map((recordId) => remoteByRecordId.get(recordId))
      .filter((record) => record !== undefined)
      .map((record) => keyOf(record.fields, keyField))
      .filter((key) => key !== ''))
    const summary = {
      local: rows.length,
      remote: remote.length,
      unchanged: plan.unchanged,
      planned: {
        created: writes.created.length,
        updated: writes.updates.length,
        deleted: writes.deletes.length,
      },
      wouldPush: { created: plan.creates.length, updated: plan.updates.length, deleted: plan.deletes.length },
      safe: { updated: safeUpdates.length, deleted: safeDeletes.length },
      created: 0,
      updated: 0,
      deleted: 0,
      unmanaged: plan.unmanaged,
      prune,
      dryRun: opts.dryRun === true,
      blocked,
      decisionRequired: blocked,
      conflictPolicy,
      conflicts,
      skippedConflicts: conflictPolicy === 'skip' ? conflicts.length : 0,
      previewToken: confirmationToken,
      startedAt,
      keyField,
      tableId: this.config.tableId,
    }
    if (opts.expectedToken !== undefined && opts.expectedToken !== confirmationToken) {
      summary.blocked = true
      summary.decisionRequired = true
      summary.stale = true
      summary.planned = { created: 0, updated: 0, deleted: 0 }
      summary.finishedAt = nowStamp(this.now())
      return summary
    }
    if (opts.dryRun === true || blocked) {
      summary.finishedAt = nowStamp(this.now())
      return summary
    }
    summary.created = await this.client.batchCreate(writes.created)
    summary.updated = await this.client.batchUpdate(writes.updates)
    summary.deleted = await this.client.batchDelete(writes.deletes)
    // The rows are gone, so those tombstones have done their job. Keeping them
    // would delete a row that is re-added later under the same key -- which is
    // exactly what 「从飞书补洞」 does when it reuses a key as the local id.
    if (deletedKeysToApply.size > 0 && typeof this.store?.forgetRemoved === 'function') {
      this.store.forgetRemoved([...deletedKeysToApply])
    }
    if (typeof this.store?.setFeishuBaseline === 'function') {
      const nextBaseline = Object.assign(Object.create(null), baseline)
      const createdKeys = new Set(plan.creates.map((fields) => asText(fields[keyField])))
      for (const row of rows) {
        const record = remote.find((item) => keyOf(item.fields, keyField) === row.key)
        const fields = { ...(nextBaseline[row.key] ?? {}) }
        if (createdKeys.has(row.key) || (conflictPolicy === 'push' && conflictKeys.has(row.key))) {
          for (const [field, value] of Object.entries(row.fields)) fields[field] = fieldFingerprint(value)
        } else if (record !== undefined) {
          for (const [field, value] of Object.entries(row.fields)) {
            const localValue = asText(value)
            const remoteValue = asText(record.fields?.[field])
            if (localValue === remoteValue || (!conflictKeys.has(row.key) && updatesToApply.some((item) => item.recordId === record.recordId))) {
              fields[field] = fieldFingerprint(localValue)
            }
          }
        }
        if (Object.keys(fields).length > 0) nextBaseline[row.key] = fields
      }
      for (const key of deletedKeysToApply) delete nextBaseline[key]
      this.store.setFeishuBaseline(scope, nextBaseline)
      this.store.flush?.()
    }
    summary.finishedAt = nowStamp(this.now())
    return summary
  }

  /** The key column for this configuration. */
  keyName() {
    return this.config.keyField || FEISHU_DEFAULTS.keyField
  }

  /**
   * Test the connection without writing anything.
   *
   * Deliberately a fresh token, then the schema, then one page of rows: that is
   * the order a person debugs these three failures in (credentials → wrong table
   * → empty/unreadable table), and each step's own Feishu error is what gets
   * surfaced. No write of any kind happens here, so it is safe to click on a
   * table that already holds data.
   */
  async probe() {
    const startedAt = nowStamp(this.now())
    const keyField = this.keyName()
    const client = this.client
    const result = {
      baseUrl: this.config.baseUrl || FEISHU_DEFAULTS.baseUrl,
      appToken: this.config.appToken,
      tableId: this.config.tableId,
      keyField,
      ok: false,
      tokenOk: false,
      tableOk: false,
      fields: [],
      columns: { present: [], missing: requiredColumns(keyField) },
      remote: 0,
      keyed: 0,
      notRestored: [],
      startedAt,
    }
    try {
      await client.tenantToken(true)
      result.tokenOk = true
    } catch (e) {
      result.error = String(e?.message ?? e)
      result.step = 'token'
      result.finishedAt = nowStamp(this.now())
      return result
    }
    let names = []
    try {
      const fields = await client.listFields()
      names = fields.map((field) => field.name)
      result.fields = names
    } catch (e) {
      result.error = String(e?.message ?? e)
      result.step = 'fields'
      result.finishedAt = nowStamp(this.now())
      return result
    }
    result.tableOk = true
    result.columns = {
      present: requiredColumns(keyField).filter((name) => names.includes(name)),
      missing: missingColumns(names, keyField),
    }
    try {
      const remote = await client.listRecords()
      result.remote = remote.length
      result.keyed = keyedRemoteCount(remote, keyField)
    } catch (e) {
      result.error = String(e?.message ?? e)
      result.step = 'records'
      result.finishedAt = nowStamp(this.now())
      return result
    }
    result.ok = true
    result.finishedAt = nowStamp(this.now())
    return result
  }

  /**
   * Create the columns this plugin needs and the table does not have yet.
   *
   * This is what makes a brand-new Bitable usable: the alternative is asking a
   * user to hand-type seventeen column names and get every one of them exactly
   * right. Existing columns are never renamed, retyped or removed — only the
   * missing ones are added, as 文本.
   */
  async ensureFields(opts = {}) {
    const keyField = this.keyName()
    const wanted = requiredColumns(keyField)
    const existing = (await this.client.listFields()).map((field) => field.name)
    const missing = wanted.filter((name) => !existing.includes(name))
    const result = {
      keyField,
      existing: existing.filter((name) => wanted.includes(name)),
      missing,
      created: [],
      failed: [],
      dryRun: opts.dryRun === true,
      startedAt: nowStamp(this.now()),
    }
    if (result.dryRun === true || missing.length === 0) {
      result.finishedAt = nowStamp(this.now())
      return result
    }
    // Sequential on purpose: a partial failure has to say exactly which column
    // failed and why, and a batch API would report one error for the set.
    for (const name of missing) {
      try {
        await this.client.createField(name)
        result.created.push(name)
      } catch (e) {
        result.failed.push({ name, error: String(e?.message ?? e) })
      }
    }
    result.finishedAt = nowStamp(this.now())
    return result
  }

  /**
   * A full accounting of both sides — 「完整对账」.
   *
   * `run()` answers "what would I write"; this answers "do the two sides agree",
   * including the rows a sync would never touch: rows the table has that this
   * workspace does not (holes to pull), and rows whose every field matches. It
   * reads only.
   */
  async reconcile(opts = {}) {
    const startedAt = nowStamp(this.now())
    const keyField = this.keyName()
    const remote = await this.client.listRecords()
    const rows = this.rows(opts)
    if (remote.length > 0 && keyedRemoteCount(remote, keyField) === 0) {
      throw new Error(`远端表格有 ${remote.length} 行，但没有一行带「${keyField}」字段：`
        + '请确认多维表格里有这个文本字段（可在设置里改 keyField）')
    }
    const byKey = new Map()
    let unkeyed = 0
    for (const row of remote) {
      const key = asText(row.fields?.[keyField])
      if (key === '') { unkeyed++; continue }
      byKey.set(key, row)
    }
    const local = new Map(rows.map((row) => [row.key, row]))
    const baseline = typeof this.store?.feishuBaseline === 'function'
      ? this.store.feishuBaseline(feishuSyncScope(this.config))
      : {}
    const differing = []
    const remoteOnly = []
    let identical = 0
    for (const [key, row] of byKey) {
      const mine = local.get(key)
      if (mine === undefined) {
        remoteOnly.push({ key, title: asText(row.fields?.[FEISHU_FIELDS.title]) })
        continue
      }
      const changed = []
      const changes = []
      const baseFields = baseline[key] ?? {}
      for (const [column, value] of Object.entries(mine.fields)) {
        const localValue = asText(value)
        const remoteValue = asText(row.fields?.[column])
        if (remoteValue === localValue) continue
        changed.push(column)
        const hasBase = Object.prototype.hasOwnProperty.call(baseFields, column)
        const baseFingerprint = hasBase ? String(baseFields[column]) : null
        const localChanged = hasBase && fieldFingerprint(localValue) !== baseFingerprint
        const remoteChanged = hasBase && fieldFingerprint(remoteValue) !== baseFingerprint
        const direction = !hasBase ? 'unknown'
          : localChanged && remoteChanged ? 'both'
            : remoteChanged ? 'remote' : 'local'
        changes.push({ field: column, local: localValue, remote: remoteValue, direction })
      }
      if (changed.length === 0) identical++
      else differing.push({ key, title: asText(mine.fields[FEISHU_FIELDS.title]), fields: changed, changes })
    }
    const localOnly = []
    for (const [key, row] of local) {
      if (byKey.has(key)) continue
      localOnly.push({ key, title: asText(row.fields[FEISHU_FIELDS.title]) })
    }
    // A missing column is the usual explanation for a wall of "differing"

    // rows, so the report carries the schema too -- and a schema read that fails
    // must not sink the accounting itself.
    let columns = { present: [], missing: [] }
    try {
      const names = (await this.client.listFields()).map((field) => field.name)
      columns = {
        present: requiredColumns(keyField).filter((name) => names.includes(name)),
        missing: missingColumns(names, keyField),
      }
    } catch (e) {
      columns = { present: [], missing: [], error: String(e?.message ?? e) }
    }
    return {
      keyField,
      tableId: this.config.tableId,
      local: rows.length,
      remote: remote.length,
      keyed: byKey.size,
      unkeyed,
      identical,
      differing,
      localOnly,
      remoteOnly,
      columns,
      startedAt,
      finishedAt: nowStamp(this.now()),
    }
  }

  /**
   * Import what the table has and this workspace does not — 「从飞书补洞」.
   *
   * One-way and additive, by construction: a row is only read when NO local task
   * carries its key, and the local write is a `create` with that key. Nothing
   * that already exists locally is read, overwritten or deleted, so a pull can
   * never destroy local work — which is the whole reason this is not "reverse
   * sync".
   */
  async pull(opts = {}) {
    const startedAt = nowStamp(this.now())
    const keyField = this.keyName()
    const remote = await this.client.listRecords()
    if (remote.length > 0 && keyedRemoteCount(remote, keyField) === 0) {
      throw new Error(`远端表格有 ${remote.length} 行，但没有一行带「${keyField}」字段：`
        + '没有这一列就无法判断哪一行是本地缺的')
    }
    const known = new Set(this.store.all().map((task) => task.id))
    // A parent is referenced by its DISPLAY title (that is what `taskToFields`
    // writes), so the link is restored only when a local task carries that exact
    // title. Anything else is reported instead of guessed.
    const idByTitle = new Map()
    for (const task of this.store.all()) {
      if (!idByTitle.has(task.title)) idByTitle.set(task.title, task.id)
    }
    const holes = []
    const skipped = []
    const notRestored = new Set()
    const unlinkedParents = new Set()
    for (const row of remote) {
      const key = asText(row.fields?.[keyField])
      if (key === '') { skipped.push({ recordId: row.recordId, reason: `这一行没有「${keyField}」` }); continue }
      if (known.has(key)) continue
      const mapped = remoteRowToTask(row.fields, keyField, (title) => idByTitle.get(title) ?? null)
      for (const column of mapped.notRestored) notRestored.add(column)
      if (mapped.unlinkedParent !== null) unlinkedParents.add(mapped.unlinkedParent)
      if (String(mapped.input.title).trim() === '') {
        skipped.push({ key, recordId: row.recordId, reason: '这一行没有标题' })
        continue
      }
      holes.push({ key, input: mapped.input })
    }
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : holes.length
    const plan = holes.slice(0, limit)
    const result = {
      keyField,
      remote: remote.length,
      holes: holes.length,
      planned: plan.length,
      created: 0,
      items: plan.map((hole) => ({ key: hole.key, title: String(hole.input.title) })),
      skipped,
      notRestored: [...notRestored],
      unlinkedParents: [...unlinkedParents],
      createdLists: [],
      dryRun: opts.dryRun === true,
      startedAt,
    }
    if (result.dryRun === true || plan.length === 0) {
      result.finishedAt = nowStamp(this.now())
      return result
    }
    for (const hole of plan) {
      // The remote key IS the local id, so an import stays traceable and a later
      // sync of the same row updates instead of duplicating.
      try {
        // A row names its list; dropping the task into the inbox instead would
        // lose the grouping AND make the next sync push 收集箱 back over the
        // value the table already had. So an unknown list is created here.
        const listName = String(hole.input.listName ?? '').trim()
        if (listName !== '' && listName !== '收集箱' && this.store.listByname(listName) === null) {
          this.store.createList({ name: listName }, { notify: false })
          if (!result.createdLists.includes(listName)) result.createdLists.push(listName)
        }
        this.store.create({ ...hole.input, id: hole.key }, { notify: false })
        result.created++
      } catch (e) {
        result.skipped.push({ key: hole.key, reason: String(e?.message ?? e) })
      }
    }
    this.store.flush?.()
    result.finishedAt = nowStamp(this.now())
    return result
  }

  /**
   * Apply changed, reversible Feishu fields to tasks that already exist locally.
   *
   * This is deliberately separate from `pull()`: `pull()` still only creates
   * remote-only tasks, while this operation is an explicit Feishu-wins decision
   * for matching task IDs. Derived columns, prose recurrence rules and history
   * summaries are reported, never guessed into local structures.
   */
  async applyRemote(opts = {}) {
    const startedAt = nowStamp(this.now())
    const keyField = this.keyName()
    const remote = await this.client.listRecords()
    const schema = await this.client.listFields()
    const availableColumns = new Set(schema.map((field) => field.name))
    if (remote.length > 0 && keyedRemoteCount(remote, keyField) === 0) {
      throw new Error(`远端表格有 ${remote.length} 行，但没有一行带「${keyField}」字段：`
        + '没有这一列就无法匹配要更新的本地任务')
    }
    const tasks = this.store.all()
    const localById = new Map(tasks.map((task) => [task.id, task]))
    const idsByTitle = new Map()
    for (const task of tasks) {
      const matches = idsByTitle.get(task.title) ?? []
      matches.push(task.id)
      idsByTitle.set(task.title, matches)
    }
    const keyCounts = new Map()
    for (const row of remote) {
      const key = keyOf(row.fields, keyField)
      if (key !== '') keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
    }
    const selected = Array.isArray(opts.keys) && opts.keys.length > 0
      ? new Set(opts.keys.map((key) => String(key)))
      : null
    const localSnapshot = tasks.map((task) => ({
      key: task.id,
      fields: taskToFields(task, this.store, { keyField }),
    }))
    const scope = feishuSyncScope(this.config)
    const baseline = typeof this.store?.feishuBaseline === 'function'
      ? this.store.feishuBaseline(scope)
      : {}
    const confirmationToken = previewToken(this.config, localSnapshot, remote, {
      keys: selected === null ? null : [...selected].sort(),
      baseline,
    })
    const skipped = []
    const notApplied = new Set()
    const plans = []
    let matched = 0
    let differing = 0
    for (const row of remote) {
      const key = keyOf(row.fields, keyField)
      if (key === '') {
        skipped.push({ recordId: row.recordId, reason: `这一行没有「${keyField}」` })
        continue
      }
      const task = localById.get(key)
      if (task === undefined) continue // remote-only rows remain the separate pull action
      matched++
      if (keyCounts.get(key) > 1) {
        skipped.push({ key, recordId: row.recordId, reason: '远端有多个相同任务ID，无法安全确定要更新哪一行' })
        continue
      }
      if (selected !== null && !selected.has(key)) continue
      const localFields = taskToFields(task, this.store, { keyField })
      const patch = {}
      const changes = []
      for (const [column, localRaw] of Object.entries(localFields)) {
        if (column === keyField || !availableColumns.has(column)) continue
        // Bitable commonly omits blank cells from a row payload; absence is not
        // proof the user cleared a value, so only an explicit cell may clear it.
        if (!Object.prototype.hasOwnProperty.call(row.fields ?? {}, column)) continue
        const localValue = asText(localRaw)
        const remoteValue = asText(row.fields?.[column])
        if (localValue === remoteValue) continue
        differing++
        const change = { field: column, local: localValue, remote: remoteValue, applied: false, reason: '' }
        if (!REMOTE_IMPORT_COLUMNS.has(column)) {
          change.reason = [FEISHU_FIELDS.status, FEISHU_FIELDS.overdue, FEISHU_FIELDS.subtasks].includes(column)
            ? '本地派生字段，不直接导入'
            : [FEISHU_FIELDS.repeat, FEISHU_FIELDS.completionRecords, FEISHU_FIELDS.relatedFollowUps].includes(column)
              ? '飞书列是摘要文本，不能安全还原本地结构'
              : column === FEISHU_FIELDS.updatedAt
                ? '这是本地更新时间的镜像，不是飞书的修改时间'
                : '该字段暂不支持反向还原'
          notApplied.add(column)
          changes.push(change)
          continue
        }
        if (column === FEISHU_FIELDS.title) {
          if (remoteValue.trim() === '') change.reason = '远端标题为空，不能覆盖有效标题'
          else patch.title = remoteValue.trim()
        } else if (column === FEISHU_FIELDS.note) {
          patch.note = remoteValue
        } else if (column === FEISHU_FIELDS.done) {
          if (remoteValue === '是') patch.done = true
          else if (remoteValue === '否') patch.done = false
          else change.reason = '完成列只接受「是」或「否」'
        } else if (column === FEISHU_FIELDS.list) {
          patch.listName = (remoteValue.trim() || '收集箱').slice(0, 60)
        } else if (column === FEISHU_FIELDS.priority) {
          if (PRIORITY_BY_NAME.has(remoteValue)) patch.priority = PRIORITY_BY_NAME.get(remoteValue)
          else change.reason = `无法识别优先级「${remoteValue}」`
        } else if (column === FEISHU_FIELDS.due || column === FEISHU_FIELDS.start) {
          const date = remoteValue === '' ? null : toDateStr(remoteValue)
          if (remoteValue !== '' && date === null) change.reason = `日期格式无效「${remoteValue}」`
          else patch[column === FEISHU_FIELDS.due ? 'due' : 'start'] = date
        } else if (column === FEISHU_FIELDS.tags) {
          patch.tags = remoteValue.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
        } else if (column === FEISHU_FIELDS.parent) {
          if (remoteValue === '') patch.parentId = null
          else {
            const ids = idsByTitle.get(remoteValue) ?? []
            if (ids.length === 0) change.reason = `本地找不到父任务「${remoteValue}」`
            else if (ids.length > 1) change.reason = `父任务标题「${remoteValue}」不唯一，无法确定父任务`
            else if (ids[0] === key || this.store.subtree(key).some((child) => child.id === ids[0])) {
              change.reason = '该父任务会形成循环关系，未导入'
            } else patch.parentId = ids[0]
          }
        }
        if (change.reason === '') change.applied = true
        else notApplied.add(column)
        changes.push(change)
      }
      if (changes.length > 0) {
        let depth = 0
        let parent = task.parentId === null ? null : this.store.get(task.parentId)
        while (parent !== null) {
          depth++
          parent = parent.parentId === null ? null : this.store.get(parent.parentId)
        }
        plans.push({
          key,
          title: task.title,
          recordId: row.recordId,
          patch,
          changes,
          remoteFields: row.fields,
          depth,
        })
      }
    }
    const planned = plans.filter((item) => Object.keys(item.patch).length > 0)
    const listNames = [...new Set(planned.map((item) => item.patch.listName).filter((name) =>
      typeof name === 'string' && name !== '' && this.store.listByname(name) === null))]
    const result = {
      keyField,
      remote: remote.length,
      matched,
      differing,
      planned: planned.length,
      updated: 0,
      updatedFields: 0,
      items: plans.map((item) => ({ key: item.key, title: item.title, changes: item.changes })),
      skipped,
      notApplied: [...notApplied],
      missingColumns: requiredColumns(keyField).filter((column) => !availableColumns.has(column)),
      createdLists: [],
      dryRun: opts.dryRun === true,
      previewToken: confirmationToken,
      startedAt,
    }
    if (result.dryRun === true || planned.length === 0) {
      result.finishedAt = nowStamp(this.now())
      return result
    }
    if (typeof opts.expectedToken !== 'string' || opts.expectedToken === '') {
      result.confirmationRequired = true
      result.finishedAt = nowStamp(this.now())
      return result
    }
    if (opts.expectedToken !== confirmationToken) {
      result.stale = true
      result.finishedAt = nowStamp(this.now())
      return result
    }

    // Parents first: their list is authoritative for subtasks, and a parent may
    // itself have moved to a Feishu-side list in this same import.
    planned.sort((a, b) => a.depth - b.depth)
    const appliedKeys = new Set()
    for (const item of planned) {
      try {
        const patch = { ...item.patch }
        if (typeof patch.listName === 'string') {
          const listName = patch.listName
          let list = this.store.listByname(listName)
          if (list === null) {
            list = this.store.createList({ name: listName }, { notify: false })
            if (!result.createdLists.includes(listName)) result.createdLists.push(listName)
          }
          patch.listId = list.id
          delete patch.listName
        }
        this.store.updateFromFeishu(item.key, patch)
        appliedKeys.add(item.key)
        result.updated++
        result.updatedFields += item.changes.filter((change) => change.applied).length
      } catch (e) {
        result.skipped.push({ key: item.key, reason: String(e?.message ?? e) })
      }
    }

    // Imported values are now a known common baseline wherever the local
    // projection actually matches the remote cell. Do not invent a baseline for
    // unsupported or invalid fields; the next push will ask instead of guessing.
    if (typeof this.store?.feishuBaseline === 'function' && typeof this.store?.setFeishuBaseline === 'function') {
      const scope = feishuSyncScope(this.config)
      const nextBaseline = Object.assign(Object.create(null), this.store.feishuBaseline(scope))
      for (const item of planned) {
        if (!appliedKeys.has(item.key)) continue
        const current = this.store.get(item.key)
        const localFields = taskToFields(current, this.store, { keyField })
        const baseFields = { ...(nextBaseline[item.key] ?? {}) }
        for (const change of item.changes) {
          if (change.applied && availableColumns.has(change.field)) baseFields[change.field] = fieldFingerprint(change.remote)
        }
        for (const [field, value] of Object.entries(localFields)) {
          if (!availableColumns.has(field)) continue
          const localValue = asText(value)
          const remoteValue = asText(item.remoteFields?.[field])
          if (localValue === remoteValue || field === FEISHU_FIELDS.updatedAt) baseFields[field] = fieldFingerprint(remoteValue)
        }
        if (Object.keys(baseFields).length > 0) nextBaseline[item.key] = baseFields
      }
      this.store.setFeishuBaseline(scope, nextBaseline)
    }
    this.store.flush?.()
    result.finishedAt = nowStamp(this.now())
    return result
  }
}
