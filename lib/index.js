/**
 * dsh-task-todo -- host half.
 *
 * Owns the data: one JSON document of tasks and lists, the recurrence engine,
 * the HTTP API the browser half talks to, the agent-facing tools, and the
 * `/todo` command.
 *
 * Boundary rules that this file must not break:
 *
 *  - A bundle plugin reaches its browser half over `ctx.webServer.register`,
 *    never `ctx.harness` (that symbol only exists in the dynamic Cordis sandbox,
 *    and `ctx.harness?.handle()` fails SILENTLY here).
 *  - Every value crossing out of this module (tool return, HTTP reply) is passed
 *    through `sanitize()`. DSH validates each one against lossless JSON and
 *    discards the WHOLE reply if any node is undefined/NaN/Date, so a single
 *    forgotten optional field turns a working tool into a 100%-failing one.
 */

import path from 'node:path'
import fs from 'node:fs'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  LIST_PALETTE, TodoStore, boardColumns, calendarView, defaultDataFile, filterTasks,
  ganttView, planQuickAdd, priorityName, taskDisplay, taskView, viewGroups,
} from './store.js'
import {
  addDays, compareDates, dateOnly, describeRecurrence, normalizeRecurrence,
  nowStamp, today as todayStr,
} from './recurrence.js'
import {
  FEISHU_DEFAULTS, FeishuSync, missingFeishuSettings, normalizeFeishuSettings,
} from './feishu.js'
import {
  defaultSettingsFile, readSettingsFile, writeSettingsFile,
} from './settings.js'

export const name = 'todo'
// `settings` is deliberately NOT injected. The host settings service on this
// DSH line (`SettingsForms`) has no `register(scope, schema)` -- that call used
// to throw and be swallowed, which left every setting inert. The plugin now
// owns its settings document and its own settings page; see `lib/settings.js`.
export const inject = ['tools', 'webServer', 'commands']

/** How long the store must be quiet before auto-sync fires. */
const FEISHU_DEBOUNCE_MS = 3000

const DEFAULTS = {
  enabled: true,
  dataFile: '',
  weekStart: 1,
  defaultList: '收集箱',
  badgeCount: 'today',
  hotkey: { capture: 'Ctrl+Shift+K', palette: 'Ctrl+K' },
  feishu: normalizeFeishuSettings(FEISHU_DEFAULTS),
}

/**
 * The settings surface, in one place.
 *
 * This is not only a validation schema any more: the plugin renders its own
 * settings page from it (`settingsFormGroups()` below), so `title` is the label
 * the user sees, `description` is the help line under it, and `enum` becomes a
 * select. One declarative source is what stops the page and the stored document
 * from drifting apart.
 */
const SETTINGS_SCHEMA = {
  type: 'object',
  title: '待办任务',
  properties: {
    enabled: { type: 'boolean', default: true, title: '启用插件', description: '关闭后侧栏入口、工具与 /todo 都不再可用' },
    dataFile: { type: 'string', default: '', title: '数据文件', description: '任务数据的位置；留空使用 ~/.dsh/todo/tasks.json' },
    weekStart: { type: 'number', default: 1, title: '每周起始日', enum: [1, 0], description: '1 = 周一，0 = 周日' },
    defaultList: { type: 'string', default: '收集箱', title: '新任务默认清单', description: '快速添加时任务落进的清单名' },
    badgeCount: { type: 'string', default: 'today', title: '侧栏徽标口径', enum: ['today', 'overdue', 'open'], description: '统计今天 / 逾期 / 未完成' },
    hotkey: {
      type: 'object',
      title: '全局快捷键',
      description: '留空表示禁用该快捷键；形如 Ctrl+Shift+K',
      properties: {
        capture: { type: 'string', default: 'Ctrl+Shift+K', title: '唤起捕获', description: '在任意页面弹出快速添加' },
        palette: { type: 'string', default: 'Ctrl+K', title: '命令面板', description: '打开面板内的命令列表' },
      },
    },
    feishu: {
      type: 'object',
      title: '飞书同步',
      description: '飞书多维表格同步：把任务（含完成 / 逾期状态）镜像到一张 Bitable 表',
      properties: {
        enabled: { type: 'boolean', default: false, title: '启用飞书同步', description: '关闭时不会发起任何网络请求' },
        appId: { type: 'string', default: '', title: 'App ID', description: '飞书自建应用的 App ID' },
        appSecret: { type: 'string', default: '', title: 'App Secret', description: '飞书自建应用的 App Secret；只写在本机设置文件，保存后不再回显' },
        appToken: { type: 'string', default: '', title: '多维表格 app_token', description: '表格 URL 里 /base/ 后面那段' },
        tableId: { type: 'string', default: '', title: '数据表 table_id', description: 'URL 里 table= 后面那段' },
        baseUrl: { type: 'string', default: 'https://open.feishu.cn', title: '接口域名', description: 'Lark 国际版用 https://open.larksuite.com' },
        autoSync: { type: 'boolean', default: false, title: '自动同步', description: '任务变动后自动推一次（防抖 3 秒）' },
        syncSubtasks: { type: 'boolean', default: true, title: '同步子任务', description: '关闭则只同步顶层任务' },
        includeDone: { type: 'boolean', default: true, title: '含已完成', description: '关闭则已完成任务不写入远端' },
        deleteRemoved: { type: 'boolean', default: true, title: '删除远端已移除行', description: '本地删掉的任务，同步时删掉远端对应行' },
        keyField: { type: 'string', default: '任务ID', title: '匹配字段名', description: '用于匹配行的文本列名，表里要有这一列' },
      },
    },
  },
}

/**
 * One form field, flattened from the schema.
 *
 * Only own, JSON-safe values are copied: the payload crosses to the browser, so
 * an absent `description` must not become a key holding `undefined` (DSH drops
 * the whole reply for that).
 */
function fieldDescriptor(fieldPath, node) {
  const out = {
    path: fieldPath,
    type: node.type ?? 'string',
    title: node.title ?? fieldPath,
  }
  if (node.description !== undefined) out.description = node.description
  if (Array.isArray(node.enum)) out.options = [...node.enum]
  return out
}

/**
 * The schema as groups the settings page renders: top-level fields first, then
 * one group per nested object (currently just `飞书同步`).
 */
function settingsFormGroups() {
  const top = []
  const nested = []
  for (const [key, node] of Object.entries(SETTINGS_SCHEMA.properties)) {
    if (node.type === 'object') {
      nested.push({
        key,
        title: node.title ?? key,
        description: node.description ?? '',
        fields: Object.entries(node.properties ?? {}).map(([name, child]) => fieldDescriptor(`${key}.${name}`, child)),
      })
      continue
    }
    top.push(fieldDescriptor(key, node))
  }
  return [{
    key: '',
    title: SETTINGS_SCHEMA.title ?? name,
    description: '保存后立即生效，无需重启',
    fields: top,
  }, ...nested]
}

/**
 * Layer settings documents over each other.
 *
 * Shallow for the top level, deep for `feishu`: a deployment that seeds only
 * the credentials must not blank the sync defaults underneath, which is the
 * exact failure a shallow spread produced before.
 *
 * Precedence, weakest first: the schema defaults (inside `applySettings`), the
 * entry's `config` block in the profile's `cordis.patch.yml` (handed to
 * `apply(ctx, config)` -- the only way to configure a headless deployment,
 * where there is no settings page), then this plugin's own settings file.
 */
function mergeSettings(base, over) {
  const out = { ...(base ?? {}), ...(over ?? {}) }
  if (base?.feishu !== undefined || over?.feishu !== undefined) {
    out.feishu = { ...(base?.feishu ?? {}), ...(over?.feishu ?? {}) }
  }
  return out
}

/**
 * A hotkey string, or null when it is not one.
 *
 * The client reads these straight off `data.settings.hotkey`, so a typo in the
 * settings document would otherwise become a shortcut that silently never fires.
 * Normalising here (and echoing the result back through `settingsView`) is what
 * makes the value the client sees always a legal one.
 */
function normalizeHotkey(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const parts = text.split('+').map((p) => p.trim().toLowerCase()).filter((p) => p !== '')
  if (parts.length < 2) return null
  const key = parts[parts.length - 1]
  if (!/^[a-z0-9]$/.test(key)) return null
  const mods = []
  for (const mod of parts.slice(0, -1)) {
    const name = mod === 'cmd' || mod === 'meta' || mod === 'command' ? 'Ctrl'
      : mod === 'ctrl' || mod === 'control' ? 'Ctrl'
        : mod === 'alt' || mod === 'option' ? 'Alt'
          : mod === 'shift' ? 'Shift' : null
    if (name === null || mods.includes(name)) return null
    mods.push(name)
  }
  if (mods.length === 0) return null
  return [...mods, key.toUpperCase()].join('+')
}

// ---------------------------------------------------------------------------
// JSON safety
// ---------------------------------------------------------------------------

/**
 * Deep-copy a value into guaranteed-lossless JSON.
 *
 * `undefined`, non-finite numbers, `-0`, functions, symbols and bigints become
 * `null`; `Date` becomes an ISO string; only own enumerable keys of plain
 * objects survive. Anything that reaches the model or the browser passes here
 * first, so the JSON contract is structural rather than remembered.
 */
export function sanitize(value, depth = 0) {
  if (depth > 32) return null
  if (value === null) return null
  const type = typeof value
  if (type === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (type === 'string' || type === 'boolean') return value
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1))
  if (type === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = sanitize(value[key], depth + 1)
    return out
  }
  return null
}

