// The Feishu (Lark) Bitable sync.
//
// Everything runs against a fake transport that speaks Feishu's real envelope
// (`{ code, msg, data }`, with the tenant token at the TOP level), so this gate
// covers token caching, paging, batch bodies, idempotency, the key-field guard
// and the delete path without touching the network or a real workspace.
//
// The outward payloads are additionally validated with the runtime's own
// `snapshotJsonValue`, because that is what DSH applies to every reply.
import fs from 'node:fs'
import path from 'node:path'
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

import { TodoStore } from '../lib/store.js'
import {
  BATCH_LIMIT, COLUMN_TYPE_TEXT, FEISHU_DEFAULTS, FEISHU_FIELDS, FeishuClient, FeishuSync, asText, chunk,
  diffSync, feishuSyncScope, keyedRemoteCount, missingColumns, missingFeishuSettings, normalizeFeishuSettings,
  remoteRowToTask, requiredColumns, statusLabel, taskToFields,
} from '../lib/feishu.js'
import { TodoService } from '../lib/index.js'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })

/** Validate a crossing value with the real runtime validator. */
function gate(name, value) {
  let detail = null
  try { snapshotJsonValue(value) } catch (e) { detail = String(e?.message ?? e) }
  ok(`JSON gate: ${name}`, detail === null && isJsonValue(value), detail)
}

const dir = fs.mkdtempSync(path.join(import.meta.dirname, '..', '.tmp-feishu-'))
const T = '2026-09-17'
const fixedNow = () => new Date('2026-09-17T08:00:00Z')

// ---------------------------------------------------------------------------
// a fake Feishu tenant
// ---------------------------------------------------------------------------

function makeFeishuServer(opts = {}) {
  const state = {
    calls: [], auth: 0, records: new Map(), nextId: 1, failNext: null,
    // Columns the table already has. Empty = a table someone just created, which
    // is exactly the case 「补全字段」 exists for.
    fields: Array.isArray(opts.fields) ? [...opts.fields] : [],
    nextFieldId: 1,
  }
  const json = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  const fetch = async (url, init) => {
    const pathname = url.replace(/^https?:\/\/[^/]+/, '')
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    state.calls.push({ pathname, method: init.method, body, auth: init.headers.authorization ?? null })
    if (state.failNext !== null) {
      const next = state.failNext
      state.failNext = null
      return json(next)
    }
    if (pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      state.auth++
      if (opts.badAuth === true) return json({ code: 99991663, msg: 'app_id or app_secret invalid' })
      return json({ code: 0, msg: 'ok', tenant_access_token: 't-fake', expire: 7200 })
    }
    const all = () => [...state.records.entries()].map(([record_id, fields]) => ({ record_id, fields }))
    if (init.method === 'GET' && pathname.includes('/fields?')) {
      if (opts.fieldsFailure !== undefined) return json({ code: 1254005, msg: opts.fieldsFailure })
      return json({
        code: 0,
        data: {
          items: state.fields.map((name, i) => ({ field_id: `fld_${i}`, field_name: name, type: 1, is_primary: i === 0 })),
          has_more: false,
        },
      })
    }
    if (init.method === 'POST' && pathname.endsWith('/fields')) {
      // Feishu rejects a duplicate column name; the plugin must report that
      // rather than retry under a different name.
      if (state.fields.includes(body.field_name)) {
        return json({ code: 1254006, msg: `field name ${body.field_name} already exists` })
      }
      state.fields.push(body.field_name)
      const field = { field_id: `fld_new_${state.nextFieldId++}`, field_name: body.field_name, type: body.type }
      return json({ code: 0, data: { field } })
    }
    if (init.method === 'GET' && pathname.includes('/records?')) {
      if (opts.paginate === true) {
        const token = /page_token=(\d+)/.exec(pathname)
        const start = token === null ? 0 : Number(token[1])
        const items = all().slice(start, start + 2)
        const more = start + 2 < state.records.size
        return json({ code: 0, data: { items, has_more: more, page_token: more ? String(start + 2) : '' } })
      }
      return json({ code: 0, data: { items: all(), has_more: false } })
    }
    if (pathname.endsWith('/batch_create')) {
      const records = (body.records ?? []).map((r) => {
        const id = `rec_${state.nextId++}`
        state.records.set(id, r.fields)
        return { record_id: id, fields: r.fields }
      })
      return json({ code: 0, data: { records } })
    }
    if (pathname.endsWith('/batch_update')) {
      const records = (body.records ?? []).map((r) => {
        const merged = { ...(state.records.get(r.record_id) ?? {}), ...r.fields }
        state.records.set(r.record_id, merged)
        return { record_id: r.record_id, fields: merged }
      })
      return json({ code: 0, data: { records } })
    }
    if (pathname.endsWith('/batch_delete')) {
      const records = (body.records ?? []).filter((id) => state.records.delete(id)).map((id) => ({ record_id: id }))
      return json({ code: 0, data: { records } })
    }
    return json({ code: 1254005, msg: 'not found' })
  }
  return { state, fetch }
}

const seed = (server, rows) => {
  for (const fields of rows) server.state.records.set(`rec_seed_${server.state.nextId++}`, fields)
}

// ---------------------------------------------------------------------------
console.log('--- settings, missing fields, text coercion ---')
const defaults = normalizeFeishuSettings(undefined)
eq('an absent Feishu block becomes the documented defaults', defaults, { ...FEISHU_DEFAULTS })
eq('a blank string is treated as "not set"', normalizeFeishuSettings({ appId: '  ', tableId: ' tbl ' }).tableId, 'tbl')
eq('a non-URL baseUrl falls back to the default',
  normalizeFeishuSettings({ baseUrl: 'open.feishu.cn' }).baseUrl, FEISHU_DEFAULTS.baseUrl)
eq('a trailing slash is trimmed', normalizeFeishuSettings({ baseUrl: 'https://open.larksuite.com/' }).baseUrl,
  'https://open.larksuite.com')
eq('a non-boolean flag keeps its default', normalizeFeishuSettings({ enabled: 'yes' }).enabled, false)
eq('missingFeishuSettings lists the four ids/secrets', missingFeishuSettings(defaults),
  ['feishu.appId', 'feishu.appSecret', 'feishu.appToken', 'feishu.tableId'])
const scopeId = feishuSyncScope({ baseUrl: 'https://open.feishu.cn/', appToken: 'secret-table-token', tableId: 'table-secret', keyField: '任务ID' })
ok('the sync baseline scope is stable but does not persist table identifiers',
  scopeId.length === 64 && !scopeId.includes('secret-table-token') && !scopeId.includes('table-secret'), scopeId)

eq('asText: string', asText('x'), 'x')
eq('asText: number', asText(42), '42')
eq('asText: non-finite number', asText(Number.NaN), '')
eq('asText: boolean', asText(true), '是')
eq('asText: null', asText(null), '')
// Bitable returns some text columns as segment arrays; comparing raw values
// across a round trip would report every row as changed.
eq('asText: segment array', asText([{ type: 'text', text: '交' }, { type: 'text', text: '报告' }]), '交报告')
eq('asText: link object', asText({ text: '看板', link: 'https://x' }), '看板')
eq('asText: unknown object', asText({ nope: 1 }), '')

eq('chunk splits into Feishu-sized batches', chunk(Array.from({ length: 1200 }, (_, i) => i), BATCH_LIMIT)
  .map((b) => b.length), [500, 500, 200])
eq('chunk of nothing is nothing', chunk([]), [])

console.log('--- status labels: every state the table can be filtered on ---')
const fake = { done: false, due: null }
eq('a done task reads 已完成', statusLabel({ ...fake, done: true }, { today: T }), '已完成')
eq('an overdue task reads 已逾期', statusLabel({ ...fake, due: '2026-09-10' }, { today: T }), '已逾期')
eq('a task due today reads 今天到期', statusLabel({ ...fake, due: T }, { today: T }), '今天到期')
eq('anything else reads 未完成', statusLabel({ ...fake, due: '2026-09-20' }, { today: T }), '未完成')
eq('an undated task reads 未完成', statusLabel({ ...fake }, { today: T }), '未完成')

console.log('--- one task as one Bitable row ---')
const store = new TodoStore({ dataFile: path.join(dir, 'tasks.json'), saveDelay: 5 }).load()
const work = store.createList({ name: '工作' })
const report = store.create({
  title: '交季度报告', due: '2026-09-20', start: '2026-09-18', priority: 3,
  tags: ['重要', '报告'], note: '先拉数据', listId: work.id, recurrence: { freq: 'weekly', weekdays: [5] },
})
const sub1 = store.addSubtask(report.id, { title: '拉数据' })
store.addSubtask(report.id, { title: '画图' })
store.toggle(sub1.id, { today: T })
const fields = taskToFields(report, store, { today: T })
eq('the key column carries the task id', fields['任务ID'], report.id)
eq('the title is mirrored', fields['标题'], '交季度报告')
eq('the status is mirrored', fields['状态'], '未完成')
eq('完成 is 否 while open', fields['完成'], '否')
eq('逾期 is 否 while not overdue', fields['逾期'], '否')
eq('the list name is mirrored, not the id', fields['清单'], '工作')
eq('priority is mirrored as a name', fields['优先级'], '高')
eq('due and start are mirrored verbatim', [fields['截止时间'], fields['开始时间']], ['2026-09-20', '2026-09-18'])
eq('tags are joined', fields['标签'], '重要, 报告')
eq('subtask progress counts done/total', fields['子任务进度'], '1/2')
ok('the recurrence is mirrored as prose', typeof fields['重复'] === 'string' && fields['重复'].length > 0, fields['重复'])
eq('the note rides along', fields['备注'], '先拉数据')
const childFields = taskToFields(store.get(sub1.id), store, { today: T })
eq('a subtask row names its parent', childFields['父任务'], '交季度报告')
eq('a top-level row has no parent', fields['父任务'], '')
eq('the key column name is configurable', taskToFields(report, store, { today: T, keyField: 'ID' }).ID, report.id)

const completionSource = store.create({ title: '已提交软著申请', due: T })
const completedSource = store.toggle(completionSource.id, {
  today: T,
  completionSummary: '材料已经提交，等待审批。',
  followUp: { title: '核对审批结果', due: '2026-10-17' },
})
const completionRecord = completedSource.completionRecords.at(-1)
const completionFollowUp = store.get(completionRecord.followUpTaskId)
const completedFields = taskToFields(completedSource, store, { today: T })
const followUpFields = taskToFields(completionFollowUp, store, { today: T })
eq('the completion history is mirrored in its own Feishu column',
  completedFields[FEISHU_FIELDS.completionRecords],
  `${completionRecord.at.replace('T', ' ')}｜材料已经提交，等待审批。`)
ok('the source row mirrors its related follow-up task',
  completedFields[FEISHU_FIELDS.relatedFollowUps].includes(`跟进任务：核对审批结果（${completionFollowUp.id}；未完成；截止 2026-10-17）`))
ok('the follow-up row mirrors its source task',
  followUpFields[FEISHU_FIELDS.relatedFollowUps].includes(`来源任务：已提交软著申请（${completedSource.id}）`))
