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
  BATCH_LIMIT, FEISHU_DEFAULTS, FeishuClient, FeishuSync, asText, chunk, diffSync,
  keyedRemoteCount, missingFeishuSettings, normalizeFeishuSettings, statusLabel, taskToFields,
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
  const state = { calls: [], auth: 0, records: new Map(), nextId: 1, failNext: null }
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
eq('a vanished row is deleted', plan.deletes, [])
eq('keyedRemoteCount counts only our rows', keyedRemoteCount(remote, '任务ID'), 2)
const pruned = diffSync({
  rows: [{ key: 't_a', fields: { 任务ID: 't_a' } }],
  remote,
  keyField: '任务ID',
})
eq('a removed task deletes its row', pruned.deletes, ['r2'])
eq('a foreign row is never deleted', pruned.deletes.includes('r3'), false)
eq('prune=false keeps vanished rows', diffSync({
  rows: [{ key: 't_a', fields: { 任务ID: 't_a' } }],
  remote,
  keyField: '任务ID',
  prune: false,
}).deletes, [])
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
ok('the update body carries the changed status columns',
  changedFields.includes('状态') && changedFields.includes('完成'), changedFields)
ok('the update body leaves the unchanged columns alone',
  !changedFields.includes('标题') && !changedFields.includes('截止时间') && !changedFields.includes('任务ID'),
  changedFields)
const remoteA = [...syncServer.state.records.values()].find((f) => f['任务ID'] === a.id)
eq('the remote status now reads 已完成', remoteA['状态'], '已完成')
eq('the remote 完成 column now reads 是', remoteA['完成'], '是')

console.log('--- deletions, dry runs and the key guard ---')
syncStore.remove(b.id)
const fourth = await sync.run({ today: T })
eq('deleting a task deletes its row', [fourth.created, fourth.updated, fourth.deleted], [0, 0, 1])
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
const svc = new TodoService(null, () => {}, { fetch: serviceServer.fetch })
svc.applySettings({
  dataFile: path.join(dir, 'service.json'),
  feishu: { enabled: true, appId: 'cli_x', appSecret: 'top-secret', appToken: 'bascn', tableId: 'tbl' },
})
// The deep merge is load-bearing: a settings.yaml that sets only the four ids
// must keep the documented defaults for everything else.
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
eq('the service syncs through the injected transport', result.summary.created, 1)
const after = svc.feishuStatus()
eq('status remembers the last sync', after.lastSync.ok, true)
eq('status records what the last sync did', after.lastSync.summary.created, 1)
gate('feishuStatus after a sync is lossless JSON', after)

const failing2 = makeFeishuServer({ badAuth: true })
const svc2 = new TodoService(null, () => {}, { fetch: failing2.fetch })
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

console.log('--- auto-sync is opt-in and debounced ---')
const autoServer = makeFeishuServer()
const auto = new TodoService(null, () => {}, { fetch: autoServer.fetch })
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

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n' + (fail ? `FAILING: ${fail} of ${pass + fail}` : `FEISHU GATE: ALL PASS (${pass})`))
process.exit(fail ? 1 : 0)