/**
 * The one planner behind both `previewQuick` and `quickAdd`.
 *
 * `store.planQuickAdd` decides the priority between typed text and the seed;
 * this wrapper adds the one thing the store cannot know -- whether the list the
 * text names already exists, and if not, that pressing Enter would create it.
 * Keeping the two callers on this single function is what makes the preview
 * literally the answer to "what will Enter do".
 */
function quickPlan(store, text, seed = {}) {
  const plan = planQuickAdd(text, { today: seed.today, seed: { due: seed.due, listId: seed.listId } })
  const existing = plan.explicitList ? store.listByname(plan.listName) : null
  return {
    ...plan,
    listId: plan.explicitList ? (existing?.id ?? null) : plan.listId,
    listCreated: plan.explicitList && existing === null,
  }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/** Owns the store and defines the single implementation of every operation. */
export class TodoService {
  constructor(ctx, logger, opts = {}) {
    this.ctx = ctx
    this.log = logger
    this.settings = { ...DEFAULTS, feishu: { ...DEFAULTS.feishu } }
    this.store = null
    this.initError = null
    // Settings are the plugin's own document (see `lib/settings.js`): the host
    // settings service on this DSH line has no scope API, so there is nothing to
    // register with -- and a path in `opts` keeps the gates hermetic.
    this.settingsFile = typeof opts.settingsFile === 'string' && opts.settingsFile !== ''
      ? opts.settingsFile
      : defaultSettingsFile()
    this.settingsError = null
    // The entry's `config` block from the profile's Cordis patch, handed in by
    // `apply(ctx, config)`. It is a seed layer only: this plugin's own settings
    // file wins over it, and a headless deployment (no settings page) is the
    // reason it is read at all.
    this.hostConfig = opts.hostConfig !== null && typeof opts.hostConfig === 'object' && !Array.isArray(opts.hostConfig)
      ? opts.hostConfig
      : null
    // `fetch` is an injection seam: the gates drive the whole sync against a
    // fake transport, so no test ever needs the network or a real workspace.
    this.feishuFetch = typeof opts.fetch === 'function' ? opts.fetch : null
    this.feishuTimer = null
    this.feishuRunning = false
    this.feishuQueued = false
    this.feishuLast = null
    this.loadSettings()
  }

  /**
   * Read the settings document over the defaults.
   *
   * A failure here is reported, not thrown: a corrupt or unreadable settings
   * file must leave the plugin usable with defaults, and the settings page shows
   * the message so the user can fix it.
   */
  loadSettings() {
    const { values, error } = readSettingsFile(this.settingsFile)
    this.settingsError = error
    this.applySettings(mergeSettings(this.hostConfig, values))
    if (error !== null) {
      const report = this.log
      report(`[todo] ${error}`)
    }
    return this.settings
  }

  /** Persist the current settings. Throws (and records) on a write failure. */
  saveSettings() {
    try {
      writeSettingsFile(this.settingsFile, this.settings)
      this.settingsError = null
    } catch (e) {
      this.settingsError = `保存设置失败：${String(e?.message ?? e)}`
      throw new Error(this.settingsError)
    }
    return this.settings
  }

  /**
   * What the settings page renders: the schema groups, the current values, and
   * whether a secret is already stored.
   *
   * `appSecret` is write-only. It is blanked here rather than masked, because a
   * masked string is still a value a careless client could echo back, and the
   * page only needs to know "one is stored" to word its placeholder.
   */
  settingsForForm() {
    const values = sanitize({ ...this.settings, feishu: { ...this.settings.feishu } })
    values.feishu.appSecret = ''
    return {
      file: this.settingsFile,
      error: this.settingsError,
      secretSet: String(this.settings.feishu.appSecret ?? '') !== '',
      values,
      groups: settingsFormGroups(),
    }
  }

  /**
   * Apply a settings patch and persist it.
   *
   * Only keys the schema declares are accepted, and only one level of nesting is
   * walked: a typo in a field name must fail visibly (by not taking effect)
   * instead of being written into the document forever. An empty `appSecret`
   * means "leave it alone", never "clear it" -- the page cannot show the stored
   * value back, so treating blank as a clear would make the field impossible to
   * keep once set.
   */
  updateSettings(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('设置必须是一个对象')
    }
    // Start from the stored values, NOT from the incoming patch: a partial save
    // must not blank every field the page did not send.
    const next = { ...this.settings }
    for (const [key, node] of Object.entries(SETTINGS_SCHEMA.properties)) {
      if (node.type === 'object') {
        const incoming = patch[key]
        if (incoming === null || incoming === undefined || typeof incoming !== 'object' || Array.isArray(incoming)) continue
        const merged = { ...(this.settings[key] ?? {}) }
        for (const name of Object.keys(node.properties ?? {})) {
          if (incoming[name] !== undefined) merged[name] = incoming[name]
        }
        next[key] = merged
        continue
      }
      if (patch[key] !== undefined) next[key] = patch[key]
    }
    if (next.feishu !== undefined && next.feishu.appSecret === '') {
      next.feishu = { ...next.feishu, appSecret: this.settings.feishu.appSecret ?? '' }
    }
    this.applySettings(next)
    this.saveSettings()
    return this.settingsForForm()
  }

  applySettings(values) {
    const next = { ...DEFAULTS, ...(values ?? {}) }
    // Deep-merge the Feishu block: the settings document usually carries a
    // subset, and a shallow spread would replace the defaults with a half-filled
    // object.
    next.feishu = normalizeFeishuSettings({ ...DEFAULTS.feishu, ...(values?.feishu ?? {}) })
    const fileChanged = next.dataFile !== this.settings.dataFile
    const feishuChanged = JSON.stringify(next.feishu) !== JSON.stringify(this.settings.feishu)
    this.settings = next
    // Pointing the plugin at another document must not keep serving the old one.
    if (fileChanged && this.store !== null) this.store = null
    // A remembered "last sync" belongs to the old target; showing it against a
    // new app/table would read as "this table is already in sync".
    if (feishuChanged) this.feishuLast = null
  }

  dataFile() {
    return this.settings.dataFile && String(this.settings.dataFile).trim()
      ? path.resolve(String(this.settings.dataFile).trim())
      : defaultDataFile()
  }

  /** Open (once) the backing document. Never throws for a missing file. */
  open() {
    if (this.store !== null) return this.store
    const file = this.dataFile()
    this.store = new TodoStore({
      dataFile: file,
      logger: this.log,
      onChange: () => this.feishuTouch(),
    }).load()
    this.initError = this.store.loadError
    return this.store
  }

  require() {
    const store = this.open()
    if (this.settings.enabled === false) throw new Error('待办插件已在设置中禁用')
    return store
  }

  settingsView() {
    const hotkey = this.settings.hotkey ?? {}
    return {
      weekStart: Number(this.settings.weekStart) === 0 ? 0 : 1,
      defaultList: String(this.settings.defaultList ?? '收集箱'),
      badgeCount: ['today', 'overdue', 'open'].includes(String(this.settings.badgeCount))
        ? String(this.settings.badgeCount)
        : 'today',
      enabled: this.settings.enabled !== false,
      // Echoed (normalised) rather than omitted: the client renders these as the
      // shortcut hints, and an invalid value must fall back to the default
      // instead of becoming a key that never fires.
      hotkey: {
        capture: normalizeHotkey(hotkey.capture) ?? DEFAULTS.hotkey.capture,
        palette: normalizeHotkey(hotkey.palette) ?? DEFAULTS.hotkey.palette,
      },
    }
  }

  /**
   * The one payload the client renders: lists, tasks, counts, settings, and the
   * data the ACTIVE VIEW needs.
   *
   * View semantics (bucket boundaries, which day a repeating task lands on,
   * whether a bar is overdue) are computed here rather than in the browser, so
   * the calendar can never disagree with what the host stored.
   */
  state(opts = {}) {
    const store = this.require()
    const today = dateOnly(opts.today) ?? todayStr()
    // `view` is the kind; `kind` is tolerated for callers that send a view payload
    // instead of a view context (see viewOf()).
    const requested = typeof opts.view === 'string' ? opts.view : (typeof opts.kind === 'string' ? opts.kind : '')
    const viewKind = ['list', 'board', 'calendar', 'gantt'].includes(requested) ? requested : 'list'
    const base = {
      filter: String(opts.filter ?? 'all'),
      listId: opts.listId === null || opts.listId === undefined || opts.listId === '' ? null : String(opts.listId),
      query: String(opts.query ?? '').slice(0, 200),
      // A tag filter is part of the view context, not a one-shot parameter: a
      // mutation made while the rail is filtered to `#工作` echoes this state
      // back, and dropping it here would clear the user's filter mid-click.
      tag: String(opts.tag ?? '').slice(0, 40),
      includeDone: opts.includeDone === true,
      today,
    }
    const payload = {
      today,
      dataFile: this.dataFile(),
      lists: store.lists.map((l) => ({ ...l })),
      // The editor's swatches and the colour a list created right now would get.
      // Both come from the host so the rail cannot preview a colour the store
      // would not have chosen.
      palette: [...LIST_PALETTE],
      nextListColor: store.nextListColor(),
      // The UI renders this projection: display fields added by the host, raw
      // fields preserved so the editor keeps the recurrence rule object.
      tasks: store.tasks.map((t) => taskDisplay(t, store, { today })),
      counts: store.stats({ today }),
      // Tags are a first-class axis now: the rail lists them with counts, so the
      // payload carries them the same way it carries lists.
      tags: store.tagCounts(),
      settings: this.settingsView(),
      loadError: this.initError,
      view: { kind: viewKind },
    }
    if (viewKind === 'list') {
      payload.view.groups = viewGroups(store, base)
    } else if (viewKind === 'board') {
      payload.view.columns = boardColumns(store, base)
    } else if (viewKind === 'calendar') {
      payload.view = { kind: viewKind, ...calendarView(store, { ...base, from: opts.from, to: opts.to }) }
    } else {
      payload.view = { kind: viewKind, ...ganttView(store, { ...base, from: opts.from, to: opts.to }) }
    }
    return payload
  }

  // -- operations (shared by the HTTP API and the tools) -------------------

  /**
   * Every mutation echoes back the state the CALLER is looking at.
   *
   * A mutation triggered from the calendar must not answer with the list view's
   * payload: the client adopts the echoed state, so a default-view echo would
   * silently swap the calendar for a list mid-interaction. Callers pass their
   * view context in `view`; tools omit it and get the default.
   */
  viewOf(input) {
    if (input === null || typeof input !== 'object') return {}
    const raw = input.view
    if (typeof raw === 'string') return { view: raw }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    // The client sends a flat context whose own `view` field is the kind string.
    // An HTTP caller may just as reasonably send `{ kind: 'calendar' }`, and a
    // shape mismatch used to fall back to the list view silently -- which is how
    // a toggle made on the calendar swapped the calendar for a list. Accept both.
    if (typeof raw.view !== 'string' && typeof raw.kind === 'string') {
      return { ...raw, view: raw.kind }
    }
    return raw
  }

  create(input) {
    const store = this.require()
    const spec = { ...input }
    // `list` is the convenience `update` already accepts -- a list NAME, created
    // on demand. Without this the documented parameter was silently dropped and
    // every task created through the HTTP API landed in the inbox.
    if (spec.list !== undefined && spec.list !== null && spec.list !== '') {
      spec.listId = this.ensureList(spec.list).id
    }
    // "默认清单" was a setting nothing read; a task created without a list now
    // actually lands in it, and falls back to the inbox when the name is stale.
    if (spec.listId === undefined && spec.listName === undefined) {
      const preferred = store.listByname(String(this.settings.defaultList ?? '').trim())
      if (preferred !== null) spec.listId = preferred.id
    }
    // `repeat: 'weekly'` is the same convenience `task_add` offers; without this
    // the shorthand was silently ignored on the HTTP path and the task came back
    // with no rule at all.
    if (spec.recurrence === undefined && spec.repeat !== undefined) {
      spec.recurrence = this.buildRecurrence(spec)
    }
    const created = store.create(spec)
    return { created: { ...created }, state: this.state(this.viewOf(input)) }
  }

  update(input) {
    const store = this.require()
    const id = this.resolveId(input.id ?? input.task ?? '')
    const patch = {}
    for (const key of ['title', 'note', 'due', 'start', 'listId', 'tags', 'parentId']) {
      if (key in input && input[key] !== undefined) patch[key] = input[key]
    }
    if (input.priority !== undefined) patch.priority = input.priority
    if (input.order !== undefined) patch.order = input.order
    if (input.done !== undefined) patch.done = input.done
    if (input.repeat !== undefined || input.recurrence !== undefined) {
      patch.recurrence = input.recurrence !== undefined
        ? input.recurrence
        : this.buildRecurrence(input)
    }
    // `list` is a convenience: accept a list NAME and resolve it to an id.
    if (input.list !== undefined && input.list !== null && input.list !== '') {
      patch.listId = this.ensureList(input.list).id
    }
    const updated = store.update(id, patch)
    return { updated: { ...updated }, state: this.state(this.viewOf(input)) }
  }

  remove(input) {
    const store = this.require()
    const id = this.resolveId(input.id ?? input.task ?? '')
    const result = store.remove(id)
    return { deleted: result.deleted, state: this.state(this.viewOf(input)) }
  }

  toggle(input) {
    const store = this.require()
    const id = this.resolveId(input.id ?? input.task ?? '')
    const want = input.done === undefined ? !store.get(id).done : input.done === true
    const current = store.get(id)
    const task = current.done === want ? current : store.toggle(id, { today: input.today })
    return { task: { ...task }, state: this.state(this.viewOf(input)) }
  }

  skip(input) {
    const store = this.require()
    const id = this.resolveId(input.id ?? input.task ?? '')
    const task = store.skipOccurrence(id, { today: input.today })
    return { task: { ...task }, state: this.state(this.viewOf(input)) }
  }

  move(input) {
    const store = this.require()
    const id = this.resolveId(input.id ?? input.task ?? '')
    const opts = {}
    if (input.listId !== undefined) opts.listId = input.listId
    if (input.parentId !== undefined) opts.parentId = input.parentId
    if (input.index !== undefined) opts.index = input.index
    const moved = store.move(id, opts)
    return { moved: { ...moved }, state: this.state(this.viewOf(input)) }
  }

  addSubtask(input) {
    const store = this.require()
    const parentId = this.resolveId(input.parentId ?? input.parent ?? '')
    const created = store.addSubtask(parentId, {
      title: input.title,
      due: input.due,
      note: input.note,
      priority: input.priority,
      recurrence: input.repeat !== undefined ? this.buildRecurrence(input) : null,
    })
    return { created: { ...created }, state: this.state(this.viewOf(input)) }
  }

  quickAdd(input) {
    const store = this.require()
    const opts = { today: input.today }
    // `undefined` means "no opinion" and has to stay distinguishable from an
    // explicit null (the 未安排 group), so the seeds are copied only when sent.
    if (input.listId !== undefined) opts.listId = input.listId
    if (input.due !== undefined) opts.due = input.due
    const result = store.quickAdd(String(input.text ?? ''), opts)
    return {
      task: { ...result.task },
      parsed: sanitize(result.parsed),
      listCreated: result.listCreated,
      state: this.state(this.viewOf(input)),
    }
  }

  /**
   * What `quickAdd` WOULD do with this text, without doing it.
   *
   * The browser half renders the answer under the add box. It exists so the
   * syntax can be checked before pressing Enter -- and it is the host's own
   * parser, so the preview can never disagree with what pressing Enter does.
   *
   * Since v2 the answer is the whole `plan` (date, list, and where the list came
   * from), not a bag of fields the browser reassembles: a second assembly in the
   * browser is exactly the drift this method exists to prevent.
   */
  previewQuick(input = {}) {
    const store = this.require()
    const text = String(input.text ?? '')
    if (text.trim() === '') return { empty: true }
    const plan = quickPlan(store, text, {
      today: input.today ?? todayStr(),
      listId: input.listId,
      due: input.due,
    })
    const defaultName = String(this.settings.defaultList ?? '').trim()
    const preferred = store.listByname(defaultName)
    // Which list the task really lands in, when the text names none: the seed
    // first (an inline `+` in a column), then the configured default, then 收集箱.
    const seeded = plan.listId === null ? null : store.listById(plan.listId)
    const landing = plan.explicitList
      ? plan.listName
      : (seeded?.name ?? preferred?.name ?? '收集箱')
    return {
      empty: false,
      parsed: sanitize(plan.parsed),
      plan: {
        due: plan.due === undefined ? null : plan.due,
        priority: plan.priority,
        listName: landing,
        listId: plan.listId ?? (preferred?.id ?? null),
        listExists: plan.explicitList ? store.listByname(plan.listName) !== null : true,
        listFromSeed: plan.listFromSeed,
        listFromDefault: !plan.explicitList && plan.listId === null,
      },
      // Kept for the callers that only ever read these two.
      listName: landing,
      listExists: plan.explicitList ? store.listByname(plan.listName) !== null : preferred !== null,
      listFromDefault: !plan.explicitList,
    }
  }

  createList(input) {
    const store = this.require()
    const list = store.createList({ name: input.name, color: input.color })
    return { list: { ...list }, state: this.state(this.viewOf(input)) }
  }

  updateList(input) {
    const store = this.require()
    const id = input.id ?? input.list
    const list = store.updateList(this.resolveList(id).id, {
      name: input.name,
      color: input.color,
      order: input.order,
    })
    return { list: { ...list }, state: this.state(this.viewOf(input)) }
  }

  /** Reorder: `index` is the target position (0 = first), `delta` a relative nudge. */
  moveList(input) {
    const store = this.require()
    const list = this.resolveList(input.id ?? input.list)
    let index = input.index
    if (index === undefined && input.delta !== undefined) {
      const ordered = store.lists.map((l) => l.id)
      index = Math.max(0, Math.min(ordered.length - 1, ordered.indexOf(list.id) + Math.trunc(Number(input.delta) || 0)))
    }
    const result = store.moveList(list.id, { index })
    return { list: result.list, from: result.from, to: result.to, state: this.state(this.viewOf(input)) }
  }

  removeList(input) {
    const store = this.require()
    const list = this.resolveList(input.id ?? input.list)
    const result = store.removeList(list.id)
    return { ...result, state: this.state(this.viewOf(input)) }
  }

  clearCompleted(input = {}) {
    const store = this.require()
    const result = store.clearCompleted()
    return { ...result, state: this.state(this.viewOf(input)) }
  }

  occurrences(input) {
    const store = this.require()
    const today = dateOnly(input.today) ?? todayStr()
    return store.occurrences({
      from: input.from ?? today,
      to: input.to ?? addDays(today, 30) ?? today,
    })
  }

  exportDocument(input = {}) {
    const store = this.require()
    return {
      dataFile: this.dataFile(),
      document: store.document(),
      settings: this.settingsView(),
    }
  }

  /**
   * Replace the whole document from a backup.
   *
   * This is the one operation that can lose everything at once, so the current
   * file is copied aside first: `applyDocument` normalises what it is given and
   * silently drops anything it cannot use, and the user has to be able to get
   * back to what they had before.
   */
  importDocument(input = {}) {
    const store = this.require()
    const doc = input.document
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('备份内容不是一个 JSON 对象')
    }
    if (!Array.isArray(doc.tasks) || !Array.isArray(doc.lists)) {
      throw new Error('备份内容缺少 tasks / lists 数组，可能不是本插件导出的文件')
    }
    const file = this.dataFile()
    let backup = null
    if (fs.existsSync(file)) {
      backup = `${file}.before-import-${Date.now()}`
      try { fs.copyFileSync(file, backup) } catch { backup = null }
    }
    store.applyDocument(doc)
    store.save({ immediate: true })
    return { tasks: store.tasks.length, lists: store.lists.length, backup }
  }

  status(input = {}) {
    const store = this.open()
    const today = todayStr()
    return {
      enabled: this.settings.enabled !== false,
      dataFile: this.dataFile(),
      exists: fs.existsSync(this.dataFile()),
      loadError: this.initError,
      counts: store.stats({ today }),
      settings: this.settingsView(),
      feishu: this.feishuStatus(),
    }
  }

  // -- Feishu Bitable sync -------------------------------------------------

  /**
   * The sync surface a user or agent may see.
   *
   * Explicitly redacted: `appSecret` is the one credential that must never
   * reach a browser payload or a model transcript, and this object is returned
   * by both.
   */
  feishuStatus() {
    const config = this.settings.feishu
    const missing = missingFeishuSettings(config)
    const last = this.feishuLast
    return {
      enabled: config.enabled === true,
      configured: missing.length === 0,
      missing,
      autoSync: config.autoSync === true,
      baseUrl: config.baseUrl,
      appToken: config.appToken,
      tableId: config.tableId,
      keyField: config.keyField,
      syncSubtasks: config.syncSubtasks,
      includeDone: config.includeDone,
      deleteRemoved: config.deleteRemoved,
      running: this.feishuRunning,
      scheduled: this.feishuTimer !== null,
      lastSync: last === null
        ? null
        : { at: last.at, ok: last.ok, error: last.error, summary: last.summary },
    }
  }

  /**
   * The Feishu configuration, refusing early and identically everywhere.
   *
   * `requireEnabled` separates the two kinds of action: mirroring (sync, pull)
   * is the feature and needs the switch on, while setup and diagnosis (test,
   * complete the columns, reconcile) are what a user does BEFORE flipping the
   * switch -- requiring it there would invert the order they work in.
   */
  feishuConfig(requireEnabled = true) {
    const config = this.settings.feishu
    if (requireEnabled && config.enabled !== true) {
      throw new Error('飞书同步未启用：设置 → 待办任务 → 飞书同步 → 启用')
    }
    const missing = missingFeishuSettings(config)
    if (missing.length > 0) throw new Error(`飞书同步缺少配置：${missing.join('、')}`)
    return config
  }

  /** A sync engine on this workspace, with the injectable transport wired in. */
  feishuEngine(config, store) {
    const clientOpts = {}
    if (this.feishuFetch !== null) clientOpts.fetch = this.feishuFetch
    return new FeishuSync(config, store, clientOpts)
  }

  /**
   * Test the connection. Read-only: a fresh token, the table's schema, one page
   * of rows. Safe to run on a table that already holds data.
   */
  async testFeishu() {
    const config = this.feishuConfig(false)
    return this.feishuEngine(config, null).probe()
  }

  /**
   * Create the columns this plugin needs and the table lacks — what makes a
   * freshly created 多维表格 usable without hand-typing every column name.
   */
  async ensureFeishuFields(input = {}) {
    const config = this.feishuConfig(false)
    return this.feishuEngine(config, null).ensureFields({ dryRun: input.dryRun === true })
  }

  /** A full accounting of both sides (`完整对账`). Reads only. */
  async reconcileFeishu(input = {}) {
    const config = this.feishuConfig(false)
    return this.feishuEngine(config, this.require()).reconcile({ today: input.today })
  }

  /**
   * Import the table's rows that this workspace does not have (`从飞书补洞`).
   *
   * Additive by construction: nothing local is overwritten or deleted.
   */
  async pullFeishu(input = {}) {
    const config = this.feishuConfig(true)
    const store = this.require()
    const result = await this.feishuEngine(config, store).pull({
      dryRun: input.dryRun === true,
      limit: input.limit,
    })
    if (result.dryRun !== true && result.created > 0) this.feishuLast = null
    return result
  }

  /**
   * Mirror the tasks into the Feishu Bitable.
   *
   * Idempotent by construction: the plan is a diff against the table's own rows
   * (matched on `keyField`), so an unchanged workspace writes nothing. Failures
   * are recorded in `feishuStatus().lastSync` before being re-thrown, so a
   * failed auto-sync is still visible to the user.
   */
  async syncFeishu(input = {}) {
    const store = this.require()
    const config = this.feishuConfig(true)
    if (this.feishuRunning) throw new Error('飞书同步正在进行中，请稍后再试')
    this.feishuRunning = true
    try {
      const runOpts = { dryRun: input.dryRun === true }
      if (input.prune !== undefined) runOpts.prune = input.prune === true
      if (input.today !== undefined) runOpts.today = input.today
      const summary = await this.feishuEngine(config, store).run(runOpts)
      this.feishuLast = {
        at: summary.finishedAt ?? summary.startedAt,
        ok: true,
        error: null,
        summary,
      }
      return { ok: true, summary }
    } catch (e) {
      this.feishuLast = { at: nowStamp(), ok: false, error: String(e?.message ?? e), summary: null }
      throw e
    } finally {
      this.feishuRunning = false
    }
  }

  /** Debounced auto-sync, driven by the store's change hook. */
  feishuTouch() {
    const config = this.settings.feishu
    if (config.enabled !== true || config.autoSync !== true) return
    if (this.feishuTimer !== null) clearTimeout(this.feishuTimer)
    this.feishuTimer = setTimeout(() => {
      this.feishuTimer = null
      this.feishuRunAuto()
    }, FEISHU_DEBOUNCE_MS)
    // `unref` so a queued sync never keeps a quitting host alive.
    if (typeof this.feishuTimer?.unref === 'function') this.feishuTimer.unref()
  }

  /**
   * One auto-sync. Never throws: it runs off a write, and a network error must
   * not surface as a failed checkbox click.
   */
  async feishuRunAuto() {
    if (this.feishuRunning) { this.feishuQueued = true; return }
    if (missingFeishuSettings(this.settings.feishu).length > 0) return
    const report = this.log
    try {
      await this.syncFeishu({})
    } catch (e) {
      report(`[todo] 飞书自动同步失败：${String(e?.message ?? e)}`)
    }
    if (this.feishuQueued) { this.feishuQueued = false; this.feishuTouch() }
  }

  /** Stop timers and flush the coalesced write before the host goes away. */
  dispose() {
    if (this.feishuTimer !== null) {
      clearTimeout(this.feishuTimer)
      this.feishuTimer = null
    }
    try { this.store?.dispose?.() } catch { /* the host is going down; nothing left to report */ }
  }

  // -- helpers -------------------------------------------------------------

  /**
   * Resolve a task by id, or by an unambiguous title.
   *
   * Agents routinely know a task's name but not its generated id, so accepting a
   * unique title is the difference between a usable tool and one that demands a
   * lookup round trip. An ambiguous title is refused with the candidates rather
   * than silently picking the first one.
   */
  resolveId(query) {
    const store = this.require()
    const key = String(query ?? '').trim()
    if (!key) throw new Error('需要提供任务 id 或标题')
    const direct = store.get(key)
    if (direct !== null) return direct.id
    const low = key.toLowerCase()
    const matches = store.tasks.filter((t) => t.title.toLowerCase() === low)
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new Error(`标题「${key}」对应 ${matches.length} 个任务，请改用 id：`
        + matches.map((t) => `${t.id}（${t.title}）`).join('、'))
    }
    const fuzzy = store.tasks.filter((t) => t.title.toLowerCase().includes(low))
    if (fuzzy.length === 1) return fuzzy[0].id
    if (fuzzy.length > 1) {
      throw new Error(`没有完全匹配「${key}」，相近的有：`
        + fuzzy.slice(0, 8).map((t) => `${t.id}（${t.title}）`).join('、'))
    }
    throw new Error(`找不到任务：${key}`)
  }

  /** Find a list by name, creating it when it does not exist yet. */
  ensureList(name) {
    const store = this.require()
    const existing = store.listByname(String(name ?? '').trim())
    if (existing !== null) return existing
    return store.createList({ name: String(name ?? '').trim() })
  }

  /**
   * Resolve a list by id or by name, for the operations that MUTATE one.
   *
   * Deliberately not `ensureList`: creating a list as a side effect of trying to
   * delete one would be the worst possible failure mode.
   */
  resolveList(query) {
    const store = this.require()
    const key = String(query ?? '').trim()
    if (!key) throw new Error('需要提供清单 id 或名称')
    const direct = store.listById(key)
    if (direct !== null) return direct
    const low = key.toLowerCase()
    const exact = store.lists.filter((l) => l.name.toLowerCase() === low)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) {
      throw new Error(`清单名「${key}」对应 ${exact.length} 个清单，请改用 id：`
        + exact.map((l) => `${l.id}（${l.name}）`).join('、'))
    }
    const fuzzy = store.lists.filter((l) => l.name.toLowerCase().includes(low))
    if (fuzzy.length === 1) return fuzzy[0]
    if (fuzzy.length > 1) {
      throw new Error(`没有完全匹配「${key}」的清单，相近的有：`
        + fuzzy.slice(0, 8).map((l) => `${l.id}（${l.name}）`).join('、'))
    }
    throw new Error(`找不到清单：${key}。现有清单：${store.lists.map((l) => l.name).join('、')}`)
  }

  /** Build a recurrence rule from the flat tool/API parameter triple. */
  buildRecurrence(input) {
    // An absent `repeat` means "not repeating", not "invalid frequency": the
    // add path always calls this, so undefined must be a legitimate no-op.
    const repeat = input.repeat
    if (repeat === undefined || repeat === null || repeat === ''
      || repeat === 'none' || repeat === 'no' || repeat === false) {
      return null
    }
    const rec = normalizeRecurrence({
      freq: repeat,
      interval: input.repeatInterval ?? input.interval ?? 1,
      weekdays: input.repeatWeekdays ?? input.weekdays ?? null,
      until: input.repeatUntil ?? null,
      count: input.repeatCount ?? null,
    })
    if (!rec.ok) throw new Error(rec.error)
    return rec.value
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const logger = (msg) => {
    try { ctx.logger?.info?.(msg) } catch { /* no logger available */ }
  }

  // `new TodoService` already loaded the settings document; the plugin registers
  // no settings with the host, because this DSH line's `settings` service has no
  // scope API to register with. See `lib/settings.js` for the incident. A
  // `config` block on this entry in the profile's Cordis patch is honoured as a
  // seed layer, which is how a headless deployment configures Feishu.
  const svc = new TodoService(ctx, logger, { hostConfig: config })
  logger(`[todo] settings: ${svc.settingsFile}${svc.settingsError === null ? '' : ` (${svc.settingsError})`}`)

  // Publish the service so other plugins (and a future agent surface) can use
  // the same operations instead of reaching into the data file.
  try {
    ctx.provide('todo', svc)
  } catch (e) {
    logger(`[todo] service not published: ${String(e?.message ?? e)}`)
  }

  try {
    svc.open()
  } catch (e) {
    svc.initError = String(e?.message ?? e)
    logger(`[todo] data file unavailable: ${svc.initError}`)
  }

  // Writes are coalesced, so unloading the plugin must not drop the last one:
  // the effect's disposer is the only hook that runs while the store is still
  // alive. A hard process exit is covered by `unref` on the timer, which keeps
  // the queued write from holding the event loop open past its due time. The
  // same disposer stops a queued Feishu auto-sync.
  ctx.effect(() => () => { svc.dispose() })

  registerTools(ctx, svc, logger)
  registerApi(ctx, svc, logger)
  registerCommand(ctx, svc, logger)
}

