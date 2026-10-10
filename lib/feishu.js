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

import {
  compareDates, dateOnly, describeRecurrence, nowStamp, today as todayStr,
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
  deleteRemoved: true,
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
  if (prune) {
    for (const record of remote) {
      const key = keyOf(record.fields, keyField)
      if (key !== '' && !localKeys.has(key)) deletes.push(record.recordId)
    }
  }

  return { creates, updates, deletes, unchanged, matched: localKeys.size - creates.length }
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
 * `逾期` / `子任务进度` are derived from other fields on the local side, and
 * `重复` holds a natural-language sentence (`describeRecurrence`) that cannot be
 * turned back into a rule; restoring a guess from it would silently change the
 * series, so it is reported as `notRestored` instead of guessed at.
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
    const rows = this.rows(opts)
    const remote = await this.client.listRecords()
    // Refusing beats duplicating: a table whose key column is missing or spelled
    // differently would otherwise receive a fresh copy of every task, every run.
    if (remote.length > 0 && keyedRemoteCount(remote, keyField) === 0) {
      throw new Error(`远端表格有 ${remote.length} 行，但没有一行带「${keyField}」字段：`
        + '请确认多维表格里有这个文本字段（可在设置里改 keyField），或先清空表格再同步')
    }
    const prune = opts.prune === undefined ? this.config.deleteRemoved !== false : opts.prune === true
    const plan = diffSync({ rows, remote, keyField, prune })
    const summary = {
      local: rows.length,
      remote: remote.length,
      unchanged: plan.unchanged,
      planned: {
        created: plan.creates.length,
        updated: plan.updates.length,
        deleted: plan.deletes.length,
      },
      created: 0,
      updated: 0,
      deleted: 0,
      dryRun: opts.dryRun === true,
      startedAt,
      keyField,
      tableId: this.config.tableId,
    }
    if (opts.dryRun === true) return summary
    summary.created = await this.client.batchCreate(plan.creates)
    summary.updated = await this.client.batchUpdate(plan.updates)
    summary.deleted = await this.client.batchDelete(plan.deletes)
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
    const rows = this.rows(opts)
    const remote = await this.client.listRecords()
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
      for (const [column, value] of Object.entries(mine.fields)) {
        if (asText(row.fields?.[column]) !== asText(value)) changed.push(column)
      }
      if (changed.length === 0) identical++
      else differing.push({ key, title: asText(mine.fields[FEISHU_FIELDS.title]), fields: changed })
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
          this.store.createList({ name: listName })
          if (!result.createdLists.includes(listName)) result.createdLists.push(listName)
        }
        this.store.create({ ...hole.input, id: hole.key })
        result.created++
      } catch (e) {
        result.skipped.push({ key: hole.key, reason: String(e?.message ?? e) })
      }
    }
    this.store.flush?.()
    result.finishedAt = nowStamp(this.now())
    return result
  }
}