gate('a mapped row with completion history is lossless JSON', completedFields)
gate('a mapped follow-up row is lossless JSON', followUpFields)
gate('a mapped row is lossless JSON', fields)

console.log('--- the pure diff ---')
const remote = [
  { recordId: 'r1', fields: { 任务ID: 't_a', 标题: '一样' } },
  { recordId: 'r2', fields: { 任务ID: 't_b', 标题: '旧标题' } },
  { recordId: 'r3', fields: { 标题: '别人手写的行' } },
]
const plan = diffSync({
  rows: [
    { key: 't_a', fields: { 任务ID: 't_a', 标题: '一样' } },
    { key: 't_b', fields: { 任务ID: 't_b', 标题: '新标题' } },
    { key: 't_c', fields: { 任务ID: 't_c', 标题: '新的' } },
  ],
  remote,
  keyField: '任务ID',
})
eq('an identical row is unchanged', plan.unchanged, 1)
eq('a missing row is created', plan.creates, [{ 任务ID: 't_c', 标题: '新的' }])
eq('a changed row updates only the changed fields', plan.updates, [{ recordId: 'r2', fields: { 标题: '新标题' } }])
eq('nothing is deleted by default', plan.deletes, [])
eq('keyedRemoteCount counts only our rows', keyedRemoteCount(remote, '任务ID'), 2)

// Deletion needs BOTH the switch and a tombstone. "A remote row whose key is not
// a local task" is not evidence of anything -- it is also the exact shape of a
// row another machine or another person put there.
const gone = [{ key: 't_a', fields: { 任务ID: 't_a' } }]
eq('a vanished row is not deleted without the switch',
  diffSync({ rows: gone, remote, keyField: '任务ID', prune: false, tombstones: ['t_b'] }).deletes, [])
eq('a vanished row is not deleted without a tombstone',
  diffSync({ rows: gone, remote, keyField: '任务ID', prune: true, tombstones: [] }).deletes, [])
eq('a vanished row IS deleted with both',
  diffSync({ rows: gone, remote, keyField: '任务ID', prune: true, tombstones: ['t_b'] }).deletes, ['r2'])
eq('and the key is reported so the tombstone can be retired',
  diffSync({ rows: gone, remote, keyField: '任务ID', prune: true, tombstones: ['t_b'] }).deletedKeys, ['t_b'])
eq('a foreign row is never deleted, even with the switch on',
  diffSync({ rows: gone, remote, keyField: '任务ID', prune: true, tombstones: ['t_b'] }).deletes.includes('r3'), false)
// A keyed row we do not own is the interesting case: it cannot be deleted, and
// the report has to say it was left alone.
eq('a foreign KEYED row is counted for the report',
  diffSync({
    rows: gone,
    remote: [...remote, { recordId: 'r4', fields: { 任务ID: 't_other', 标题: '别人的任务' } }],
    keyField: '任务ID',
    prune: true,
    tombstones: ['t_b'],
  }).unmanaged, 1)
eq('a keyless row is never counted as unmanaged either',
  diffSync({ rows: gone, remote, keyField: '任务ID', prune: true, tombstones: ['t_b'] }).unmanaged, 0)
// Bitable may hand back a text cell as segments; that must not read as a change.
eq('a segment-array cell still compares equal',
  diffSync({
    rows: [{ key: 't_a', fields: { 任务ID: 't_a', 标题: '交报告' } }],
    remote: [{ recordId: 'r1', fields: { 任务ID: 't_a', 标题: [{ text: '交报告' }] } }],
    keyField: '任务ID',
  }).unchanged, 1)

console.log('--- the transport ---')
const server = makeFeishuServer()
const config = normalizeFeishuSettings({
  enabled: true, appId: 'cli_x', appSecret: 'sec', appToken: 'bascn', tableId: 'tbl',
})
const client = new FeishuClient(config, { fetch: server.fetch, now: () => 1000 })
await client.tenantToken()
await client.tenantToken()
eq('the tenant token is requested once and cached', server.state.auth, 1)
const authCall = server.state.calls[0]
eq('the token request carries the credentials', authCall.body, { app_id: 'cli_x', app_secret: 'sec' })
ok('the token request is not Bearer-authenticated', authCall.auth === null, authCall.auth)

const bearerServer = makeFeishuServer()
const bearerClient = new FeishuClient(config, { fetch: bearerServer.fetch, now: () => 1000 })
await bearerClient.listRecords()
ok('the records call is Bearer-authenticated',
  bearerServer.state.calls.some((c) => c.method === 'GET' && c.auth === 'Bearer t-fake'),
  bearerServer.state.calls.map((c) => c.auth))

const paged = makeFeishuServer({ paginate: true })
seed(paged, Array.from({ length: 5 }, (_, i) => ({ 任务ID: `t_${i}`, 标题: `第 ${i} 行` })))
const pagedClient = new FeishuClient(config, { fetch: paged.fetch, now: () => 1000 })
const pagedRecords = await pagedClient.listRecords()
eq('paging follows page_token to the end', pagedRecords.length, 5)
eq('paging does not re-request the token', paged.state.auth, 1)

const failing = makeFeishuServer({ badAuth: true })
const failingClient = new FeishuClient(config, { fetch: failing.fetch, now: () => 1000 })
let authError = null
try { await failingClient.tenantToken() } catch (e) { authError = e }
ok('a non-zero envelope code becomes a readable error',
  authError !== null && authError.message.includes('app_id or app_secret invalid'), authError?.message)

const bigServer = makeFeishuServer()
const bigClient = new FeishuClient(config, { fetch: bigServer.fetch, now: () => 1000 })
const created = await bigClient.batchCreate(Array.from({ length: 1200 }, (_, i) => ({ 任务ID: `t_${i}` })))
eq('1200 rows are written as three batches', bigServer.state.calls.filter((c) => c.pathname.endsWith('/batch_create')).length, 3)
eq('the created count adds up', created, 1200)
eq('foreign rows already in the table are not touched by a create', bigServer.state.records.size, 1200)

console.log('--- a full sync: idempotent by construction ---')
const syncStore = new TodoStore({ dataFile: path.join(dir, 'sync.json'), saveDelay: 5 }).load()
const a = syncStore.create({ title: '交季度报告', due: '2026-09-20', tags: ['重要'] })
const b = syncStore.create({ title: '买牛奶', due: '2026-09-18' })
syncStore.addSubtask(a.id, { title: '拉数据' })
const syncServer = makeFeishuServer()
const sync = new FeishuSync(config, syncStore, { fetch: syncServer.fetch, now: fixedNow })
const first = await sync.run({ today: T })
eq('the first run creates one row per task (subtask included)', first.planned.created, 3)
eq('the first run reports what it wrote', [first.created, first.updated, first.deleted], [3, 0, 0])
eq('the summary names the key field', first.keyField, '任务ID')
eq('the auth token is fetched once for the whole run', syncServer.state.auth, 1)
gate('a sync summary is lossless JSON', first)
const initialBaseline = syncStore.feishuBaseline(feishuSyncScope(config))
ok('the first successful sync stores per-field baseline fingerprints',
  initialBaseline[a.id]?.['标题']?.startsWith('sha256:') === true, initialBaseline[a.id])
ok('baseline storage does not duplicate raw task content',
  !JSON.stringify(initialBaseline).includes('交季度报告'), initialBaseline[a.id])
const reloadedSyncStore = new TodoStore({ dataFile: path.join(dir, 'sync.json'), saveDelay: 5 }).load()
eq('per-field fingerprints survive a store reload',
  reloadedSyncStore.feishuBaseline(feishuSyncScope(config)), initialBaseline)
reloadedSyncStore.dispose()

const second = await sync.run({ today: T })
eq('a second run creates nothing', second.created, 0)
eq('a second run updates nothing', second.updated, 0)
eq('a second run leaves every row unchanged', second.unchanged, 3)

console.log('--- status changes propagate ---')
syncStore.toggle(a.id, { today: T })
const third = await sync.run({ today: T })
eq('completing a task updates exactly one row', [third.created, third.updated, third.deleted], [0, 1, 0])
const updateCall = syncServer.state.calls.filter((c) => c.pathname.endsWith('/batch_update')).pop()
const changedFields = Object.keys(updateCall.body.records[0].fields)
// Only the changed fields are sent: an unchanged title or due date in the body
// would still be a rewrite of a column the user may have edited by hand.
ok('the update body carries status and completion-history columns',
  changedFields.includes('状态') && changedFields.includes('完成')
  && changedFields.includes(FEISHU_FIELDS.completionRecords), changedFields)
ok('the update body leaves the unchanged columns alone',
  !changedFields.includes('标题') && !changedFields.includes('截止时间') && !changedFields.includes('任务ID'),
  changedFields)
const remoteA = [...syncServer.state.records.values()].find((f) => f['任务ID'] === a.id)
eq('the remote status now reads 已完成', remoteA['状态'], '已完成')
eq('the remote 完成 column now reads 是', remoteA['完成'], '是')
const syncedCompletionRecord = syncStore.get(a.id).completionRecords.at(-1)
eq('the remote completion-history column carries the timestamp and optional-empty marker',
  remoteA[FEISHU_FIELDS.completionRecords],
  `${syncedCompletionRecord.at.replace('T', ' ')}｜（未填写完成情况）`)