// ---------------------------------------------------------------------------
// agent tools
// ---------------------------------------------------------------------------

const FILTERS = ['today', 'week', 'overdue', 'inbox', 'all', 'done']

/** One line per task, indented for subtasks. Shared by every tool renderer. */
function renderTaskLines(tasks, store, opts = {}) {
  const today = opts.today ?? todayStr()
  if (!tasks.length) return opts.emptyText ?? '没有匹配的任务。'
  const lines = []
  for (const t of tasks) {
    const bits = []
    if (t.due) bits.push(dateOnly(t.due) === today ? '今天' : t.due.replace('T', ' '))
    if (t.recurrence) bits.push(describeRecurrence(t.recurrence))
    if (t.priority > 0) bits.push(`优先级${priorityName(t.priority)}`)
    const kids = store.childrenOf(t.id)
    if (kids.length) bits.push(`子任务 ${kids.filter((k) => k.done).length}/${kids.length}`)
    if (t.tags.length) bits.push(t.tags.map((x) => `#${x}`).join(' '))
    if (t.done) bits.push('已完成')
    if (t.note) bits.push('有备注')
    lines.push(`- ${t.done ? '[x]' : '[ ]'} ${t.title}  (id=${t.id})${bits.length ? '  · ' + bits.join(' · ') : ''}`)
    for (const k of kids) {
      lines.push(`    - ${k.done ? '[x]' : '[ ]'} ${k.title}  (id=${k.id})${k.note ? '  · 有备注' : ''}`)
    }
  }
  return lines.join('\n')
}

/** The Feishu status as a few readable lines (tool and `/todo sync 状态`). */
function renderFeishuStatus(status) {
  const lines = [status.enabled
    ? '飞书同步：已启用'
    : '飞书同步：未启用（设置 → 待办任务 → 飞书同步 → 启用）']
  lines.push(status.configured
    ? `目标：${status.baseUrl} · app_token=${status.appToken} · table=${status.tableId}`
    : `缺少配置：${status.missing.join('、')}`)
  lines.push(`匹配字段：${status.keyField} · 自动同步：${status.autoSync ? '开' : '关'}`
    + ` · 同步子任务：${status.syncSubtasks ? '是' : '否'} · 含已完成：${status.includeDone ? '是' : '否'}`)
  if (status.running) lines.push('当前：同步进行中')
  else if (status.scheduled) lines.push('当前：已排入自动同步队列')
  if (status.lastSync === null) {
    lines.push('上次同步：还没有执行过')
  } else if (status.lastSync.ok) {
    lines.push(`上次同步：${status.lastSync.at} 成功`
      + `（新增 ${status.lastSync.summary.created} / 更新 ${status.lastSync.summary.updated}`
      + ` / 删除 ${status.lastSync.summary.deleted} / 未变 ${status.lastSync.summary.unchanged}）`)
  } else {
    lines.push(`上次同步：${status.lastSync.at} 失败 —— ${status.lastSync.error}`)
  }
  return lines.join('\n')
}