console.log('--- sync conflict protection uses a shared baseline, never timestamps ---')
{
  const conflictStore = new TodoStore({ dataFile: path.join(dir, 'conflicts.json'), saveDelay: 5 }).load()
  const conflictTask = conflictStore.create({ id: 't_conflict', title: '共同标题', note: '共同备注' })
  const safeTask = conflictStore.create({ id: 't_safe', title: '安全任务', note: '旧备注' })
  const conflictServer = makeFeishuServer()
  const conflictSync = new FeishuSync(config, conflictStore, { fetch: conflictServer.fetch, now: fixedNow })
  const common = await conflictSync.run({ today: T })
  eq('the initial common state is written', common.created, 2)
  const recordFor = (key) => [...conflictServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === key)
  const [conflictRecordId, conflictFields] = recordFor(conflictTask.id)
  conflictFields['标题'] = '飞书端标题'
  conflictStore.update(conflictTask.id, { title: '本地端标题' })
  conflictStore.update(safeTask.id, { note: '仅本地修改' })

  const preview = await conflictSync.run({ today: T, dryRun: true })
  eq('a remote and local edit blocks the default plan', preview.blocked, true)
  eq('the conflicting field is named', preview.conflicts[0].changes.map((item) => item.field), ['标题'])
  eq('the conflict contains the actual local and remote values',
    [preview.conflicts[0].changes[0].local, preview.conflicts[0].changes[0].remote], ['本地端标题', '飞书端标题'])
  eq('the conflict is classified as a two-sided change', preview.conflicts[0].changes[0].reason, 'both')
  ok('a preview carries a confirmation snapshot token', typeof preview.previewToken === 'string' && preview.previewToken.length === 64)
  const beforeBlockedWrites = conflictServer.state.calls.filter((call) => /batch_(create|update|delete)$/.test(call.pathname)).length
  const blocked = await conflictSync.run({ today: T })
  eq('the ordinary sync stops instead of silently overwriting', blocked.blocked, true)
  eq('the blocked sync writes no records',
    conflictServer.state.calls.filter((call) => /batch_(create|update|delete)$/.test(call.pathname)).length,
    beforeBlockedWrites)

  const report = await conflictSync.reconcile({ today: T })
  const rowReport = report.differing.find((row) => row.key === conflictTask.id)
  eq('reconciliation records the field values and direction',
    [rowReport.changes[0].local, rowReport.changes[0].remote, rowReport.changes[0].direction],
    ['本地端标题', '飞书端标题', 'both'])

  const skipped = await conflictSync.run({ today: T, conflictPolicy: 'skip' })
  eq('skip policy records that conflict was skipped', skipped.skippedConflicts, 1)
  eq('skip policy still writes a safe local-only edit', skipped.updated, 1)
  eq('skip policy leaves the remote conflict intact', recordFor(conflictTask.id)[1]['标题'], '飞书端标题')
  eq('safe changes reach the table', recordFor(safeTask.id)[1]['备注'], '仅本地修改')

  const pushed = await conflictSync.run({ today: T, conflictPolicy: 'push' })
  eq('push policy is explicit and resolves the selected conflict', pushed.blocked, false)
  eq('push policy writes the local value', recordFor(conflictTask.id)[1]['标题'], '本地端标题')
  const persisted = conflictStore.feishuBaseline(feishuSyncScope(config))[conflictTask.id]
  ok('the new common baseline remains a fingerprint, not cleartext',
    persisted['标题'].startsWith('sha256:') && persisted['标题'] !== '本地端标题', persisted)

  // A plan also depends on the local baseline and tombstone whitelist, not only
  // the visible records. Changing that planning state must invalidate its token.
  const conflictScope = feishuSyncScope(config)
  const savedBaseline = conflictStore.feishuBaseline(conflictScope)
  const statePreview = await conflictSync.run({ today: T, dryRun: true, conflictPolicy: 'push' })
  conflictStore.setFeishuBaseline(conflictScope, {
    ...savedBaseline,
    [conflictTask.id]: { ...savedBaseline[conflictTask.id], 标题: 'sha256:changed-baseline' },
  })
  const baselineStale = await conflictSync.run({
    today: T, expectedToken: statePreview.previewToken, conflictPolicy: 'push',
  })
  eq('a baseline change after preview invalidates confirmation', baselineStale.stale, true)
  conflictStore.setFeishuBaseline(conflictScope, savedBaseline)

  // A changed remote value after a preview must invalidate confirmation, even
  // when the current policy would otherwise push it.
  conflictStore.update(conflictTask.id, { title: '本地再次编辑' })
  const stalePreview = await conflictSync.run({ today: T, dryRun: true })
  recordFor(conflictTask.id)[1]['标题'] = '预览后飞书改动'
  const writesBeforeStale = conflictServer.state.calls.filter((call) => /batch_(create|update|delete)$/.test(call.pathname)).length
  const stale = await conflictSync.run({ today: T, expectedToken: stalePreview.previewToken, conflictPolicy: 'push' })
  eq('a changed remote snapshot is rejected at confirmation', stale.stale, true)
  eq('stale confirmation writes nothing',
    conflictServer.state.calls.filter((call) => /batch_(create|update|delete)$/.test(call.pathname)).length,
    writesBeforeStale)
  eq('the post-preview remote edit survives untouched', recordFor(conflictTask.id)[1]['标题'], '预览后飞书改动')
}

console.log('--- field decisions are scoped to one task, one field, and one preview ---')
const scopedStore = new TodoStore({ dataFile: path.join(dir, 'scoped-fields.json'), saveDelay: 5 }).load()
const scopedTask = scopedStore.create({ id: 't_scoped', title: '共同标题', note: '共同备注' })
const scopedServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const scopedSync = new FeishuSync(config, scopedStore, { fetch: scopedServer.fetch, now: fixedNow })
await scopedSync.run({ today: T })
const scopedRecord = [...scopedServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === scopedTask.id)
scopedStore.update(scopedTask.id, { title: '本地标题', note: '本地备注' })
scopedRecord[1]['标题'] = '飞书标题'
scopedRecord[1]['备注'] = '飞书备注'
const titleOnlyPreview = await scopedSync.run({
  today: T, keys: [scopedTask.id], fields: ['标题'], conflictPolicy: 'skip', dryRun: true,
})
eq('a field-scoped preview only reports the selected field',
  titleOnlyPreview.conflicts[0]?.changes.map((change) => change.field), ['标题'])
eq('the preview still confirms the exact task/field scope', titleOnlyPreview.blocked, false)
const wrongFieldToken = await scopedSync.run({
  today: T, keys: [scopedTask.id], fields: ['备注'], conflictPolicy: 'push',
  expectedToken: titleOnlyPreview.previewToken,
})
eq('a preview token cannot be reused for a different field', wrongFieldToken.stale, true)
scopedServer.state.calls.length = 0
const titleOnlyApplied = await scopedSync.run({
  today: T, keys: [scopedTask.id], fields: ['标题'], conflictPolicy: 'push',
  expectedToken: titleOnlyPreview.previewToken,
})
const currentScopedFields = scopedServer.state.records.get(scopedRecord[0])
eq('an explicit field decision writes the chosen local value', currentScopedFields['标题'], '本地标题')
eq('the same-row unselected Feishu field remains untouched', currentScopedFields['备注'], '飞书备注')
eq('the batch payload contains only the selected field',
  scopedServer.state.calls.find((call) => call.pathname.endsWith('/batch_update'))?.body.records[0].fields,
  { 标题: '本地标题' })
eq('the confirmed field decision updates one remote row', titleOnlyApplied.updated, 1)
scopedStore.dispose()

console.log('--- deletions are opt-in, tombstone-gated, and conflict-safe ---')
syncStore.remove(b.id)
// Default is OFF, so the same removal now deletes nothing from the table.
const withoutOptIn = await sync.run({ today: T })
eq('a local delete does NOT touch the table by default',
  [withoutOptIn.created, withoutOptIn.updated, withoutOptIn.deleted], [0, 0, 0])
ok('and the row is still there',
  [...syncServer.state.records.values()].some((f) => f['任务ID'] === b.id))
ok('and the run says the row is not managed', withoutOptIn.unmanaged >= 1, withoutOptIn.unmanaged)

// Opted in: the row goes, because the store recorded the deletion on purpose.
const pruneSync = new FeishuSync({ ...config, deleteRemoved: true }, syncStore, {
  fetch: syncServer.fetch, now: fixedNow,
})
const fourth = await pruneSync.run({ today: T })
eq('with the switch on, a tombstoned row is deleted',
  [fourth.created, fourth.updated, fourth.deleted], [0, 0, 1])
ok('the deleted row is gone from the table',
  [...syncServer.state.records.values()].every((f) => f['任务ID'] !== b.id))

const c = syncStore.create({ title: '新任务' })
const beforeDry = syncServer.state.calls.length
const dry = await sync.run({ today: T, dryRun: true })
eq('a dry run plans the create', dry.planned.created, 1)
eq('a dry run writes nothing', dry.created, 0)
eq('a dry run makes no write calls', syncServer.state.calls.length - beforeDry, 1)
const afterDry = await sync.run({ today: T })
eq('the real run after the dry run does the create', afterDry.created, 1)

const guardServer = makeFeishuServer()
seed(guardServer, [{ 标题: '没有任务ID列的行' }, { 标题: '另一行' }])
const guardSync = new FeishuSync(config, syncStore, { fetch: guardServer.fetch, now: fixedNow })
let guardError = null
try { await guardSync.run({ today: T }) } catch (e) { guardError = e }
ok('a table without the key column is refused, not duplicated',
  guardError !== null && guardError.message.includes('任务ID') && guardError.message.includes('2 行'),
  guardError?.message)
eq('the refused run wrote nothing', guardServer.state.calls.filter((c) => c.pathname.endsWith('/batch_create')).length, 0)

const emptyServer = makeFeishuServer()
const emptySync = new FeishuSync(config, new TodoStore({ dataFile: path.join(dir, 'empty.json'), saveDelay: 5 }).load(),
  { fetch: emptyServer.fetch, now: fixedNow })
const empty = await emptySync.run({ today: T })
eq('an empty workspace syncs zero rows', [empty.local, empty.created], [0, 0])

console.log('--- the service surface (settings -> sync -> status) ---')
const serviceServer = makeFeishuServer()
const svc = new TodoService(null, () => {}, { fetch: serviceServer.fetch, settingsFile: path.join(dir, 'svc-settings.json') })
svc.applySettings({
  dataFile: path.join(dir, 'service.json'),
  feishu: { enabled: true, appId: 'cli_x', appSecret: 'top-secret', appToken: 'bascn', tableId: 'tbl' },
})
// The deep merge is load-bearing: a settings document that sets only the four
// ids must keep the documented defaults for everything else.
eq('a partial Feishu block keeps the other defaults', svc.settings.feishu.baseUrl, FEISHU_DEFAULTS.baseUrl)
eq('a partial Feishu block keeps autoSync off', svc.settings.feishu.autoSync, false)
const initial = svc.feishuStatus()
eq('status reports it as configured', initial.configured, true)
eq('status reports the missing list as empty', initial.missing, [])
ok('status never leaks the app secret', !JSON.stringify(initial).includes('top-secret'), initial)
gate('feishuStatus is lossless JSON', initial)

const svcStore = svc.require()
svcStore.create({ title: '服务层任务', due: '2026-09-20' })
const result = await svc.syncFeishu({ today: T })
// The service returns the summary DIRECTLY, like its four sibling actions. It
// used to be the one action wrapped in `{ ok, summary }`, and the settings page
// read the wrapper -- which rendered "本地 undefined 行 / 远端 undefined 行".
eq('the service returns the sync summary directly', typeof result.local, 'number')
eq('the service syncs through the injected transport', result.created, 1)
const after = svc.feishuStatus()
eq('status remembers the last sync', after.lastSync.ok, true)
eq('status records what the last sync did', after.lastSync.summary.created, 1)
gate('feishuStatus after a sync is lossless JSON', after)