/** The sync result as a few readable lines. */
function renderFeishuSummary(summary) {
  // A dry run has no applied counts; showing zeros would read as "nothing to do".
  const counts = summary.dryRun
    ? summary.planned
    : { created: summary.created, updated: summary.updated, deleted: summary.deleted }
  const head = summary.dryRun ? '飞书同步预览（未写远端）' : '飞书同步完成'
  return [
    `${head}：本地 ${summary.local} 行 / 远端 ${summary.remote} 行，匹配字段「${summary.keyField}」`,
    `新增 ${counts.created} · 更新 ${counts.updated} · 删除 ${counts.deleted} · 未变 ${summary.unchanged}`,
  ].join('\n')
}

/** A connection test as a few readable lines. */
function renderFeishuProbe(probe) {
  const lines = []
  lines.push(probe.ok
    ? '飞书连接：正常'
    : `飞书连接：失败（${probe.step === 'token' ? '凭证' : probe.step === 'fields' ? '读取表格字段' : probe.step === 'records' ? '读取行' : '未知环节'}）`)
  lines.push(`域名 ${probe.baseUrl} · app_token ${probe.appToken} · table ${probe.tableId}`)
  lines.push(`凭证：${probe.tokenOk ? '通过' : '未通过'} · 表格：${probe.tableOk ? '可读' : '未读到'}`
    + ` · 远端 ${probe.remote} 行（带「${probe.keyField}」的 ${probe.keyed} 行）`)
  if (probe.columns.missing.length > 0) {
    lines.push(`缺列（${probe.columns.missing.length}）：${probe.columns.missing.join('、')}`)
    lines.push('→ 可以点「补全字段」，或让 agent 用 task_sync_feishu action=fields')
  } else {
    lines.push(`列齐全（${probe.columns.present.length} 列）`)
  }
  if (probe.error !== undefined) lines.push(`飞书返回：${probe.error}`)
  return lines.join('\n')
}

/** A column-completion result as a few readable lines. */
function renderFeishuFields(result) {
  const lines = []
  if (result.missing.length === 0) {
    lines.push(`表格字段已齐全（${result.existing.length} 列），没有要补的`)
    return lines.join('\n')
  }
  lines.push(result.dryRun
    ? `将补 ${result.missing.length} 列：${result.missing.join('、')}`
    : `已补 ${result.created.length} 列${result.failed.length === 0 ? '' : `，失败 ${result.failed.length} 列`}`)
  if (result.dryRun !== true) {
    if (result.created.length > 0) lines.push(`新建：${result.created.join('、')}`)
    for (const item of result.failed) lines.push(`失败：${item.name} —— ${item.error}`)
  }
  return lines.join('\n')
}

/** A reconciliation as a few readable lines. */
function renderFeishuReconcile(report) {
  const lines = [
    `飞书对账：本地 ${report.local} 行 / 远端 ${report.remote} 行（带「${report.keyField}」的 ${report.keyed} 行）`,
    `一致 ${report.identical} · 有差异 ${report.differing.length}`,
    `本地有远端没有 ${report.localOnly.length} · 远端有本地没有 ${report.remoteOnly.length}`
    + `${report.unkeyed > 0 ? ` · 远端无「${report.keyField}」的行 ${report.unkeyed}（不参与）` : ''}`,
  ]
  if (report.columns.missing !== undefined && report.columns.missing.length > 0) {
    lines.push(`缺列：${report.columns.missing.join('、')}（缺列会让对账显示成"处处有差异"）`)
  }
  const sample = report.differing.slice(0, 5)
  for (const row of sample) lines.push(`差异：${row.title} —— ${row.fields.join('、')}`)
  if (report.differing.length > sample.length) lines.push(`（还有 ${report.differing.length - sample.length} 条差异未列出）`)
  return lines.join('\n')
}

/** A pull result as a few readable lines. */
function renderFeishuPull(result) {
  const lines = []
  lines.push(result.dryRun
    ? `从飞书补洞（预览）：将补 ${result.planned} 个本地没有的任务（远端 ${result.remote} 行，其中 ${result.holes} 个是"洞"）`
    : `从飞书补洞：已补 ${result.created} 个任务（远端 ${result.remote} 行，其中 ${result.holes} 个是"洞"）`)
  const sample = result.items.slice(0, 5)
  for (const item of sample) lines.push(`· ${item.title}`)
  if (result.items.length > sample.length) lines.push(`（还有 ${result.items.length - sample.length} 条未列出）`)
  if (result.skipped.length > 0) lines.push(`跳过 ${result.skipped.length} 行：${result.skipped[0].reason}`)
  if (result.createdLists.length > 0) lines.push(`顺带创建的清单：${result.createdLists.join('、')}`)
  if (result.unlinkedParents.length > 0) {
    lines.push(`父任务没接上：${result.unlinkedParents.join('、')}（远端存的是父任务标题，本地找不到同名任务）`)
  }
  if (result.notRestored.length > 0) {
    lines.push(`未还原的列：${result.notRestored.join('、')}（远端存的是自然语言描述，无法反推成规则）`)
  }
  lines.push('补洞只新增本地缺的，不改也不删任何已有任务。')
  return lines.join('\n')
}

/**
 * One list as an agent sees it.
 *
 * Every field is explicit: a spread of the stored record would eventually carry
 * an `undefined` and take the whole reply down with it, and `open`/`total` are
 * what make "which list should I delete" answerable without a second call.
 */
function listView(list, store) {
  const tasks = store.tasks.filter((t) => t.listId === list.id)
  return {
    id: list.id,
    name: list.name,
    color: list.color,
    order: list.order,
    system: list.system === true,
    open: tasks.filter((t) => !t.done).length,
    total: tasks.length,
  }
}