const failing2 = makeFeishuServer({ badAuth: true })
const svc2 = new TodoService(null, () => {}, { fetch: failing2.fetch, settingsFile: path.join(dir, 'svc2-settings.json') })
svc2.applySettings({
  dataFile: path.join(dir, 'service2.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
})
svc2.require()
let syncError = null
try { await svc2.syncFeishu({}) } catch (e) { syncError = e }
ok('a failed sync throws', syncError !== null, syncError?.message)
eq('a failed sync is remembered as failed', svc2.feishuStatus().lastSync.ok, false)
ok('the remembered error is a string', typeof svc2.feishuStatus().lastSync.error === 'string')
gate('feishuStatus after a failure is lossless JSON', svc2.feishuStatus())

console.log('--- the service exposes the setup surface, not just the engine ---')
// The engine tests above prove the four capabilities work. This proves the other
// half -- the part a button actually calls: the enable-switch policy (setup and
// diagnosis run before the switch, mirroring runs after it) and the wiring of
// the injected transport through the service.
const svcServer = makeFeishuServer({ fields: [] })
const wired = new TodoService(null, () => {}, {
  fetch: svcServer.fetch,
  settingsFile: path.join(dir, 'wired-settings.json'),
})
wired.applySettings({
  dataFile: path.join(dir, 'wired.json'),
  feishu: { enabled: false, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
})
const wiredProbe = await wired.testFeishu()
eq('the service tests the connection with the switch OFF', wiredProbe.ok, true)
eq('the service token step ran', wiredProbe.tokenOk, true)
eq('the service reports the empty table as missing every column', wiredProbe.columns.missing.length, requiredColumns('任务ID').length)
gate('the service probe payload is lossless JSON', wiredProbe)

const wiredFields = await wired.ensureFeishuFields({})
eq('the service can complete the columns with the switch OFF', wiredFields.created.length, requiredColumns('任务ID').length)
eq('and created nothing else', wiredFields.failed, [])

// sync and pull stay behind the switch: one write direction has an off switch,
// and it has to mean something.
let wiredSync = null
try { await wired.syncFeishu({}) } catch (e) { wiredSync = e }
ok('the service refuses to sync while the switch is off',
  wiredSync !== null && String(wiredSync.message).includes('未启用'), wiredSync?.message)
let wiredPull = null
try { await wired.pullFeishu({}) } catch (e) { wiredPull = e }
ok('the service refuses to pull while the switch is off',
  wiredPull !== null && String(wiredPull.message).includes('未启用'), wiredPull?.message)

// Once the switch is on, the wiring itself is exercised end to end: read the
// table, plan the holes, create them locally.
seed(svcServer, [{ 任务ID: 't_wired', 标题: '从服务层补回来的任务' }])
wired.updateSettings({ feishu: { enabled: true } })
const callsBeforeReconcile = svcServer.state.calls.length
const wiredReport = await wired.reconcileFeishu({})
eq('the service reconciles with the switch on', wiredReport.remote, 1)
eq('and sees the row as a hole', wiredReport.remoteOnly.map((r) => r.key), ['t_wired'])
ok('reconcile writes nothing: every call it made was a read', svcServer.state.calls
  .slice(callsBeforeReconcile)
  .every((call) => call.method === 'GET' || call.pathname.includes('tenant_access_token')))
const wiredPulled = await wired.pullFeishu({})
eq('the service pulls the hole', wiredPulled.created, 1)
ok('and the task now exists locally', wired.require().get('t_wired') !== null)
gate('the service pull payload is lossless JSON', wiredPulled)
const wiredRecord = [...svcServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === 't_wired')
wiredRecord[1]['标题'] = '由服务层反向更新'
const wiredApplyPreview = await wired.applyFeishuRemote({ dryRun: true })
eq('the service previews a Feishu edit to an existing local task', wiredApplyPreview.planned, 1)
eq('the service preview leaves the local title untouched', wired.require().get('t_wired').title, '从服务层补回来的任务')
gate('the service apply-remote preview payload is lossless JSON', wiredApplyPreview)
const wiredApplied = await wired.applyFeishuRemote({ previewToken: wiredApplyPreview.previewToken })
eq('the service applies the matching preview token', wiredApplied.updated, 1)
eq('the service updated the existing task title', wired.require().get('t_wired').title, '由服务层反向更新')
gate('the service apply-remote result is lossless JSON', wiredApplied)

console.log('--- entry reconciliation merges safe changes and holds both-sided conflicts ---')
const entryServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const entrySvc = new TodoService(null, () => {}, {
  fetch: entryServer.fetch, settingsFile: path.join(dir, 'entry-settings.json'),
})
entrySvc.applySettings({
  dataFile: path.join(dir, 'entry.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false },
})
const entryStore = entrySvc.require()
const entryRemoteEdit = entryStore.create({ id: 't_entry_remote', title: '共同标题（远端单侧）' })
const entryLocalEdit = entryStore.create({ id: 't_entry_local', title: '共同标题（本地单侧）', note: '共同备注' })
const entryConflictTask = entryStore.create({ id: 't_entry_conflict', title: '共同冲突标题' })
await entrySvc.syncFeishu({ today: T })
const entryRemoteRecord = [...entryServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === entryRemoteEdit.id)
const currentEntryRecord = (id) => [...entryServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === id)
entryRemoteRecord[1]['标题'] = '飞书单侧标题'
entryStore.update(entryLocalEdit.id, { note: '本地单侧备注' })
entryStore.update(entryConflictTask.id, { title: '本地冲突标题' })
currentEntryRecord(entryConflictTask.id)[1]['标题'] = '飞书冲突标题'
const entryLocalNew = entryStore.create({ id: 't_entry_new', title: '本地新任务' })
const entryHole = { 任务ID: 't_entry_hole', 标题: '飞书独有任务', 备注: '只从飞书补回' }
entryServer.state.records.set('rec_entry_hole', entryHole)
entryServer.state.calls.length = 0
const entryResult = await entrySvc.feishuEntrySync({ today: T })
eq('entry sync imports exactly the remote-only task', entryResult.imported, 1)
eq('the remote-only task becomes a local task', entryStore.get('t_entry_hole')?.title, '飞书独有任务')
eq('entry sync safely applies a remote-only field edit', entryStore.get(entryRemoteEdit.id)?.title, '飞书单侧标题')
eq('entry sync safely pushes a local-only field edit', currentEntryRecord(entryLocalEdit.id)[1]['备注'], '本地单侧备注')
eq('entry sync creates a local-only task in Feishu',
  [...entryServer.state.records.values()].find((fields) => fields['任务ID'] === entryLocalNew.id)?.['标题'], '本地新任务')
eq('entry sync preserves both values for the two-sided edit',
  [entryStore.get(entryConflictTask.id)?.title, currentEntryRecord(entryConflictTask.id)[1]['标题']],
  ['本地冲突标题', '飞书冲突标题'])
eq('the new pull-only row is not written back during this entry pass',
  entryServer.state.calls.some((call) => call.pathname.endsWith('/batch_update')
    && (call.body?.records ?? []).some((record) => record.record_id === 'rec_entry_hole')), false)
eq('the entry payload exposes only the safe Feishu switch in task settings', entryResult.state.settings.feishu.enabled, true)
eq('entry conflict details stay visible by task and field',
  entryResult.conflicts.map((conflict) => [conflict.key, conflict.changes.map((change) => change.field)]),
  [[entryConflictTask.id, ['标题']]])
gate('entry reconciliation result is lossless JSON', entryResult)
const entryRemoteChoice = await entrySvc.resolveFeishuConflict({
  key: entryConflictTask.id,
  field: '标题',
  direction: 'remote',
  expected: { local: '本地冲突标题', remote: '飞书冲突标题' },
})
eq('accepting a displayed Feishu field resolves only that field',
  [entryRemoteChoice.resolved, entryRemoteChoice.field, entryStore.get(entryConflictTask.id)?.title],
  [true, '标题', '飞书冲突标题'])
eq('accepting the Feishu value leaves the unrelated note untouched', entryStore.get(entryLocalEdit.id)?.note, '本地单侧备注')
gate('field conflict resolution is lossless JSON', entryRemoteChoice)
entryStore.update(entryConflictTask.id, { title: '第二次本地标题' })
currentEntryRecord(entryConflictTask.id)[1]['标题'] = '第二次飞书标题'
const secondEntryResult = await entrySvc.feishuEntrySync({ today: T })
const secondConflict = secondEntryResult.conflicts.find((conflict) => conflict.key === entryConflictTask.id)
const entryLocalChoice = await entrySvc.resolveFeishuConflict({
  key: entryConflictTask.id,
  field: '标题',
  direction: 'local',
  expected: { local: '第二次本地标题', remote: '第二次飞书标题' },
})
eq('accepting a displayed local field pushes only the chosen local value',
  [entryLocalChoice.resolved, currentEntryRecord(entryConflictTask.id)[1]['标题']], [true, '第二次本地标题'])
eq('a second reconciliation clears the resolved conflict',
  (await entrySvc.feishuEntrySync({ today: T })).conflicts.some((conflict) => conflict.key === entryConflictTask.id), false)
gate('second entry conflict is JSON-safe', secondEntryResult)
entrySvc.dispose()

console.log('--- entry previews reject a changed local or remote snapshot ---')
const remoteRaceServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const remoteRaceSvc = new TodoService(null, () => {}, {
  fetch: remoteRaceServer.fetch, settingsFile: path.join(dir, 'remote-race-settings.json'),
})
remoteRaceSvc.applySettings({
  dataFile: path.join(dir, 'remote-race.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false },
})
const remoteRaceStore = remoteRaceSvc.require()
const remoteRaceTask = remoteRaceStore.create({ id: 't_remote_race', title: '共同标题' })
await remoteRaceSvc.syncFeishu({ today: T })
const remoteRaceRecord = [...remoteRaceServer.state.records.entries()]
  .find(([, fields]) => fields['任务ID'] === remoteRaceTask.id)
remoteRaceRecord[1]['标题'] = '远端预览前标题'
remoteRaceServer.state.calls.length = 0
const originalRemoteRaceEngine = remoteRaceSvc.feishuEngine.bind(remoteRaceSvc)
let remoteRaceTriggered = false
remoteRaceSvc.feishuEngine = (...args) => {
  const engine = originalRemoteRaceEngine(...args)
  const applyRemote = engine.applyRemote.bind(engine)
  engine.applyRemote = async (options) => {
    const result = await applyRemote(options)
    if (options.dryRun === true && result.planned > 0 && !remoteRaceTriggered) {
      remoteRaceTriggered = true
      remoteRaceStore.update(remoteRaceTask.id, { note: '预览后本地新备注' })
    }
    return result
  }
  return engine
}
const remoteRaceResult = await remoteRaceSvc.feishuEntrySync({ today: T })
eq('a local edit after remote-import preview marks entry sync stale', remoteRaceResult.stale, true)
eq('the preview race retains the local edit', remoteRaceStore.get(remoteRaceTask.id)?.note, '预览后本地新备注')
eq('the preview race does not apply an older Feishu field snapshot',
  remoteRaceStore.get(remoteRaceTask.id)?.title, '共同标题')
eq('the preview race writes no remote row',
  remoteRaceServer.state.calls.some((call) => /\/batch_(?:create|update|delete)$/.test(call.pathname)), false)
remoteRaceSvc.dispose()

const syncRaceServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const syncRaceSvc = new TodoService(null, () => {}, {
  fetch: syncRaceServer.fetch, settingsFile: path.join(dir, 'sync-race-settings.json'),
})
syncRaceSvc.applySettings({
  dataFile: path.join(dir, 'sync-race.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false },
})
const syncRaceStore = syncRaceSvc.require()
const syncRaceTask = syncRaceStore.create({ id: 't_sync_race', title: '共同标题' })
await syncRaceSvc.syncFeishu({ today: T })
syncRaceStore.update(syncRaceTask.id, { title: '预览中的本地标题' })
const syncRaceRecord = [...syncRaceServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === syncRaceTask.id)
syncRaceServer.state.calls.length = 0
const originalSyncRaceEngine = syncRaceSvc.feishuEngine.bind(syncRaceSvc)
let syncRaceTriggered = false
syncRaceSvc.feishuEngine = (...args) => {
  const engine = originalSyncRaceEngine(...args)
  const run = engine.run.bind(engine)
  engine.run = async (options) => {
    const result = await run(options)
    if (options.dryRun === true && options.conflictPolicy === 'skip' && !syncRaceTriggered) {
      syncRaceTriggered = true
      syncRaceServer.state.records.get(syncRaceRecord[0])['备注'] = '预览后飞书新备注'
    }
    return result
  }
  return engine
}
const syncRaceResult = await syncRaceSvc.feishuEntrySync({ today: T })
eq('a Feishu edit after push preview marks entry sync stale', syncRaceResult.stale, true)
eq('the preview race retains the newer remote field',
  syncRaceServer.state.records.get(syncRaceRecord[0])['备注'], '预览后飞书新备注')
eq('the preview race does not push the stale local row',
  syncRaceServer.state.records.get(syncRaceRecord[0])['标题'], '共同标题')
eq('the stale push preview makes no batch write',
  syncRaceServer.state.calls.some((call) => /\/batch_(?:create|update|delete)$/.test(call.pathname)), false)
syncRaceSvc.dispose()

console.log('--- task deletion conflicts require an explicit direction ---')
const localDeleteServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const localDeleteSvc = new TodoService(null, () => {}, {
  fetch: localDeleteServer.fetch, settingsFile: path.join(dir, 'local-delete-resolve-settings.json'),
})
localDeleteSvc.applySettings({
  dataFile: path.join(dir, 'local-delete-resolve.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', deleteRemoved: true },
})
const localDeleteStore = localDeleteSvc.require()
const localDeletedTask = localDeleteStore.create({ id: 't_delete_restore', title: '删除后待恢复', note: '共同备注' })
await localDeleteSvc.syncFeishu({ today: T })
const localDeletedRecord = [...localDeleteServer.state.records.entries()]
  .find(([, fields]) => fields['任务ID'] === localDeletedTask.id)
localDeleteStore.remove(localDeletedTask.id)
localDeleteServer.state.records.get(localDeletedRecord[0])['备注'] = '飞书新备注'
const localDeleteEntry = await localDeleteSvc.feishuEntrySync({ today: T })
const localDeleteConflict = localDeleteEntry.conflicts.find((conflict) => conflict.key === localDeletedTask.id)
eq('entry sync retains a local tombstone when Feishu changed the deleted row',
  [localDeleteStore.get(localDeletedTask.id), localDeleteStore.tombstones()], [null, [localDeletedTask.id]])
eq('the conflict is marked as a local-delete operation', localDeleteConflict?.operation, 'delete')
const restoredByChoice = await localDeleteSvc.resolveFeishuConflict({
  key: localDeletedTask.id, field: '__delete__', operation: 'delete', direction: 'remote',
  expected: { changes: localDeleteConflict?.changes ?? [] },
})
eq('accepting the Feishu row restores the deleted local task',
  [restoredByChoice.resolved, localDeleteStore.get(localDeletedTask.id)?.note], [true, '飞书新备注'])
eq('restoring a Feishu row clears its local tombstone', localDeleteStore.tombstones(), [])
eq('restoring a Feishu row does not rewrite it remotely',
  localDeleteServer.state.records.get(localDeletedRecord[0])['备注'], '飞书新备注')
gate('Feishu-wins deletion resolution is JSON-safe', restoredByChoice)
localDeleteSvc.dispose()

const remoteDeleteServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const remoteDeleteSvc = new TodoService(null, () => {}, {
  fetch: remoteDeleteServer.fetch, settingsFile: path.join(dir, 'remote-delete-resolve-settings.json'),
})
remoteDeleteSvc.applySettings({
  dataFile: path.join(dir, 'remote-delete-resolve.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', syncSubtasks: true },
})
const remoteDeleteStore = remoteDeleteSvc.require()
const remoteDeleteParent = remoteDeleteStore.create({ id: 't_remote_deleted_parent', title: '飞书已删除的父任务' })
const remoteDeleteChild = remoteDeleteStore.addSubtask(remoteDeleteParent.id, { id: 't_remote_deleted_child', title: '必须保留的子任务' })
await remoteDeleteSvc.syncFeishu({ today: T })
const remoteParentRow = [...remoteDeleteServer.state.records.entries()]
  .find(([, fields]) => fields['任务ID'] === remoteDeleteParent.id)
remoteDeleteServer.state.records.delete(remoteParentRow[0])
const remoteDeleteEntry = await remoteDeleteSvc.feishuEntrySync({ today: T })
const remoteDeleteConflict = remoteDeleteEntry.conflicts.find((conflict) => conflict.key === remoteDeleteParent.id)
eq('entry sync detects a remote deletion without recreating it',
  [remoteDeleteStore.get(remoteDeleteParent.id)?.title, remoteDeleteConflict?.operation],
  [remoteDeleteParent.title, 'remote-delete'])
const acceptedRemoteDelete = await remoteDeleteSvc.resolveFeishuConflict({
  key: remoteDeleteParent.id, field: '__delete__', operation: 'remote-delete', direction: 'remote', today: T,
  expected: { changes: remoteDeleteConflict?.changes ?? [] },
})
eq('accepting the Feishu deletion removes only its target and detaches children',
  [acceptedRemoteDelete.resolved, remoteDeleteStore.get(remoteDeleteParent.id),
    remoteDeleteStore.get(remoteDeleteChild.id)?.parentId],
  [true, null, null])
eq('accepting a Feishu deletion does not create a local deletion tombstone',
  remoteDeleteStore.tombstones().includes(remoteDeleteParent.id), false)
eq('the detached child remains a real local task', remoteDeleteStore.get(remoteDeleteChild.id)?.title, '必须保留的子任务')
gate('Feishu-delete acceptance is JSON-safe', acceptedRemoteDelete)
remoteDeleteSvc.dispose()

const keepLocalDeleteServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const keepLocalDeleteSvc = new TodoService(null, () => {}, {
  fetch: keepLocalDeleteServer.fetch, settingsFile: path.join(dir, 'keep-local-delete-settings.json'),
})
keepLocalDeleteSvc.applySettings({
  dataFile: path.join(dir, 'keep-local-delete.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
})
const keepLocalDeleteStore = keepLocalDeleteSvc.require()
const keepLocalTask = keepLocalDeleteStore.create({ id: 't_remote_delete_keep_local', title: '本地仍要保留' })
await keepLocalDeleteSvc.syncFeishu({ today: T })
const keepLocalRecord = [...keepLocalDeleteServer.state.records.entries()]
  .find(([, fields]) => fields['任务ID'] === keepLocalTask.id)
keepLocalDeleteServer.state.records.delete(keepLocalRecord[0])
const keepLocalEntry = await keepLocalDeleteSvc.feishuEntrySync({ today: T })
const keepLocalConflict = keepLocalEntry.conflicts.find((conflict) => conflict.key === keepLocalTask.id)
const keptLocalDecision = await keepLocalDeleteSvc.resolveFeishuConflict({
  key: keepLocalTask.id, field: '__delete__', operation: 'remote-delete', direction: 'local', today: T,
  expected: { changes: keepLocalConflict?.changes ?? [] },
})
eq('choosing local after a Feishu deletion recreates exactly that row',
  [keptLocalDecision.resolved,
    [...keepLocalDeleteServer.state.records.values()].find((fields) => fields['任务ID'] === keepLocalTask.id)?.['标题']],
  [true, '本地仍要保留'])
eq('choosing local does not remove the task from the workspace',
  keepLocalDeleteStore.get(keepLocalTask.id)?.title, '本地仍要保留')
gate('local-wins remote-delete resolution is JSON-safe', keptLocalDecision)
keepLocalDeleteSvc.dispose()

console.log('--- queued entry checks run after the active Feishu operation ---')
const queueServer = makeFeishuServer({ fields: requiredColumns('任务ID') })
const queueSvc = new TodoService(null, () => {}, {
  fetch: queueServer.fetch, settingsFile: path.join(dir, 'queue-settings.json'),
})
queueSvc.applySettings({
  dataFile: path.join(dir, 'queue.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false },
})
queueSvc.require()
queueSvc.feishuRunning = true
const queuedEntry = await queueSvc.feishuEntrySync({})
eq('an entry check during a running Feishu operation is reported as busy', queuedEntry.busy, true)
eq('the overlapping entry check queues one follow-up reconciliation', queueSvc.feishuQueued, true)
eq('a busy entry check does not start another network request', queueServer.state.calls.length, 0)
queueSvc.feishuRunning = false
queueSvc.drainFeishuQueue()
await new Promise((resolve) => setTimeout(resolve, 30))
eq('the queued entry reconciliation completes after the lock is released',
  queueSvc.feishuStatus().lastSync?.ok, true)
eq('the queued follow-up drains exactly once', queueSvc.feishuQueued, false)
eq('one queued entry follow-up performs one reconciliation pass',
  queueServer.state.calls.filter((call) => call.pathname.includes('/records?')).length, 4)
queueSvc.dispose()

console.log('--- auto-sync is opt-in and debounced ---')
const autoServer = makeFeishuServer()
const auto = new TodoService(null, () => {}, { fetch: autoServer.fetch, settingsFile: path.join(dir, 'auto-settings.json') })
auto.applySettings({
  dataFile: path.join(dir, 'auto.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false },
})
auto.require().create({ title: '不该自动同步' })
eq('a mutation schedules nothing while autoSync is off', auto.feishuStatus().scheduled, false)
auto.applySettings({
  dataFile: path.join(dir, 'auto.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: true },
})
auto.require().create({ title: '应该排进队列' })
eq('a mutation schedules a sync once autoSync is on', auto.feishuStatus().scheduled, true)
auto.dispose()
eq('disposing cancels the queued sync', auto.feishuStatus().scheduled, false)
eq('disposing wrote nothing to the table', autoServer.state.calls.length, 0)

const autoConflictServer = makeFeishuServer()
const autoConflictLogs = []
const autoConflict = new TodoService(null, (message) => autoConflictLogs.push(message), {
  fetch: autoConflictServer.fetch, settingsFile: path.join(dir, 'auto-conflict-settings.json'),
})
autoConflict.applySettings({
  dataFile: path.join(dir, 'auto-conflict.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false },
})
const autoConflictStore = autoConflict.require()
const autoConflictTask = autoConflictStore.create({ id: 't_auto_conflict', title: '自动同步冲突' })
await autoConflict.syncFeishu({})
const autoConflictRecord = [...autoConflictServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === autoConflictTask.id)
autoConflictRecord[1]['标题'] = '飞书端自动冲突值'
autoConflictRecord[1]['备注'] = '飞书端独立手写的备注'
const autoForeignRecordId = 'rec_foreign_auto'
autoConflictServer.state.records.set(autoForeignRecordId, {
  任务ID: 't_foreign_auto', 标题: '飞书独有任务', 备注: '飞书独有内容',
})
autoConflictStore.update(autoConflictTask.id, { title: '本地端自动冲突值' })
const autoAddedTask = autoConflictStore.create({ id: 't_auto_new', title: '本地新增任务' })
// Only inspect the second (automatic) run's writes. This is the reported
// regression shape: a local add must not turn into a replacement of the table.
autoConflictServer.state.calls.length = 0
autoConflict.applySettings({
  dataFile: path.join(dir, 'auto-conflict.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: true },
})
await autoConflict.feishuRunAuto()
eq('automatic sync skips rather than overwriting a conflict', autoConflictRecord[1]['标题'], '飞书端自动冲突值')
eq('automatic sync preserves a remote-only field on the conflicted row',
  autoConflictRecord[1]['备注'], '飞书端独立手写的备注')
eq('automatic sync preserves rows that exist only in Feishu',
  autoConflictServer.state.records.get(autoForeignRecordId), {
    任务ID: 't_foreign_auto', 标题: '飞书独有任务', 备注: '飞书独有内容',
  })
const autoAddedRecord = [...autoConflictServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === autoAddedTask.id)
eq('automatic sync still adds the new local task', autoAddedRecord?.[1]?.['标题'], '本地新增任务')
eq('the local-add regression only issues a create, never a table-wide update or deletion',
  autoConflictServer.state.calls.filter((call) => /\/batch_(?:create|update|delete)$/.test(call.pathname))
    .map((call) => call.pathname.split('/').at(-1)), ['batch_create'])
eq('automatic conflict details remain visible in last-sync status',
  autoConflict.feishuStatus().lastSync.summary.skippedConflicts, 1)
ok('automatic sync reports both values in the host log',
  autoConflictLogs.some((message) => message.includes('本地端自动冲突值') && message.includes('飞书端自动冲突值')),
  autoConflictLogs)
autoConflict.dispose()

// A pre-existing table may have no saved baseline yet (for example, when
// auto-sync is enabled before the first successful sync). In that state an
// unknown difference is still a conflict, never a reason to push the local copy.
const autoUnknownServer = makeFeishuServer()
const autoUnknown = new TodoService(null, () => {}, {
  fetch: autoUnknownServer.fetch, settingsFile: path.join(dir, 'auto-unknown-settings.json'),
})
autoUnknown.applySettings({
  dataFile: path.join(dir, 'auto-unknown.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false, deleteRemoved: true },
})
const autoUnknownStore = autoUnknown.require()
const autoUnknownTask = autoUnknownStore.create({ id: 't_auto_unknown', title: '本地已有任务', note: '本地备注' })
autoUnknownServer.state.records.set('rec_unknown_baseline', {
  ...taskToFields(autoUnknownTask, autoUnknownStore, { today: T }),
  备注: '飞书已有的手写备注',
})
const autoUnknownDeleted = autoUnknownStore.create({
  id: 't_auto_unknown_deleted', title: '无基准的本地删除', note: '本地删除时的备注',
})
autoUnknownServer.state.records.set('rec_unknown_deleted', {
  ...taskToFields(autoUnknownDeleted, autoUnknownStore, { today: T }),
  备注: '飞书删除前手写的备注',
})
autoUnknownStore.remove(autoUnknownDeleted.id)
const autoUnknownAdded = autoUnknownStore.create({ id: 't_auto_unknown_new', title: '本地新增任务' })
autoUnknown.applySettings({
  dataFile: path.join(dir, 'auto-unknown.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: true, deleteRemoved: true },
})
await autoUnknown.feishuRunAuto()
eq('without a baseline, automatic sync does not overwrite an existing Feishu field',
  autoUnknownServer.state.records.get('rec_unknown_baseline')['备注'], '飞书已有的手写备注')
eq('without a baseline, automatic sync still creates a new local task',
  [...autoUnknownServer.state.records.values()].find((fields) => fields['任务ID'] === autoUnknownAdded.id)?.['标题'], '本地新增任务')
eq('without a baseline, automatic sync does not delete a remotely populated tombstone row',
  autoUnknownServer.state.records.get('rec_unknown_deleted')['备注'], '飞书删除前手写的备注')
eq('unknown-baseline update and deletion conflicts are reported instead of guessed',
  autoUnknown.feishuStatus().lastSync.summary.skippedConflicts, 2)
eq('the unknown-baseline deletion tombstone remains available for review',
  autoUnknownStore.tombstones(), [autoUnknownDeleted.id])
autoUnknown.dispose()

// A tombstone is not permission to erase newer Feishu-side work. Even with
// deleteRemoved enabled, a row changed since the last common state needs an
// explicit local-push decision; auto-sync must keep it and retain the tombstone.
const deleteConflictStore = new TodoStore({ dataFile: path.join(dir, 'delete-conflict.json'), saveDelay: 5 }).load()
const deleteConflictTask = deleteConflictStore.create({ id: 't_delete_conflict', title: '删除冲突任务', note: '共同备注' })
const deleteConflictServer = makeFeishuServer()
const deleteConflictSync = new FeishuSync({ ...config, deleteRemoved: true }, deleteConflictStore, {
  fetch: deleteConflictServer.fetch, now: fixedNow,
})
await deleteConflictSync.run({ today: T })
const deleteConflictRecord = [...deleteConflictServer.state.records.entries()]
  .find(([, fields]) => fields['任务ID'] === deleteConflictTask.id)
deleteConflictStore.remove(deleteConflictTask.id)
deleteConflictRecord[1]['备注'] = '飞书新写的备注'
deleteConflictRecord[1]['飞书自定义列'] = '不能随删除丢失的内容'
const deletePreview = await deleteConflictSync.run({ today: T, dryRun: true })
eq('a remote edit after local deletion blocks the default plan', deletePreview.blocked, true)
const deleteConflictChanges = deletePreview.conflicts[0]?.changes ?? []
ok('the deletion conflict identifies a changed baseline field',
  deleteConflictChanges.some((change) => change.field === '备注' && change.reason === 'remote'), deleteConflictChanges)
ok('the deletion conflict also protects an untracked non-empty field',
  deleteConflictChanges.some((change) => change.field === '飞书自定义列' && change.reason === 'unknown'), deleteConflictChanges)
eq('a conflicted deletion is not planned', deletePreview.planned.deleted, 0)
const deleteSkipped = await deleteConflictSync.run({ today: T, conflictPolicy: 'skip' })
eq('skip policy preserves the remotely edited row',
  deleteConflictServer.state.records.get(deleteConflictRecord[0]), deleteConflictRecord[1])
eq('skip policy retains the local tombstone for a later explicit decision',
  deleteConflictStore.tombstones(), [deleteConflictTask.id])
eq('skip policy reports the deletion conflict', deleteSkipped.skippedConflicts, 1)
const deletePushed = await deleteConflictSync.run({ today: T, conflictPolicy: 'push' })
eq('the explicit local-push decision deletes the conflicted row', deletePushed.deleted, 1)
eq('the completed deletion retires its tombstone', deleteConflictStore.tombstones(), [])

const autoDeleteServer = makeFeishuServer()
const autoDeleteLogs = []
const autoDelete = new TodoService(null, (message) => autoDeleteLogs.push(message), {
  fetch: autoDeleteServer.fetch, settingsFile: path.join(dir, 'auto-delete-settings.json'),
})
autoDelete.applySettings({
  dataFile: path.join(dir, 'auto-delete.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: false, deleteRemoved: true },
})
const autoDeleteStore = autoDelete.require()
const autoDeleteTask = autoDeleteStore.create({ id: 't_auto_delete', title: '本地后来删除的任务', note: '共同备注' })
await autoDelete.syncFeishu({})
const autoDeleteRecord = [...autoDeleteServer.state.records.entries()]
  .find(([, fields]) => fields['任务ID'] === autoDeleteTask.id)
autoDeleteRecord[1]['备注'] = '飞书新写的备注'
autoDeleteStore.remove(autoDeleteTask.id)
const autoAfterDeleteAdd = autoDeleteStore.create({ id: 't_auto_after_delete', title: '删除后新增任务' })
autoDelete.applySettings({
  dataFile: path.join(dir, 'auto-delete.json'),
  feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', autoSync: true, deleteRemoved: true },
})
await autoDelete.feishuRunAuto()
eq('adding a task cannot auto-delete a remotely edited tombstone row',
  autoDeleteServer.state.records.get(autoDeleteRecord[0])['备注'], '飞书新写的备注')
eq('adding a task still reaches Feishu while the deletion conflict is skipped',
  [...autoDeleteServer.state.records.values()].find((fields) => fields['任务ID'] === autoAfterDeleteAdd.id)?.['标题'], '删除后新增任务')
eq('automatic sync keeps the unresolved deletion tombstone',
  autoDeleteStore.tombstones(), [autoDeleteTask.id])
eq('automatic deletion conflict is visible in status',
  autoDelete.feishuStatus().lastSync.summary.skippedConflicts, 1)
ok('automatic deletion conflict is explained in the host log',
  autoDeleteLogs.some((message) => message.includes('（本地已删除）') && message.includes('飞书新写的备注')),
  autoDeleteLogs)
autoDelete.dispose()

// ---------------------------------------------------------------------------
// the setup and diagnosis surface: test / fields / reconcile / pull
//
// These four exist because a bare table plus a wrong column name is the normal
// first-run state: the connection has to be provable without writing, a fresh
// table has to be given its columns, both sides have to be auditable, and the
// rows only the table has have to be importable WITHOUT touching local work.
// ---------------------------------------------------------------------------

console.log('--- a sync must never delete rows it does not own (reported bug) ---')
// The reported failure: local A,B; the table has A,B,C,D; clicking 立即同步 left
// the table with only A,B. The old delete rule was "a remote row whose key is not
// a local task" -- which is also the exact definition of somebody else's row.
{
  const store = new TodoStore({ dataFile: path.join(dir, 'own.json'), saveDelay: 5 }).load()
  store.create({ id: 't_A', title: 'A' })
  store.create({ id: 't_B', title: 'B' })
  store.flush()
  const rows = store.all().map((t) => ({ key: t.id, fields: taskToFields(t, store, { today: T }) }))
  const foreign = [
    ...rows.map((r, i) => ({ record_id: `r_${i}`, fields: r.fields })),
    { record_id: 'r_C', fields: { 任务ID: 't_C', 标题: 'C' } },
    { record_id: 'r_D', fields: { 任务ID: 't_D', 标题: 'D' } },
  ]
  const plan = diffSync({ rows, remote: foreign, keyField: '任务ID', prune: true, tombstones: [] })
  eq('no row is planned for deletion', plan.deletes, [])
  eq('both untouched rows are counted as unmanaged', plan.unmanaged, 2)
  eq('and the owned rows still match', plan.unchanged, 2)

  // ...and the end-to-end run, with deletion explicitly switched ON, keeps them.
  const server = makeFeishuServer()
  for (const rec of foreign) server.state.records.set(rec.record_id, rec.fields)
  const sync = new FeishuSync({ ...config, deleteRemoved: true }, store, { fetch: server.fetch, now: fixedNow })
  const summary = await sync.run({ today: T })
  eq('a full sync deletes nothing', summary.deleted, 0)
  eq('and reports the foreign rows as unmanaged', summary.unmanaged, 2)
  ok('C and D are still in the table',
    [...server.state.records.values()].some((f) => f['任务ID'] === 't_C')
    && [...server.state.records.values()].some((f) => f['任务ID'] === 't_D'))

  // A task the workspace really did delete is still removable -- by tombstone.
  store.remove('t_B')
  const half = new FeishuSync({ ...config, deleteRemoved: false }, store, { fetch: server.fetch, now: fixedNow })
  const offSummary = await half.run({ today: T })
  eq('even a tombstoned row survives while the switch is off', offSummary.deleted, 0)
  const onSync = new FeishuSync({ ...config, deleteRemoved: true }, store, { fetch: server.fetch, now: fixedNow })
  const onSummary = await onSync.run({ today: T })
  eq('and is deleted once the switch is on', onSummary.deleted, 1)
  ok('only that row went',
    [...server.state.records.values()].some((f) => f['任务ID'] === 't_A')
    && [...server.state.records.values()].some((f) => f['任务ID'] === 't_C')
    && ![...server.state.records.values()].some((f) => f['任务ID'] === 't_B'))
  eq('the tombstone is cleared once the row is gone', store.tombstones(), [])
  const again = await onSync.run({ today: T })
  eq('and the next sync is a no-op', [again.created, again.updated, again.deleted], [0, 0, 0])
}
// A task restored from the table must not be deleted by the next sync: the pull
// reuses the row's key as the local id, so the tombstone has to be dropped.
{
  const store = new TodoStore({ dataFile: path.join(dir, 'restore.json'), saveDelay: 5 }).load()
  store.create({ id: 't_X', title: 'X' })
  store.remove('t_X')
  eq('the deletion left a tombstone', store.tombstones(), ['t_X'])
  store.create({ id: 't_X', title: 'X（从飞书补回来）' })
  eq('re-creating the id clears it', store.tombstones(), [])
}

console.log('--- required columns ---')
const wanted = requiredColumns('任务ID')
eq('the key column comes first', wanted[0], '任务ID')
ok('every writable column is required', Object.values(FEISHU_FIELDS).every((name) => wanted.includes(name)))
ok('completion history and follow-up columns are part of the required schema',
  [FEISHU_FIELDS.completionRecords, FEISHU_FIELDS.relatedFollowUps].every((name) => wanted.includes(name)))
eq('no column is listed twice', wanted.length, new Set(wanted).size)
eq('a custom key column is not duplicated when it is also a column name',
  requiredColumns(FEISHU_FIELDS.title).filter((name) => name === FEISHU_FIELDS.title).length, 1)
eq('missingColumns reports what a fresh table lacks',
  missingColumns([], '任务ID').length, wanted.length)
eq('missingColumns reports nothing when the table is complete', missingColumns(wanted, '任务ID'), [])

console.log('--- test connection: read-only, and it says where it failed ---')
const probeServer = makeFeishuServer({ fields: ['标题'] })
const probeSync = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
  null, { fetch: probeServer.fetch })
const probe = await probeSync.probe()
eq('a good connection tests ok', probe.ok, true)
eq('the token step is reported', probe.tokenOk, true)
eq('the table step is reported', probe.tableOk, true)
ok('the columns the table does have are listed', probe.fields.includes('标题'))
ok('the columns it lacks are listed', probe.columns.missing.includes('任务ID'))
// A token exchange is a POST, so "read-only" has to be asserted against the
// DATA endpoints -- which is the property that matters: a probe must not touch a
// table that already holds rows.
eq('a probe never writes to the table',
  probeServer.state.calls.filter((call) => !call.pathname.includes('tenant_access_token'))
    .every((call) => call.method === 'GET'),
  true,
  probeServer.state.calls.map((call) => `${call.method} ${call.pathname}`))
eq('a probe never touches a record or field endpoint with a write',
  probeServer.state.calls.filter((call) => /\/(records|fields)/.test(call.pathname) && call.method !== 'GET').length, 0)
gate('the probe payload is lossless JSON', probe)

const badProbe = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
  null, { fetch: makeFeishuServer({ badAuth: true }).fetch })
const bad = await badProbe.probe()
eq('bad credentials fail the probe', bad.ok, false)
eq('and the failing step is named', bad.step, 'token')
eq('and the failing step is known', bad.tokenOk, false)
ok('and Feishu\'s own message is passed through', String(bad.error).includes('app_id'), bad.error)
gate('a failed probe payload is lossless JSON', bad)

const noTable = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
  null, { fetch: makeFeishuServer({ fieldsFailure: 'table not found' }).fetch })
const missingTable = await noTable.probe()
eq('an unreadable table fails at the schema step', missingTable.step, 'fields')
ok('with Feishu\'s message', String(missingTable.error).includes('table not found'), missingTable.error)

console.log('--- complete the columns of a fresh table ---')
const freshServer = makeFeishuServer({ fields: [] })
const freshSync = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
  null, { fetch: freshServer.fetch })
const preview = await freshSync.ensureFields({ dryRun: true })
eq('the preview names every missing column', preview.missing.length, wanted.length)
eq('the preview creates nothing', freshServer.state.fields.length, 0)
eq('and says it was a dry run', preview.dryRun, true)
const filled = await freshSync.ensureFields({})
eq('every missing column was created', filled.created.length, wanted.length)
eq('nothing failed', filled.failed, [])
eq('the key column is among them', freshServer.state.fields.includes('任务ID'), true)
eq('every created column is 文本', freshServer.state.calls
  .filter((call) => call.method === 'POST' && call.pathname.endsWith('/fields'))
  .every((call) => call.body.type === COLUMN_TYPE_TEXT), true)
const again = await freshSync.ensureFields({})
eq('running it twice creates nothing', again.created, [])
eq('and reports the table as complete', again.missing, [])
gate('the completed-columns payload is lossless JSON', filled)

const halfServer = makeFeishuServer({ fields: ['任务ID'] })
const halfSync = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
  null, { fetch: halfServer.fetch })
const half = await halfSync.ensureFields({})
eq('an existing key column is not re-created', halfServer.state.fields.filter((n) => n === '任务ID').length, 1)
eq('only the rest is added', half.created.length, wanted.length - 1)

const completionColumnNames = [FEISHU_FIELDS.completionRecords, FEISHU_FIELDS.relatedFollowUps]
const legacyServer = makeFeishuServer({ fields: wanted.filter((name) => !completionColumnNames.includes(name)) })
const legacySync = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd' },
  null, { fetch: legacyServer.fetch })
const upgraded = await legacySync.ensureFields({})
eq('an existing legacy table is upgraded with exactly the new feature columns',
  upgraded.created.sort(), [...completionColumnNames].sort())
eq('the new columns are included in the final schema probe',
  missingColumns(legacyServer.state.fields, '任务ID'), [])

console.log('--- full reconciliation: both sides, including the rows a sync ignores ---')
const recServer = makeFeishuServer({ fields: wanted })
const recStore = new TodoStore({ dataFile: path.join(dir, 'rec.json') }).load()
recStore.create({ id: 't_a', title: '一致的任务' })
recStore.create({ id: 't_b', title: '本地独有' })
recStore.flush()
// Seeded with the row the plugin itself would write: a reconciliation that
// called a correctly-synced row "different" would be worse than useless.
seed(recServer, [
  taskToFields(recStore.get('t_a'), recStore, { today: T }),
  { 任务ID: 't_missing', 标题: '远端独有' },
  { 标题: '别人手写的行' },
])
const recSync = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', keyField: '任务ID' },
  recStore, { fetch: recServer.fetch })
const recReport = await recSync.reconcile({ today: T })
eq('reconcile counts the local rows it wants', recReport.local, 2)
eq('reconcile counts every remote row', recReport.remote, 3)
eq('a row without the key column is not matched', recReport.unkeyed, 1)
eq('the matched pair is reported as identical', recReport.identical, 1)
eq('the differing set is empty here', recReport.differing, [])
eq('a local-only task is listed', recReport.localOnly.map((r) => r.key), ['t_b'])
eq('a remote-only row is listed', recReport.remoteOnly.map((r) => r.key), ['t_missing'])
eq('the columns are reported as complete', recReport.columns.missing, [])
gate('the reconciliation payload is lossless JSON', recReport)

const driftServer = makeFeishuServer({ fields: wanted })
seed(driftServer, [{ 任务ID: 't_a', 标题: '改过的标题' }])
const driftSync = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', keyField: '任务ID' },
  recStore, { fetch: driftServer.fetch })
const diffReport = await driftSync.reconcile({ today: T })
eq('a changed field shows up as a difference', diffReport.differing.length, 1)
eq('and the field is named', diffReport.differing[0].fields.includes('标题'), true)

console.log('--- pull: import only what is missing locally ---')
let pullNotifications = 0
const pullStore = new TodoStore({ dataFile: path.join(dir, 'pull.json'), onChange: () => { pullNotifications++ } }).load()
pullStore.create({ id: 't_keep', title: '本地已有，标题不能被远端覆盖' })
pullStore.flush()
const pullServer = makeFeishuServer({ fields: wanted })
seed(pullServer, [
  { 任务ID: 't_keep', 标题: '远端的旧标题', 完成: '否' },
  { 任务ID: 't_hole', 标题: '远端多出来的任务', 备注: '来自飞书', 清单: '工作', 优先级: '高',
    标签: 'A, B', 截止时间: '2026-09-30', 完成: '是', 重复: '每周 周五' },
  { 标题: '没有任务ID的行' },
])
const pullConfig = { ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', keyField: '任务ID' }
const pullSync = new FeishuSync(pullConfig, pullStore, { fetch: pullServer.fetch })
const pullPreview = await pullSync.pull({ dryRun: true })
eq('the preview plans exactly the holes', pullPreview.planned, 1)
eq('and names the task', pullPreview.items.map((i) => i.title), ['远端多出来的任务'])
eq('and counts the keyless row as skipped', pullPreview.skipped.length, 1)
eq('a preview writes nothing locally', pullStore.get('t_hole'), null)
ok('and says the 重复 column cannot be restored', pullPreview.notRestored.includes('重复'))
eq('the local task was not touched by the preview', pullStore.get('t_keep').title, '本地已有，标题不能被远端覆盖')
gate('the pull preview payload is lossless JSON', pullPreview)

pullNotifications = 0
const pulled = await pullSync.pull({})
eq('the pull created the hole', pulled.created, 1)
eq('the pull reports the ids it imported for the entry coordinator', pulled.createdKeys, ['t_hole'])
eq('an imported task does not trigger the user-mutation/auto-sync hook', pullNotifications, 0)
const importedBaseline = pullStore.feishuBaseline(feishuSyncScope(pullConfig))['t_hole']
ok('a pulled task gets a non-secret per-field baseline for common and blank cells',
  importedBaseline?.['标题']?.startsWith('sha256:') === true
  && importedBaseline?.['备注']?.startsWith('sha256:') === true
  && importedBaseline?.['状态']?.startsWith('sha256:') === true
  && !Object.values(importedBaseline ?? {}).includes('远端多出来的任务'), importedBaseline)
const restored = pullStore.get('t_hole')
eq('with the remote key as its id', restored.id, 't_hole')
eq('with its title', restored.title, '远端多出来的任务')
eq('with its note', restored.note, '来自飞书')
eq('with its due date', restored.due, '2026-09-30')
eq('with its tags', restored.tags, ['A', 'B'])
eq('with its priority', restored.priority, 3)
eq('with its completed state', restored.done, true)
eq('the named list did not exist, so the pull created it', pulled.createdLists, ['工作'])
eq('and it landed in that list', restored.listId, pullStore.listByname('工作')?.id ?? null)
ok('and not in the inbox', restored.listId !== pullStore.listByname('收集箱')?.id, restored.listId)
eq('the existing local task was NOT overwritten', pullStore.get('t_keep').title, '本地已有，标题不能被远端覆盖')
const pulledAgain = await pullSync.pull({})
eq('a second pull has nothing left to do', pulledAgain.created, 0)
eq('and plans nothing', pulledAgain.holes, 0)

console.log('--- apply remote edits only after a matching preview and confirmation ---')
{
  let notifications = 0
  const applyStore = new TodoStore({
    dataFile: path.join(dir, 'apply-remote.json'),
    onChange: () => { notifications++ },
    saveDelay: 5,
  }).load()
  const remoteList = applyStore.createList({ name: '本地清单' })
  const target = applyStore.create({
    id: 't_apply', title: '本地标题', note: '本地备注', listId: remoteList.id,
    due: '2026-09-20', start: '2026-09-18', priority: 1, tags: ['本地'],
    recurrence: { freq: 'weekly', weekdays: [5] },
  })
  const sparse = applyStore.create({ id: 't_sparse', title: '稀疏本地标题', note: '缺列不应清空' })
  applyStore.flush()
  notifications = 0
  const applyServer = makeFeishuServer({ fields: wanted })
  const remoteTarget = {
    ...taskToFields(target, applyStore, { today: T }),
    标题: '飞书标题', 备注: '飞书备注', 完成: '是', 清单: '飞书清单', 优先级: '高',
    截止时间: '2026-10-30', 开始时间: '2026-10-20', 标签: '远端, alpha',
    重复: '飞书写的重复句子', 状态: '飞书自由文本状态', 逾期: '否', 子任务进度: '9/9',
    完成记录: '2030-01-01｜不能导入的历史', 关联跟进: '跟进任务：别猜',
    创建时间: '2030-01-01T00:00:00.000Z', 更新时间: '2030-01-02T00:00:00.000Z',
  }
  seed(applyServer, [
    remoteTarget,
    { ...taskToFields(sparse, applyStore, { today: T }), 标题: '远端稀疏标题' },
    { 任务ID: 't_remote_only', 标题: '远端独有，不应在更新本地时创建' },
  ])
  const applySync = new FeishuSync({ ...config, syncSubtasks: true }, applyStore, {
    fetch: applyServer.fetch, now: fixedNow,
  })
  const applyPreview = await applySync.applyRemote({ dryRun: true })
  eq('preview plans changes for the existing ID-matched rows', applyPreview.planned, 2)
  ok('preview has an opaque confirmation token', typeof applyPreview.previewToken === 'string' && applyPreview.previewToken.length === 64)
  eq('preview does not mutate the local task', applyStore.get(target.id).title, '本地标题')
  eq('preview does not trigger auto-sync', notifications, 0)
  ok('non-reversible and derived fields are listed rather than guessed',
    ['重复', '状态', '逾期', '子任务进度', '完成记录', '关联跟进', '创建时间', '更新时间'].every((field) => applyPreview.notApplied.includes(field)),
    applyPreview.notApplied)
  ok('the preview explicitly shows unsupported field differences',
    applyPreview.items.find((item) => item.key === target.id).changes.some((change) => change.field === '重复' && change.applied === false))
  gate('the apply-remote preview payload is lossless JSON', applyPreview)
  const applyScope = feishuSyncScope(config)
  const emptyApplyBaseline = applyStore.feishuBaseline(applyScope)
  applyStore.setFeishuBaseline(applyScope, {
    ...emptyApplyBaseline,
    [target.id]: { 标题: 'sha256:changed-after-preview' },
  })
  const staleBaselineApply = await applySync.applyRemote({ expectedToken: applyPreview.previewToken })
  eq('a baseline change after reverse-import preview invalidates confirmation', staleBaselineApply.stale, true)
  eq('a stale reverse-import leaves the local value unchanged', applyStore.get(target.id).title, '本地标题')
  gate('the stale baseline result is lossless JSON', staleBaselineApply)
  applyStore.setFeishuBaseline(applyScope, emptyApplyBaseline)

  const applied = await applySync.applyRemote({ expectedToken: applyPreview.previewToken })
  eq('confirmation applies only the matching remote snapshot', applied.updated, 2)
  eq('remote title is applied', applyStore.get(target.id).title, '飞书标题')
  eq('remote note is applied', applyStore.get(target.id).note, '飞书备注')
  eq('remote completion boolean is imported', applyStore.get(target.id).done, true)
  eq('remote completion import does not invent a completion timestamp', applyStore.get(target.id).completedAt, null)
  eq('remote completion import does not fabricate history', applyStore.get(target.id).completionRecords, [])
  eq('remote completion import does not advance a recurring task',
    [applyStore.get(target.id).due, applyStore.get(target.id).completedCount], ['2026-10-30', 0])
  eq('supported list changes create their list silently', applyStore.listByname('飞书清单') !== null, true)
  eq('remote priority, dates, and tags are imported',
    [applyStore.get(target.id).priority, applyStore.get(target.id).start, applyStore.get(target.id).tags],
    [3, '2026-10-20', ['远端', 'alpha']])
  eq('a blank omitted cell is not mistaken for a deliberate clear', applyStore.get(sparse.id).note, '缺列不应清空')
  eq('the remote-only task remains the separate additive pull operation', applyStore.get('t_remote_only'), null)
  eq('confirmed reverse import never triggers the user mutation hook', notifications, 0)
  gate('the apply-remote result is lossless JSON', applied)

  const targetRecord = [...applyServer.state.records.entries()].find(([, fields]) => fields['任务ID'] === target.id)
  targetRecord[1]['备注'] = '预览时的飞书备注'
  const stalePreview = await applySync.applyRemote({ dryRun: true })
  targetRecord[1]['备注'] = '预览后又改了备注'
  const staleApply = await applySync.applyRemote({ expectedToken: stalePreview.previewToken })
  eq('a remote edit after preview invalidates reverse-import confirmation', staleApply.stale, true)
  eq('a stale reverse import leaves local data unchanged', applyStore.get(target.id).note, '飞书备注')
  eq('stale reverse-import result is JSON-safe', snapshotJsonValue(staleApply) !== null, true)

  const noOpPreview = await applySync.applyRemote({ dryRun: true })
  ok('the no-op stale-token case starts with a real remote-to-local change', noOpPreview.planned > 0)
  applyStore.updateFromFeishu(target.id, { note: '预览后又改了备注' })
  const staleNoOpApply = await applySync.applyRemote({ expectedToken: noOpPreview.previewToken })
  eq('a stale token is rejected even when the changed snapshot now plans no writes', staleNoOpApply.stale, true)
  eq('the no-op stale confirmation leaves the chosen local value intact',
    applyStore.get(target.id).note, '预览后又改了备注')

  targetRecord[1]['标题'] = 'schema 变化预览值'
  const schemaPreview = await applySync.applyRemote({ dryRun: true })
  applyServer.state.fields = applyServer.state.fields.filter((field) => field !== '标题')
  const schemaStale = await applySync.applyRemote({ expectedToken: schemaPreview.previewToken })
  eq('a table schema change also invalidates the reverse-import preview', schemaStale.stale, true)
  eq('a schema-stale preview leaves the local title untouched', applyStore.get(target.id).title, '飞书标题')
}

console.log('--- pull refuses a table with no usable key column ---')
const noKeyServer = makeFeishuServer({ fields: wanted })
seed(noKeyServer, [{ 标题: '没有任务ID' }])
const noKeyStore = new TodoStore({ dataFile: path.join(dir, 'pull2.json') }).load()
noKeyStore.create({ id: 't_x', title: 'x' })
noKeyStore.flush()
const noKeySync = new FeishuSync({ ...FEISHU_DEFAULTS, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', keyField: '任务ID' },
  noKeyStore, { fetch: noKeyServer.fetch })
let pullRefusal = null
try { await noKeySync.pull({}) } catch (e) { pullRefusal = e }
ok('a pull refuses when no row carries the key column', pullRefusal !== null, pullRefusal?.message)
ok('and the refusal explains why', String(pullRefusal?.message).includes('任务ID'), pullRefusal?.message)

console.log('--- the remote-to-local mapping, in isolation ---')
const mapped = remoteRowToTask({
  标题: '映射', 备注: 'n', 完成: '是', 清单: '工作', 优先级: '中', 标签: 'x, y',
  截止时间: '2026-09-30', 开始时间: '2026-09-28', 父任务: '父任务标题', 创建时间: '2026-09-01T00:00:00.000Z',
  重复: '每周 周五', 状态: '已完成', 逾期: '否', 子任务进度: '1/2',
  完成记录: '2026-09-17 08:00｜材料已提交', 关联跟进: '跟进任务：核对审批',
}, '任务ID', (title) => (title === '父任务标题' ? 't_parent' : null))
eq('the mapping reads the title', mapped.input.title, '映射')
eq('the mapping reads the parent link', mapped.input.parentId, 't_parent')
eq('the mapping keeps the creation stamp', mapped.input.createdAt, '2026-09-01T00:00:00.000Z')
eq('the mapping reads 中 as priority 2', mapped.input.priority, 2)
eq('a derived column is not restored', Object.keys(mapped.input).includes('状态'), false)
eq('non-restorable recurrence, completion history, derived status, and follow-up labels are reported',
  mapped.notRestored, ['重复', '完成记录', '关联跟进', '状态', '逾期', '子任务进度'])
const unlinked = remoteRowToTask({ 标题: 'x', 父任务: '找不到的父' }, '任务ID', () => null)
eq('an unresolvable parent is reported', unlinked.unlinkedParent, '找不到的父')
eq('and no parentId is invented', Object.keys(unlinked.input).includes('parentId'), false)

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n' + (fail ? `FAILING: ${fail} of ${pass + fail}` : `FEISHU GATE: ALL PASS (${pass})`))
process.exit(fail ? 1 : 0)