function registerTools(ctx, svc, logger) {
  const tools = ctx.tools
  if (!tools) {
    logger('[todo] tools service unavailable; agent tools not registered')
    return
  }

  // -- task_list -----------------------------------------------------------
  ctx.effect(() => tools.register(defineTool({
    name: 'task_list',
    description:
      '列出待办任务。可按智能筛选（今天/本周/逾期/未安排/全部/已完成）、清单或关键词过滤。'
      + '返回任务的 id、标题、截止时间、重复规则、优先级、备注摘要与清单名。'
      + '需要修改或完成任务前，先用它拿到 id。',
    parameters: {
      filter: { type: 'string', description: '筛选：today | week | overdue | inbox | all | done（默认 all）' },
      list: { type: 'string', description: '只列某个清单（清单名或 id）' },
      query: { type: 'string', description: '关键词，匹配标题、备注和标签' },
      tag: { type: 'string', description: '只列带这个标签的任务（不带 #）' },
      includeDone: { type: 'boolean', description: '是否包含已完成任务（默认 false）' },
      limit: { type: 'number', description: '最多返回条数（默认 50）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const store = svc.require()
      const today = todayStr()
      const filter = FILTERS.includes(String(args.filter)) ? String(args.filter) : 'all'
      let listId = null
      if (args.list) {
        const list = store.listByname(String(args.list)) ?? store.listById(String(args.list))
        if (list === null) {
          return sanitize({
            error: `找不到清单：${args.list}`,
            lists: store.lists.map((l) => ({ id: l.id, name: l.name })),
            text: `找不到清单「${args.list}」。现有清单：${store.lists.map((l) => l.name).join('、')}`,
          })
        }
        listId = list.id
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200))
      const matched = filterTasks(store, {
        filter, listId, query: args.query, tag: args.tag, includeDone: args.includeDone === true, today,
      }).slice(0, limit)
      const counts = store.stats({ today })
      const text = [
        `今天 ${counts.dueToday} 项到期，${counts.overdue} 项逾期，${counts.open} 项未完成。`,
        renderTaskLines(matched, store, { today, emptyText: '没有匹配的任务。' }),
      ].join('\n')
      return sanitize({
        today,
        filter,
        counts,
        // The lists ride along so the agent has the ids it needs to rename,
        // recolour, reorder or delete one without a second tool call.
        lists: store.lists.map((l) => listView(l, store)),
        // Tags ride along the same way lists do: the agent can see what the user
        // actually tags things with (and how much) without a second call.
        tags: store.tagCounts(),
        tasks: matched.map((t) => taskView(t, store, { today })),
        text,
      })
    },
  })))

  // -- task_add ------------------------------------------------------------
  ctx.effect(() => tools.register(defineTool({
    name: 'task_add',
    description:
      '新建待办任务。可指定截止时间、备注、优先级、清单、标签、重复规则，或挂到某个父任务下成为子任务。'
      + '截止时间格式：YYYY-MM-DD（全天）或 YYYY-MM-DDTHH:mm（定时）。'
      + '重复：repeat = daily | weekly | monthly，可配合 repeatInterval（每 N 天/周/月）、'
      + 'repeatWeekdays（0=周日 … 6=周六，仅 weekly）、repeatUntil、repeatCount。',
    parameters: {
      title: { type: 'string', description: '任务标题', required: true },
      due: { type: 'string', description: '截止时间 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm' },
      start: { type: 'string', description: '开始时间（甘特图起点），格式同上' },
      note: { type: 'string', description: '备注（支持多行）' },
      priority: { type: 'number', description: '优先级 0=无 1=低 2=中 3=高' },
      list: { type: 'string', description: '清单名（不存在会自动创建）' },
      parent: { type: 'string', description: '父任务的 id 或标题；提供时创建子任务' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      repeat: { type: 'string', description: '重复频率：daily | weekly | monthly' },
      repeatInterval: { type: 'number', description: '重复间隔，默认 1' },
      repeatWeekdays: { type: 'array', items: { type: 'number' }, description: '每周重复的星期（0=周日 … 6=周六）' },
      repeatUntil: { type: 'string', description: '重复结束日期 YYYY-MM-DD' },
      repeatCount: { type: 'number', description: '重复总次数' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const store = svc.require()
      const today = todayStr()
      let parentId = null
      if (args.parent) parentId = svc.resolveId(args.parent)
      let listId = null
      if (args.list) listId = svc.ensureList(args.list).id
      const recurrence = svc.buildRecurrence(args)
      const created = store.create({
        title: args.title,
        due: args.due,
        start: args.start,
        note: args.note,
        priority: args.priority,
        listId,
        parentId,
        tags: args.tags,
        recurrence,
      })
      const counts = store.stats({ today })
      return sanitize({
        created: taskView(created, store, { today }),
        counts,
        text: `已创建：${created.title}（id=${created.id}）`
          + (created.due ? `，截止 ${created.due.replace('T', ' ')}` : '')
          + (created.recurrence ? `，${describeRecurrence(created.recurrence)}` : '')
          + `\n当前未完成 ${counts.open} 项，今天 ${counts.dueToday} 项到期。`,
      })
    },
  })))

  // -- task_update ---------------------------------------------------------
  ctx.effect(() => tools.register(defineTool({
    name: 'task_update',
    description:
      '修改已有任务或子任务：标题、备注、截止/开始时间、优先级、清单、标签、重复规则、父任务。'
      + '只传需要改动的字段即可。把 repeat 传空字符串（或 recurrence: null）可取消重复。',
    parameters: {
      id: { type: 'string', description: '任务 id 或唯一标题', required: true },
      title: { type: 'string', description: '新标题' },
      note: { type: 'string', description: '新备注（传空字符串可清空）' },
      due: { type: 'string', description: '新截止时间；传空字符串可清除' },
      start: { type: 'string', description: '新开始时间；传空字符串可清除' },
      priority: { type: 'number', description: '优先级 0..3' },
      list: { type: 'string', description: '移动到清单（名称，不存在会创建）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表（整体替换）' },
      parent: { type: 'string', description: '父任务 id 或标题；传空字符串可提升为顶层任务' },
      repeat: { type: 'string', description: '重复频率 daily | weekly | monthly；空字符串取消重复' },
      repeatInterval: { type: 'number', description: '重复间隔' },
      repeatWeekdays: { type: 'array', items: { type: 'number' }, description: '每周重复的星期' },
      repeatUntil: { type: 'string', description: '重复结束日期' },
      repeatCount: { type: 'number', description: '重复总次数' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const store = svc.require()
      const today = todayStr()
      const id = svc.resolveId(args.id)
      const patch = {}
      for (const key of ['title', 'note', 'due', 'start', 'tags']) {
        if (key in args && args[key] !== undefined) patch[key] = args[key]
      }
      if (args.priority !== undefined) patch.priority = args.priority
      if (args.list !== undefined && args.list !== null && args.list !== '') patch.listId = svc.ensureList(args.list).id
      if (args.parent !== undefined) {
        patch.parentId = args.parent === '' || args.parent === null ? null : svc.resolveId(args.parent)
      }
      if ('repeat' in args && args.repeat !== undefined) patch.recurrence = svc.buildRecurrence(args)
      const updated = store.update(id, patch)
      return sanitize({
        updated: taskView(updated, store, { today }),
        counts: store.stats({ today }),
        text: `已更新：${updated.title}（id=${updated.id}）`
          + (updated.recurrence ? `，${describeRecurrence(updated.recurrence)}` : '')
          + (updated.due ? `，截止 ${updated.due.replace('T', ' ')}` : '（无截止时间）'),
      })
    },
  })))

  // -- task_done -----------------------------------------------------------
  ctx.effect(() => tools.register(defineTool({
    name: 'task_done',
    description:
      '完成（或取消完成）一个任务。' +
      '重复任务被完成时会记录一次完成并把截止时间滚动到下一次，因此它不会变成「已完成」；'
      + '子任务会随重复任务的本次完成一起重置。',
    parameters: {
      id: { type: 'string', description: '任务 id 或唯一标题', required: true },
      undone: { type: 'boolean', description: '传 true 表示取消完成，而不是完成' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const store = svc.require()
      const today = todayStr()
      const id = svc.resolveId(args.id)
      const before = store.get(id)
      const want = args.undone === true ? false : true
      const task = before.done === want ? before : store.toggle(id, { today })
      const rolled = task.recurrence !== null && task.done === false
      const counts = store.stats({ today })
      const text = rolled
        ? `已完成一次「${task.title}」，下次 ${task.due.replace('T', ' ')}（第 ${task.completedCount} 次）。`
        : `${want ? '已完成' : '已取消完成'}：${task.title}`
      return sanitize({
        task: taskView(task, store, { today }),
        rolled,
        counts,
        text: `${text}\n今天 ${counts.dueToday} 项到期，${counts.overdue} 项逾期。`,
      })
    },
  })))

  // -- task_delete ---------------------------------------------------------
  ctx.effect(() => tools.register(defineTool({
    name: 'task_delete',
    description: '删除任务。若任务有子任务，会连同子任务一起删除。删除不可撤销。',
    parameters: {
      id: { type: 'string', description: '任务 id 或唯一标题', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const store = svc.require()
      const id = svc.resolveId(args.id)
      const title = store.get(id).title
      const result = store.remove(id)
      return sanitize({
        deleted: result.deleted,
        ids: result.ids,
        text: `已删除「${title}」${result.deleted > 1 ? `及其 ${result.deleted - 1} 个子任务` : ''}。`,
      })
    },
  })))

  // -- list_manage ---------------------------------------------------------
  ctx.effect(() => tools.register(defineTool({
    name: 'list_manage',
    description:
      '管理清单本身（不是任务）：列出 / 新建 / 改名 / 换颜色 / 调整顺序 / 删除。'
      + '删除清单只删掉分组，清单里的任务会移到「收集箱」，不会被删除；系统清单「收集箱」不能删除。'
      + '清单 id 用 action=list 获取，也可以用清单名代替。',
    parameters: {
      action: { type: 'string', description: 'list | create | update | move | delete', required: true },
      id: { type: 'string', description: '清单 id（优先于名称）' },
      name: { type: 'string', description: 'action=create：新清单名；其他 action：用名称指定清单' },
      newName: { type: 'string', description: 'action=update：改成这个名字' },
      color: { type: 'string', description: 'action=update：颜色，形如 #4f8cff' },
      index: { type: 'number', description: 'action=move：目标位置，0 = 最前' },
      delta: { type: 'number', description: 'action=move：相对位移，-1 上移一位 / 1 下移一位' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const store = svc.require()
      const action = String(args.action ?? 'list').toLowerCase()
      const lists = () => store.lists.map((l) => listView(l, store))
      const describe = (list) => `「${list.name}」${list.system ? '（系统清单）' : ''}`
      const names = () => store.lists.map((l) => l.name).join('、')

      if (action === 'list' || action === 'ls') {
        return sanitize({
          action: 'list',
          lists: lists(),
          text: store.lists.length === 0
            ? '还没有清单。'
            : '清单（按显示顺序）：\n' + store.lists.map((l, i) => {
              const view = listView(l, store)
              return `${i + 1}. ${l.name}${view.system ? '（系统清单）' : ''}  ${l.color}`
                + `  ${view.open} 未完成 / ${view.total} 总数  (id=${l.id})`
            }).join('\n'),
        })
      }

      if (action === 'create') {
        const name = String(args.name ?? '').trim()
        if (!name) throw new Error('action=create 需要清单名（name）')
        const created = store.createList({ name, color: args.color })
        return sanitize({
          action: 'create',
          list: listView(created, store),
          lists: lists(),
          text: `已创建清单「${created.name}」（id=${created.id}，颜色 ${created.color}）。现有清单：${names()}`,
        })
      }

      if (action === 'update') {
        const target = svc.resolveList(args.id ?? args.name)
        const before = target.name
        const updated = store.updateList(target.id, { name: args.newName, color: args.color })
        return sanitize({
          action: 'update',
          list: listView(updated, store),
          lists: lists(),
          text: `已更新清单${before === updated.name ? `「${updated.name}」` : `「${before}」→「${updated.name}」`}`
            + `，颜色 ${updated.color}。`,
        })
      }

      if (action === 'move') {
        const target = svc.resolveList(args.id ?? args.name)
        let index = args.index
        if (index === undefined && args.delta !== undefined) {
          const ordered = store.lists.map((l) => l.id)
          index = Math.max(0, Math.min(ordered.length - 1,
            ordered.indexOf(target.id) + Math.trunc(Number(args.delta) || 0)))
        }
        const result = store.moveList(target.id, { index })
        const ordered = store.lists.map((l) => l.name).join(' → ')
        return sanitize({
          action: 'move',
          list: listView(result.list, store),
          from: result.from,
          to: result.to,
          order: store.lists.map((l) => l.id),
          lists: lists(),
          text: `清单「${result.list.name}」已从第 ${result.from + 1} 位移到第 ${result.to + 1} 位。当前顺序：${ordered}`,
        })
      }

      if (action === 'delete' || action === 'remove') {
        const target = svc.resolveList(args.id ?? args.name)
        const label = describe(target)
        const result = store.removeList(target.id)
        return sanitize({
          action: 'delete',
          deleted: result.deleted,
          moved: result.moved,
          movedTo: result.movedTo,
          movedToName: result.movedToName,
          lists: lists(),
          text: `已删除清单${label}。`
            + (result.moved > 0
              ? `${result.moved} 个任务已移到「${result.movedToName ?? '收集箱'}」。`
              : '清单里没有任务。')
            + `现有清单：${names()}`,
        })
      }

      throw new Error(`不认识的 action：${args.action}（可用：list / create / update / move / delete）`)
    },
  })))

  // -- task_sync_feishu ----------------------------------------------------
  ctx.effect(() => tools.register(defineTool({
    name: 'task_sync_feishu',
    description:
      '把待办任务（含完成 / 逾期状态、清单、标签、子任务进度）同步到飞书多维表格（Bitable）。'
      + 'action=status 只看配置与上次同步结果（不联网）；'
      + 'action=test 只读探测连接（一次 token + 读字段 + 读一页行，不写任何数据，失败原样给出飞书的 code/message）；'
      + 'action=fields 给表格补上缺的列（新建的多维表格还没初始化时用这个，已有列不删不改）；'
      + 'action=reconcile 完整对账（本地与远端逐行比对：一致 / 有差异 / 各自独有 / 无匹配列的行，只读）；'
      + 'action=pull 从飞书补洞（只把远端有、本地没有的行导入本地；绝不覆盖或删除已有任务）；'
      + 'action=sync 执行同步，dryRun=true 只预览将要新增/更新/删除的行。'
      + '同步按「任务ID」字段匹配已有行，重复执行是幂等的；远端已不存在的行默认一并删除（可用 prune=false 保留）。'
      + '需要先在插件设置里填 appId / appSecret / appToken / tableId；'
      + 'sync 与 pull 还需要启用开关（test / fields / reconcile 不需要，它们本来就是启用前的准备与诊断）。',
    parameters: {
      action: { type: 'string', description: 'status | test | fields | reconcile | pull | sync（默认 sync）' },
      dryRun: { type: 'boolean', description: 'sync / fields / pull：只算不写（pull 的预览也不会动本地）' },
      prune: { type: 'boolean', description: 'action=sync：是否删除远端已无对应任务的行（默认按设置）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const action = String(args.action ?? 'sync').toLowerCase()
      if (action === 'status' || action === 'list' || action === 'ls') {
        const status = svc.feishuStatus()
        return sanitize({ action: 'status', feishu: status, text: renderFeishuStatus(status) })
      }
      if (action === 'test' || action === 'probe') {
        const probe = await svc.testFeishu()
        return sanitize({ action: 'test', ok: probe.ok, probe, text: renderFeishuProbe(probe) })
      }
      if (action === 'fields' || action === 'columns') {
        const result = await svc.ensureFeishuFields({ dryRun: args.dryRun === true })
        return sanitize({ action: 'fields', ok: true, result, text: renderFeishuFields(result) })
      }
      if (action === 'reconcile' || action === 'audit') {
        const report = await svc.reconcileFeishu({})
        return sanitize({ action: 'reconcile', ok: true, report, text: renderFeishuReconcile(report) })
      }
      if (action === 'pull' || action === 'hole') {
        const result = await svc.pullFeishu({ dryRun: args.dryRun === true })
        return sanitize({ action: 'pull', ok: true, result, text: renderFeishuPull(result) })
      }
      if (action !== 'sync' && action !== 'push') {
        throw new Error(`不认识的 action：${args.action}（可用：status / test / fields / reconcile / pull / sync）`)
      }
      const result = await svc.syncFeishu({ dryRun: args.dryRun === true, prune: args.prune })
      return sanitize({
        action: 'sync',
        ok: true,
        summary: result.summary,
        text: renderFeishuSummary(result.summary),
      })
    },
  })))
}

// ---------------------------------------------------------------------------
// host HTTP API for the browser half
// ---------------------------------------------------------------------------

const API_PREFIX = '/todo'

function registerApi(ctx, svc, logger) {
  const webServer = ctx.get?.('webServer')
  if (webServer === undefined) {
    logger('[todo] webServer unavailable; the todo UI will not be able to load data')
    return
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 2_000_000) req.destroy() })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })

  const send = (res, code, payload) => {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  const methods = {
    state: (args) => svc.state(args ?? {}),
    status: () => svc.status(),
    create: (args) => svc.create(args ?? {}),
    update: (args) => svc.update(args ?? {}),
    remove: (args) => svc.remove(args ?? {}),
    toggle: (args) => svc.toggle(args ?? {}),
    skip: (args) => svc.skip(args ?? {}),
    move: (args) => svc.move(args ?? {}),
    addSubtask: (args) => svc.addSubtask(args ?? {}),
    quickAdd: (args) => svc.quickAdd(args ?? {}),
    preview: (args) => svc.previewQuick(args ?? {}),
    createList: (args) => svc.createList(args ?? {}),
    updateList: (args) => svc.updateList(args ?? {}),
    moveList: (args) => svc.moveList(args ?? {}),
    removeList: (args) => svc.removeList(args ?? {}),
    clearCompleted: (args) => svc.clearCompleted(args ?? {}),
    occurrences: (args) => svc.occurrences(args ?? {}),
    exportDocument: (args) => svc.exportDocument(args ?? {}),
    importDocument: (args) => svc.importDocument(args ?? {}),
    // The settings page is the plugin's own: it reads the schema-derived form
    // here and writes back through `updateSettings`. There is no host settings
    // API involved, so this works the same on the web and desktop profiles.
    settings: () => svc.settingsForForm(),
    updateSettings: (args) => svc.updateSettings(args ?? {}),
    // Feishu Bitable sync. `feishuStatus` never touches the network, so the UI
    // (or a probe) can read it cheaply; `syncFeishu` does the real work.
    feishuStatus: () => svc.feishuStatus(),
    syncFeishu: (args) => svc.syncFeishu(args ?? {}),
    // The setup and diagnosis surface the settings page drives: a read-only
    // connection test, column completion for a fresh table, a full accounting,
    // and the additive pull that fills local holes from the table.
    feishuTest: () => svc.testFeishu(),
    feishuFields: (args) => svc.ensureFeishuFields(args ?? {}),
    feishuReconcile: (args) => svc.reconcileFeishu(args ?? {}),
    feishuPull: (args) => svc.pullFeishu(args ?? {}),
    // Renaming a tag has no dedicated tool (an agent can do it with task_update
    // per task), but the rail needs it: a typo used to be permanent, because the
    // only way to fix one was to edit every task that carried it.
    renameTag: (args) => {
      const store = svc.require()
      const from = String(args.from ?? args.tag ?? '').trim().replace(/^#/, '')
      const to = String(args.to ?? args.newTag ?? '').trim().replace(/^#/, '')
      if (!from) throw new Error('需要提供要改名的标签')
      let touched = 0
      for (const t of store.tasks) {
        if (!t.tags.some((x) => x.toLowerCase() === from.toLowerCase())) continue
        const next = to === ''
          ? t.tags.filter((x) => x.toLowerCase() !== from.toLowerCase())
          : [...new Set(t.tags.map((x) => (x.toLowerCase() === from.toLowerCase() ? to : x)))]
        store.update(t.id, { tags: next })
        touched++
      }
      store.flush()
      return { from, to, touched, state: svc.state(svc.viewOf(args)) }
    },
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = url.pathname.slice(API_PREFIX.length).replace(/^\/api\//, '').replace(/^\//, '')
      const fn = methods[method]
      if (fn === undefined) { send(res, 404, { ok: false, error: `unknown method: ${method}` }); return }
      if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST required' }); return }
      try {
        const args = await readBody(req)
        send(res, 200, { ok: true, data: sanitize(await fn(args ?? {})) })
      } catch (e) {
        send(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// `/todo` command
// ---------------------------------------------------------------------------

const TODO_USAGE = [
  '用法：',
  '  /todo                   今天的任务概览',
  '  /todo <内容>            快速添加（等同 /todo add，例如 /todo 明天 15:00 交报告 !高 #工作）',
  '  /todo add <内容>        快速添加（支持「明天 15:00 交报告 !高 #工作 @紧要」）',
  '  /todo ls [今天|本周|逾期|全部|已完成]   列出任务',
  '  /todo done <id|标题>    完成任务',
  '  /todo sync              同步到飞书多维表格',
  '  /todo sync 预览         只算差异，不写远端',
  '  /todo sync 状态         只看配置与上次结果（不联网）',
  '  /todo sync 测试         只读探测连接（不写数据）',
  '  /todo sync 字段         给表格补上缺的列（新建的表格用这个初始化）',
  '  /todo sync 对账         完整对账：两侧逐行比对，只读',
  '  /todo sync 补洞[预览]   从飞书补洞：只导入本地没有的行，不覆盖已有任务',
  '  /todo help              显示本帮助',
].join('\n')

function registerCommand(ctx, svc, logger) {
  const commands = ctx.get?.('commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    logger('[todo] commands service unavailable; /todo disabled (tools and UI still work)')
    return
  }
  try {
    ctx.effect(() => commands.register({
      name: 'todo',
      description: '待办任务：查看、添加、完成，或同步到飞书多维表格',
      input: { hint: '[<内容>|add <内容>|ls [筛选]|done <id|标题>|sync [状态|测试|字段|对账|补洞|预览]|help]' },
      async handler(invocation) {
        const raw = String(invocation?.rawInput ?? '').trim()
        const today = todayStr()
        try {
          const store = svc.require()
          if (!raw || raw === 'today' || raw === '今日') {
            const counts = store.stats({ today })
            const due = filterTasks(store, { filter: 'today', today })
            return {
              kind: 'success',
              text: [
                `今天 ${counts.dueToday} 项到期，${counts.overdue} 项逾期，共 ${counts.open} 项未完成。`,
                renderTaskLines(due, store, { today, emptyText: '今天没有到期任务。' }),
              ].join('\n'),
            }
          }
          if (/^(help|-h|--help|\?)$/i.test(raw)) return { kind: 'success', text: TODO_USAGE }
          // One implementation for `/todo add X` and the bare `/todo X`: the
          // keyword was only discoverable by reading --help, and the sentence
          // after it is the same sentence either way.
          const addFrom = (text) => {
            const result = store.quickAdd(text, { today })
            const view = taskView(result.task, store, { today })
            const bits = []
            if (view.due) bits.push(`截止 ${String(view.due).replace('T', ' ')}`)
            if (view.recurrence) bits.push(view.recurrence)
            if (view.priority > 0) bits.push(`优先级${view.priorityName}`)
            bits.push(`清单「${view.listName}」`)
            return {
              kind: 'success',
              text: `已添加：${view.title}\n${bits.join(' · ')}（id=${view.id}）`
                + (result.listCreated ? `\n已自动创建清单「${result.parsed.listName}」。` : ''),
            }
          }
          if (/^add\b/i.test(raw)) {
            const text = raw.replace(/^add\s*/i, '').trim()
            if (!text) return { kind: 'error', text: '请提供任务内容，例如：/todo add 明天 15:00 交报告 !高' }
            return addFrom(text)
          }
          if (/^ls\b/i.test(raw)) {
            const arg = raw.replace(/^ls\s*/i, '').trim()
            const map = {
              今天: 'today', 今日: 'today', 本周: 'week', 逾期: 'overdue',
              全部: 'all', 未安排: 'inbox', 已完成: 'done', done: 'done',
            }
            const filter = map[arg] ?? (FILTERS.includes(arg) ? arg : 'today')
            const tasks = filterTasks(store, { filter, today, includeDone: filter === 'done' })
            return {
              kind: 'success',
              text: `${filter} —— 共 ${tasks.length} 项\n`
                + renderTaskLines(tasks.slice(0, 60), store, { today, emptyText: '没有任务。' }),
            }
          }
          if (/^done\b/i.test(raw)) {
            const key = raw.replace(/^done\s*/i, '').trim()
            if (!key) return { kind: 'error', text: '请提供任务 id 或标题，例如：/todo done 交报告' }
            const id = svc.resolveId(key)
            const before = store.get(id)
            const task = before.done ? before : store.toggle(id, { today })
            const rolled = task.recurrence !== null && task.done === false
            return {
              kind: 'success',
              text: rolled
                ? `已完成一次「${task.title}」，下次 ${String(task.due).replace('T', ' ')}。`
                : `已完成「${task.title}」。`,
            }
          }
          if (/^sync\b/i.test(raw)) {
            const arg = raw.replace(/^sync\s*/i, '').trim().toLowerCase()
            if (arg === '状态' || arg === 'status') {
              return { kind: 'success', text: renderFeishuStatus(svc.feishuStatus()) }
            }
            if (arg === '测试' || arg === 'test' || arg === '连接') {
              return { kind: 'success', text: renderFeishuProbe(await svc.testFeishu()) }
            }
            if (arg === '字段' || arg === 'fields' || arg === '补全字段') {
              return { kind: 'success', text: renderFeishuFields(await svc.ensureFeishuFields({})) }
            }
            if (arg === '对账' || arg === 'reconcile' || arg === '审核') {
              return { kind: 'success', text: renderFeishuReconcile(await svc.reconcileFeishu({})) }
            }
            if (/^(补洞|pull)(\s|$)/.test(arg)) {
              const dry = /(预览|dry|preview)/.test(arg)
              return { kind: 'success', text: renderFeishuPull(await svc.pullFeishu({ dryRun: dry })) }
            }
            const dry = arg === '预览' || arg === 'dry' || arg === 'preview'
            const result = await svc.syncFeishu({ dryRun: dry })
            return { kind: 'success', text: renderFeishuSummary(result.summary) }
          }
          // Nothing matched a subcommand, so read the line as a quick-add: this
          // is the documented behaviour, not a fallback that happens to work.
          return addFrom(raw)
        } catch (e) {
          return { kind: 'error', text: `失败：${String(e?.message ?? e)}` }
        }
      },
    }))
  } catch (e) {
    logger(`[todo] /todo command not registered: ${String(e?.message ?? e)}`)
  }
}

