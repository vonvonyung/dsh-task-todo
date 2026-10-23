/**
 * dsh-task-todo -- browser half.
 *
 * Registers three seats:
 *
 *   sidebar.panellist        the sidebar's global panel row, between "new session"
 *                            and the workspace list: glyph + count badge, and its
 *                            id addresses the matching `main` panel
 *   main            (key todo)  the full central page: list / board / calendar / gantt
 *   shell.overlay            the frame-wide seat: the FULLSCREEN host and the
 *                            centred task dialog (one dialog, both hosts)
 *
 * Form rules for a bundle-plugin client half (each one is a recorded incident in
 * this workspace, not a style preference):
 *
 *   - React comes from `require('react')`. There is no `window.React`.
 *   - Styles are injected with `document.createElement('style')`; `styles.insert`
 *     does not exist here and calling it aborts the whole DSH boot.
 *   - Host calls are `fetch()` against this plugin's own HTTP route; there is no
 *     `host.call`.
 *   - Plain JavaScript only: no JSX, no imports, no TypeScript.
 *
 * Fullscreen and the dialog are overlaid rather than `position: fixed` inside the
 * panel. A fixed element is only truly frame-wide while no ancestor creates a
 * containing block (a `transform` anywhere above it silently traps it inside the
 * column), and `shell.overlay` is the seat that exists precisely to be above
 * everything. Both hosts share one module-level store, so toggling loses no view
 * state.
 *
 * The panel entry also hides the panel again on a second click. The shell only
 * ever SELECTS, so the click is intercepted in the capture phase on `document`,
 * before the shell's own handler (React listens at the container) can turn it into
 * a selection; see `PanelIcon`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-todo',

  factory: (require) => {
    // ---------------------------------------------------------------------
    // date helpers -- DISPLAY ONLY
    //
    // All task/date semantics (which day an occurrence lands on, what is
    // overdue, what is in "this week") are computed by the host and arrive in
    // `state.view`. The only calendar arithmetic here is the shape of the month
    // grid, which is pure presentation.
    // ---------------------------------------------------------------------

    const DAY_MS = 86400000

    // Optional task-menu extension ABI. This registry is a deliberately small
    // data/action surface: extensions register a callback, but never receive the
    // host transport (`call`) or arbitrary tool access.
    const TODO_TASK_ACTIONS_GLOBAL = '__dshTodoTaskActions'
    const TODO_TASK_ACTIONS_READY_EVENT = 'dsh-todo-task-actions-ready'
    const TODO_TASK_ACTIONS_API_VERSION = 1
    const TODO_COPY_TASK_CONTENT_ACTION_ID = 'todo.copy-task-content'
    const TODO_COPY_TO_DSH_CHAT_ACTION_ID = 'todo.copy-to-dsh-chat'
    const TODO_COMPOSER_CHANGED_EVENT = 'dsh-todo-composer-bridge-changed'
    const todoComposerBridges = new Map()
    let todoComposerBridgeSequence = 0

    function notifyTodoComposerBridgeChanged() {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof Event !== 'function') return
      try { window.dispatchEvent(new Event(TODO_COMPOSER_CHANGED_EVENT)) } catch (error) {
        console.warn('[todo] could not publish composer availability:', error)
      }
    }

    function registerTodoComposerBridge(target) {
      const token = ++todoComposerBridgeSequence
      todoComposerBridges.set(token, target)
      notifyTodoComposerBridgeChanged()
      return () => {
        if (!todoComposerBridges.delete(token)) return
        notifyTodoComposerBridgeChanged()
      }
    }

    function currentTodoComposerBridge() {
      let current = null
      for (const target of todoComposerBridges.values()) current = target
      return current
    }

    function todoComposerStatus() {
      const target = currentTodoComposerBridge()
      if (target === null) {
        return {
          target: null,
          state: null,
          enabled: false,
          reason: '请先打开或切回一个 DSH 对话，再从浮动待办窗口操作',
        }
      }
      if (typeof target.inputActions?.captureInsertion !== 'function'
        || typeof target.inputActions?.insertText !== 'function'
        || typeof target.sessionInput?.state?.getSnapshot !== 'function') {
        return { target, state: null, enabled: false, reason: '当前 DSH 版本未提供安全的输入框接口' }
      }
      let state
      try { state = target.sessionInput.state.getSnapshot() } catch {
        return { target, state: null, enabled: false, reason: '当前 DSH 对话输入框暂不可用' }
      }
      if (state?.phase !== 'plain') {
        const reason = state?.phase === 'claimed'
          ? '请先退出当前命令输入'
          : '当前对话正在提交，暂不能填入'
        return { target, state, enabled: false, reason }
      }
      return { target, state, enabled: true, reason: '' }
    }

    function freezeTaskSnapshot(value, seen = new Set()) {
      if (value === null || typeof value !== 'object' || seen.has(value)) return value
      seen.add(value)
      for (const child of Object.values(value)) freezeTaskSnapshot(child, seen)
      return Object.freeze(value)
    }

    function copyTaskSnapshot(task) {
      let copy
      try { copy = JSON.parse(JSON.stringify(task)) } catch { copy = { ...task } }
      return freezeTaskSnapshot(copy)
    }

    function createTodoTaskActionsApi() {
      const actions = new Map()
      const listeners = new Set()
      const changed = () => {
        for (const listener of [...listeners]) {
          try { listener() } catch (error) { console.warn('[todo] task-action subscriber failed:', error) }
        }
      }
      const report = (id, phase, error) => {
        console.warn(`[todo] task action "${id}" ${phase} failed; hiding that action`, error)
      }

      function forTask(task) {
        if (task === null || typeof task !== 'object') return []
        const snapshot = copyTaskSnapshot(task)
        const rows = []
        for (const { action } of [...actions.values()]) {
          let visible = true
          try {
            if (action.visible !== undefined) {
              visible = action.visible(snapshot)
              if (visible && typeof visible.then === 'function') throw new Error('visible(task) must be synchronous')
              visible = visible !== false
            }
          } catch (error) {
            report(action.id, 'visible(task)', error)
            continue
          }
          if (!visible) continue

          let label = action.label
          try {
            if (typeof label === 'function') label = label(snapshot)
            if (label && typeof label.then === 'function') throw new Error('label(task) must be synchronous')
          } catch (error) {
            report(action.id, 'label(task)', error)
            continue
          }
          if (typeof label !== 'string' || label.trim() === '') continue

          let enabled = true
          try {
            if (action.enabled !== undefined) {
              enabled = action.enabled(snapshot)
              if (enabled && typeof enabled.then === 'function') throw new Error('enabled(task) must be synchronous')
              enabled = enabled !== false
            }
          } catch (error) {
            report(action.id, 'enabled(task)', error)
            continue
          }

          let disabledReason = action.disabledReason ?? ''
          try {
            if (typeof disabledReason === 'function') disabledReason = disabledReason(snapshot)
            if (disabledReason && typeof disabledReason.then === 'function') {
              throw new Error('disabledReason(task) must be synchronous')
            }
          } catch (error) {
            report(action.id, 'disabledReason(task)', error)
            continue
          }
          if (disabledReason !== '' && disabledReason !== null && disabledReason !== undefined
            && typeof disabledReason !== 'string') continue
          disabledReason = typeof disabledReason === 'string' ? disabledReason.trim() : ''

          rows.push(Object.freeze({
            id: action.id,
            label: label.trim(),
            order: action.order,
            enabled: enabled && disabledReason === '',
            disabledReason,
            run: action.run,
          }))
        }
        return rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      }

      function register(input) {
        if (input === null || typeof input !== 'object') throw new TypeError('task action must be an object')
        const id = typeof input.id === 'string' ? input.id.trim() : ''
        if (id === '') throw new TypeError('task action id must be a non-empty string')
        if (typeof input.run !== 'function') throw new TypeError(`task action "${id}" must provide run(task, api)`)
        if (typeof input.label !== 'string' && typeof input.label !== 'function') {
          throw new TypeError(`task action "${id}" label must be a string or function`)
        }
        if (typeof input.label === 'string' && input.label.trim() === '') {
          throw new TypeError(`task action "${id}" label must not be empty`)
        }
        for (const key of ['visible', 'enabled']) {
          if (input[key] !== undefined && typeof input[key] !== 'function') {
            throw new TypeError(`task action "${id}" ${key} must be a function`)
          }
        }
        if (input.disabledReason !== undefined && typeof input.disabledReason !== 'function'
          && typeof input.disabledReason !== 'string') {
          throw new TypeError(`task action "${id}" disabledReason must be a string or function`)
        }
        const order = input.order === undefined ? 100 : input.order
        if (typeof order !== 'number' || !Number.isFinite(order)) {
          throw new TypeError(`task action "${id}" order must be a finite number`)
        }
        const action = Object.freeze({
          id,
          label: input.label,
          order,
          visible: input.visible,
          enabled: input.enabled,
          disabledReason: input.disabledReason,
          run: input.run,
        })
        const record = Object.freeze({ action })
        actions.set(id, record)
        changed()
        // Compare the record identity, not the id: a stale disposer from a
        // hot-reloaded extension must not remove its newer replacement.
        return () => {
          if (actions.get(id) !== record) return
          actions.delete(id)
          changed()
        }
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('task action subscriber must be a function')
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      return Object.freeze({
        apiVersion: TODO_TASK_ACTIONS_API_VERSION,
        register,
        subscribe,
        forTask,
      })
    }

    function getTodoTaskActionsApi() {
      if (typeof window === 'undefined') return null
      const current = window[TODO_TASK_ACTIONS_GLOBAL]
      if (current !== undefined && current !== null) {
        if (current.apiVersion === TODO_TASK_ACTIONS_API_VERSION
          && typeof current.register === 'function'
          && typeof current.subscribe === 'function'
          && typeof current.forTask === 'function') return current
        // Never downgrade or replace an unknown ABI: a newer todo client may
        // already own the same global and have extensions registered on it.
        console.warn(`[todo] task-action API v${String(current.apiVersion ?? 'unknown')} is already present; v1 will not replace it`)
        return null
      }

      const api = createTodoTaskActionsApi()
      try {
        window[TODO_TASK_ACTIONS_GLOBAL] = api
      } catch (error) {
        console.warn('[todo] could not publish the task-action API:', error)
        return null
      }
      if (window[TODO_TASK_ACTIONS_GLOBAL] !== api) {
        console.warn('[todo] task-action API global is not writable')
        return null
      }
      if (typeof window.dispatchEvent === 'function' && typeof Event === 'function') {
        try { window.dispatchEvent(new Event(TODO_TASK_ACTIONS_READY_EVENT)) } catch (error) {
          console.warn('[todo] could not dispatch the task-action-ready event:', error)
        }
      }
      return api
    }

    const todoTaskActionsApi = getTodoTaskActionsApi()
    const pad2 = (n) => String(n).padStart(2, '0')

    function todayStr() {
      const now = new Date()
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    }
    function parseDue(value) {
      if (typeof value !== 'string' || value.length < 10) return null
      const date = value.slice(0, 10)
      const time = value.length >= 16 ? value.slice(11, 16) : null
      return { date, time }
    }
    function dayIndexOf(dateStr) {
      const parts = String(dateStr).split('-').map(Number)
      return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS)
    }
    function dateFromIndex(index) {
      const dt = new Date(index * DAY_MS)
      return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
    }
    function addDaysStr(dateStr, n) { return dateFromIndex(dayIndexOf(dateStr) + n) }
    function monthOf(dateStr) { return String(dateStr).slice(0, 7) }
    function addMonthsStr(monthStr, n) {
      const parts = String(monthStr).split('-').map(Number)
      const total = parts[0] * 12 + (parts[1] - 1) + n
      return `${Math.floor(total / 12)}-${pad2(total % 12 + 1)}`
    }
    const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']

    /** '今天 15:00' / '明天' / '9月20日' / '2026-10-30' */
    function fmtDue(value, today) {
      const parsed = parseDue(value)
      if (parsed === null) return ''
      const gap = dayIndexOf(parsed.date) - dayIndexOf(today)
      let label
      if (gap === 0) label = '今天'
      else if (gap === 1) label = '明天'
      else if (gap === -1) label = '昨天'
      else if (gap === 2) label = '后天'
      else if (gap > 2 && gap <= 7) label = `周${WEEKDAY_CN[new Date(`${parsed.date}T00:00:00`).getDay()]}`
      else {
        const sameYear = parsed.date.slice(0, 4) === today.slice(0, 4)
        const [, m, d] = parsed.date.split('-').map(Number)
        label = sameYear ? `${m}月${d}日` : `${parsed.date.slice(0, 4)}年${m}月${d}日`
      }
      return parsed.time === null ? label : `${label} ${parsed.time}`
    }

    function fmtDateFull(dateStr) {
      if (typeof dateStr !== 'string' || dateStr.length < 10) return ''
      const [y, m, d] = dateStr.split('-').map(Number)
      const weekday = WEEKDAY_CN[new Date(`${dateStr}T00:00:00`).getDay()]
      return `${y}年${m}月${d}日 周${weekday}`
    }

    /**
     * A 6x7 month grid. `weekStart` is 0 (Sunday) or 1 (Monday), from settings.
     * Cells outside the month are still returned so the grid keeps its shape,
     * and the caller dims them.
     */
    function monthGrid(monthStr, weekStart) {
      const [y, m] = String(monthStr).split('-').map(Number)
      const firstIndex = Math.floor(Date.UTC(y, m - 1, 1) / DAY_MS)
      const firstWeekday = new Date(firstIndex * DAY_MS).getUTCDay()
      const lead = (firstWeekday - weekStart + 7) % 7
      const cells = []
      for (let i = 0; i < 42; i++) {
        const date = dateFromIndex(firstIndex - lead + i)
        cells.push({
          date,
          day: Number(date.slice(8, 10)),
          inMonth: date.slice(0, 7) === monthStr,
        })
      }
      return cells
    }

    function weekdayHeaders(weekStart) {
      const out = []
      for (let i = 0; i < 7; i++) out.push(WEEKDAY_CN[(weekStart + i) % 7])
      return out
    }

    function recurrenceRuleText(rec) {
      if (rec === null) return '不重复'
      const names = ['日', '一', '二', '三', '四', '五', '六']
      const unit = rec.freq === 'daily' ? '天' : rec.freq === 'weekly' ? '周' : '个月'
      const n = Number(rec.interval ?? 1)
      let text = n === 1
        ? (rec.freq === 'daily' ? '每天' : rec.freq === 'weekly' ? '每周' : '每月')
        : `每 ${n} ${unit}`
      if (rec.freq === 'weekly' && Array.isArray(rec.weekdays) && rec.weekdays.length > 0) {
        text += ' ' + rec.weekdays.map((w) => `周${names[w]}`).join('、')
      }
      if (rec.until) text += `，直到 ${rec.until}`
      else if (rec.count) text += `，共 ${rec.count} 次`
      if (rec.finished === true) text += '（已结束）'
      return text
    }

    // ---------------------------------------------------------------------
    // settings-report wording (factory scope)
    //
    // These live OUT here, not inside `apply`, for one reason: the settings page
    // renders them and `__internals` exposes them, and a component inside `apply`
    // cannot share a value with a sibling property of the returned object. One
    // definition means the gate asserts exactly the text the user reads -- which
    // is how "本地 undefined 行" would have been caught before shipping.
    // ---------------------------------------------------------------------

    const reportLines = {
      /** One sync summary (or a dry-run plan). */
      sync(summary) {
        const planned = summary.planned ?? {}
        const created = summary.created === undefined ? (planned.created ?? 0) : summary.created
        const updated = summary.updated === undefined ? (planned.updated ?? 0) : summary.updated
        const deleted = summary.deleted === undefined ? (planned.deleted ?? 0) : summary.deleted
        const conflicts = summary.conflicts ?? []
        const show = (value) => value === '' ? '（空）' : String(value ?? '').replace(/\s+/g, ' ').slice(0, 80)
        const reason = { unknown: '无共同基准', remote: '飞书端有变更', both: '两端都变更' }
        const lines = []
        const hasDeleteConflict = conflicts.some((row) => row.operation === 'delete')
        if (summary.stale === true) {
          return ['预览已过期：本地或飞书数据在确认前发生变化，没有写入；请重新预览。']
        }
        if (summary.blocked === true) {
          lines.push(`发现 ${conflicts.length} 条冲突，未写入远端（本地 ${summary.local} 行 / 远端 ${summary.remote} 行）`)
          lines.push('本地与飞书值不同且无法确认更新方向；请选择本地覆盖、按飞书更新本地或跳过冲突。')
        } else {
          lines.push(`${summary.dryRun === true ? '预览（未写远端）' : '已同步'}：本地 ${summary.local} 行 / 远端 ${summary.remote} 行`)
          lines.push(`新增 ${created} · 更新 ${updated} · 删除 ${deleted} · 未变 ${summary.unchanged}`)
          if (summary.skippedConflicts > 0) lines.push(`已跳过 ${summary.skippedConflicts} 条冲突任务，只同步了无冲突任务`)
        }
        for (const row of conflicts.slice(0, 5)) {
          const details = row.changes.map((change) =>
            `${change.field}：${show(change.local)} → ${show(change.remote)}（${reason[change.reason] ?? '需确认'}）`).join('；')
          lines.push(`${row.operation === 'delete' ? '删除冲突' : '冲突'}：${row.title}（${row.key}）—— ${details}`)
        }
        if (conflicts.length > 5) lines.push(`（还有 ${conflicts.length - 5} 条冲突未列出）`)
        if (hasDeleteConflict) {
          lines.push('其中包含本地删除与飞书修改冲突：自动同步会保留飞书行；要恢复任务可用「从飞书补洞」，确认删除再选择「按本地覆盖飞书」。')
        }
        // The table may legitimately hold more rows than this workspace has;
        // saying so, with the reason, is what stops "why is nothing getting
        // deleted" from reading like a bug in the sync.
        if (summary.unmanaged > 0) {
          lines.push(summary.prune === true
            ? `远端另有 ${summary.unmanaged} 行不属于本工作区（没有删除记录），保持原样`
            : `远端另有 ${summary.unmanaged} 行不属于本工作区，保持原样；`
              + '要删除「本地已删任务」对应的行，请在设置里打开「删除远端已移除行」')
        }
        return lines
      },

      /** A connection test. */
      probe(probe) {
        const step = probe.step === 'token' ? '凭证' : probe.step === 'fields' ? '读表格字段' : probe.step === 'records' ? '读行' : '未知环节'
        const lines = [
          probe.ok === true ? '连接正常（未写入任何数据）' : `失败在：${step}`,
          `域名 ${probe.baseUrl} · app_token ${probe.appToken} · table ${probe.tableId}`,
          `凭证 ${probe.tokenOk === true ? '通过' : '未通过'} · 表格 ${probe.tableOk === true ? '可读' : '未读到'}`,
        ]
        if (probe.tableOk === true) {
          lines.push(`远端 ${probe.remote} 行，其中带「${probe.keyField}」的 ${probe.keyed} 行`)
          lines.push(probe.columns.missing.length === 0
            ? `列齐全（${probe.columns.present.length} 列）`
            : `缺 ${probe.columns.missing.length} 列：${probe.columns.missing.join('、')} —— 可点「补全字段」`)
        }
        if (probe.error !== undefined) lines.push(`飞书返回：${probe.error}`)
        return lines
      },

      /** A column-completion run. */
      fields(result) {
        if (result.missing.length === 0) return [`表格字段已齐全（${result.existing.length} 列），没有要补的`]
        const lines = [result.dryRun === true
          ? `将补 ${result.missing.length} 列：${result.missing.join('、')}`
          : `已补 ${result.created.length} 列${result.failed.length === 0 ? '' : `，失败 ${result.failed.length} 列`}`]
        for (const item of result.failed) lines.push(`失败：${item.name} —— ${item.error}`)
        lines.push('只新增缺的列（文本类型），已有列不改不删。')
        return lines
      },

      /** A full reconciliation. */
      reconcile(report) {
        const lines = [
          `本地 ${report.local} 行 / 远端 ${report.remote} 行（带「${report.keyField}」的 ${report.keyed} 行）`,
          `完全一致 ${report.identical} · 有差异 ${report.differing.length}`,
          `本地有远端没有 ${report.localOnly.length} · 远端有本地没有 ${report.remoteOnly.length}`
          + (report.unkeyed > 0 ? ` · 远端无「${report.keyField}」的行 ${report.unkeyed}（不参与）` : ''),
        ]
        const missing = report.columns?.missing ?? []
        if (missing.length > 0) lines.push(`缺列：${missing.join('、')}（缺列会让对账显示成"处处有差异"）`)
        const show = (value) => value === '' ? '（空）' : String(value ?? '').replace(/\s+/g, ' ').slice(0, 80)
        const direction = { unknown: '无基准', local: '本地变更', remote: '飞书变更', both: '两端变更' }
        for (const row of report.differing.slice(0, 5)) {
          const changes = (row.changes ?? []).map((change) =>
            `${change.field}：${show(change.local)} → ${show(change.remote)}（${direction[change.direction] ?? '有差异'}）`).join('；')
          lines.push(`差异：${row.title}（${row.key}）—— ${changes || row.fields.join('、')}`)
        }
        if (report.differing.length > 5) lines.push(`（还有 ${report.differing.length - 5} 条差异未列出）`)
        if (report.remoteOnly.length > 0) lines.push('远端多出来的行可以点「从飞书补洞」导入本地。')
        return lines
      },

      /** A pull, or its preview. */
      pull(result) {
        const lines = [result.dryRun === true
          ? `将补 ${result.planned} 个本地没有的任务（远端 ${result.remote} 行，其中 ${result.holes} 个是"洞"）`
          : `已补 ${result.created} 个任务（远端 ${result.remote} 行，其中 ${result.holes} 个是"洞"）`]
        for (const item of result.items.slice(0, 5)) lines.push(`· ${item.title}`)
        if (result.items.length > 5) lines.push(`（还有 ${result.items.length - 5} 条未列出）`)
        if (result.skipped.length > 0) lines.push(`跳过 ${result.skipped.length} 行：${result.skipped[0].reason}`)
        if (result.createdLists.length > 0) lines.push(`顺带创建的清单：${result.createdLists.join('、')}`)
        if (result.unlinkedParents.length > 0) lines.push(`父任务没接上：${result.unlinkedParents.join('、')}`)
        if (result.notRestored.length > 0) lines.push(`未还原的列：${result.notRestored.join('、')}（远端是自然语言描述，无法反推）`)
        lines.push('只新增本地缺的；不覆盖、不删除任何已有任务。')
        return lines
      },
      /** Apply supported remote changes to matching local tasks. */
      applyRemote(result) {
        const conflictItems = Array.isArray(result.conflicts) ? result.conflicts : []
        const conflictCount = conflictItems.reduce((total, item) => total + (item.changes ?? []).length, 0)
        const lines = [result.stale === true
          ? '预览已过期：本地或飞书数据在确认前发生变化，没有更新任何任务；请重新预览。'
          : result.confirmationRequired === true
            ? '已生成预览；应用前请显式确认，或将 previewToken 随下一次请求提交。'
            : result.dryRun === true
              ? `从飞书更新本地（预览）：匹配 ${result.matched} 项，发现 ${result.differing} 个字段差异，可更新 ${result.planned} 项`
              : `从飞书更新本地：已更新 ${result.updated} 项（${result.updatedFields} 个字段），匹配 ${result.matched} 项`]
        const show = (value) => value === '' ? '（空）' : String(value ?? '').replace(/\s+/g, ' ').slice(0, 80)
        for (const item of result.items.slice(0, 5)) {
          const changes = item.changes.map((change) =>
            `${change.field}：${show(change.local)} → ${show(change.remote)}${change.applied ? '' : `（未导入：${change.reason}）`}`).join('；')
          lines.push(`· ${item.title}（${item.key}）：${changes}`)
        }
        if (result.items.length > 5) lines.push(`（还有 ${result.items.length - 5} 项差异未列出）`)
        if (result.notApplied.length > 0) lines.push(`未导入的列：${result.notApplied.join('、')}`)
        if (result.missingColumns.length > 0) lines.push(`远端缺列（未按空值覆盖）：${result.missingColumns.join('、')}`)
        if (result.skipped.length > 0) lines.push(`跳过 ${result.skipped.length} 行：${result.skipped[0].reason}`)
        if (result.createdLists.length > 0) lines.push(`顺带创建的清单：${result.createdLists.join('、')}`)
        // Both sides changed (or there is no shared baseline): the direction is
        // a question for the user, exactly like the conflict dialog the task
        // view opens. The settings page offers the same two one-click answers.
        if (conflictCount > 0) {
          lines.push(`其中 ${conflictCount} 个字段无法自动判断方向（两端都改过，或没有共同基准），`
            + '可用「全部采用飞书」或「全部保留本地」一次处理。')
          for (const item of conflictItems.slice(0, 3)) {
            const fields = (item.changes ?? []).map((change) => change.field).join('、')
            lines.push(`· 待选择：${item.title}（${item.key}）—— ${fields}`)
          }
          if (conflictItems.length > 3) lines.push(`（还有 ${conflictItems.length - 3} 项待选择未列出）`)
        }
        lines.push('只更新本地已有且任务ID匹配的任务；不覆盖本地单方修改，不创建远端独有任务，不删除任何任务。')
        return lines
      },

      /**
       * One 「全部采用飞书 / 全部保留本地」 run.
       *
       * The host answers per item, so a partial result says exactly what moved
       * and what still needs a decision. Silence about a conflict is the one
       * outcome this wording must never produce.
       */
      resolveAll(result) {
        const label = result.direction === 'local' ? '全部保留本地' : '全部采用飞书'
        const failed = Array.isArray(result.failed) ? result.failed : []
        const lines = []
        if (result.stale === true) {
          lines.push(`${label}：本地或飞书数据在处理前发生变化，没有写入；请重新检查后再试。`)
        } else {
          lines.push(`${label}：处理 ${result.resolved ?? 0} 项，未处理 ${failed.length} 项`)
          if (result.direction === 'remote') {
            lines.push(`本地更新 ${result.updated ?? 0} 项（${result.updatedFields ?? 0} 个字段）`)
          } else {
            lines.push(`推送飞书 ${result.pushed ?? 0} 项${(result.created ?? 0) > 0 ? `，新建 ${result.created} 行` : ''}`)
          }
          if ((result.removed ?? 0) > 0) lines.push(`按飞书删除本地任务 ${result.removed} 个`)
          if ((result.restored ?? 0) > 0) lines.push(`从飞书恢复本地任务 ${result.restored} 个`)
        }
        for (const item of failed.slice(0, 4)) {
          const who = item.title || item.key || '冲突'
          lines.push(`· 未处理：${who}${item.field && item.field !== '__delete__' ? `（${item.field}）` : ''} —— ${item.reason ?? '需逐项处理'}`)
        }
        if (failed.length > 4) lines.push(`（还有 ${failed.length - 4} 项未处理）`)
        if (failed.length > 0) lines.push('未处理的冲突保持原样，可以用「预览同步」后逐项选择，或重新执行本操作。')
        return lines
      },
    }

    return {
    name: 'todo-client',

    // Declared so Cordis waits for the slot and current-session input services before apply() runs.
    inject: ['slots', 'layout', 'sessions', 'conversation'],

    apply(ctx) {
      const slots = ctx.slots ?? ctx.get('slots')
      if (slots === undefined) {
        console.error('[todo] slots service unavailable; the todo UI is not mounted')
        return
      }

      const API = '/todo/api'
      const React = require('react')
      const h = React.createElement
      const { useState, useEffect, useMemo, useRef, useCallback } = React
      const sessions = ctx.sessions ?? ctx.get('sessions')
      const conversation = ctx.conversation ?? ctx.get('conversation')

      /** Hidden session-scoped consumer of DSH's supported composer API. */
      function TodoComposerBridge({ sessionId, inputActions, sessionInput }) {
        const targetRef = useRef({})
        targetRef.current.sessionId = sessionId
        targetRef.current.inputActions = inputActions
        targetRef.current.sessionInput = sessionInput

        useEffect(() => {
          if (sessionId === undefined || sessionId === null) return undefined
          const target = targetRef.current
          const dispose = registerTodoComposerBridge(target)
          const state = sessionInput?.state
          let phase
          try { phase = state?.getSnapshot?.()?.phase } catch { /* action will report unavailable */ }
          let unsubscribe = () => {}
          try {
            const off = state?.subscribe?.(() => {
              let nextPhase
              try { nextPhase = state.getSnapshot()?.phase } catch { return }
              if (nextPhase === phase) return
              phase = nextPhase
              notifyTodoComposerBridgeChanged()
            })
            if (typeof off === 'function') unsubscribe = off
          } catch { /* action state checks remain the authoritative guard */ }
          return () => { unsubscribe(); dispose() }
        }, [sessionId, inputActions, sessionInput])

        return null
      }

      // ---------------------------------------------------------------------
      // host transport
      // ---------------------------------------------------------------------

      /** POST one JSON method call to the host half. */
      async function call(method, args) {
        const res = await fetch(`${API}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args ?? {}),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const payload = await res.json()
        if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
          throw new Error(payload?.error ?? '请求失败')
        }
        return payload.data
      }

      // ---------------------------------------------------------------------
      // shared app state
      //
      // One module-level store, subscribed by every mounted seat. The sidebar
      // badge and the full page must never disagree, and the fullscreen host is a
      // different React tree from the panel host, so a shared store is what keeps
      // the view/filter/drawer state across the toggle. Nothing here is a live
      // framework object: it is plain JSON from the host plus UI preferences.
      // ---------------------------------------------------------------------

      const app = {
        data: null,
        error: null,
        loading: false,
        view: 'list', // list | board | calendar | gantt
        filter: 'all', // today | week | overdue | inbox | all | done
        listId: null,
        tag: '', // exact tag filter, set by the rail's 标签 rows
        query: '',
        includeDone: false,
        openId: null, // task id shown in the editor drawer
        completionId: null, // task whose completion summary / follow-up is being confirmed
        completionDraft: null, // temporary completion form values for that task
        completionSaving: false,
        completionError: null,
        collapsed: {}, // parentId -> collapsed?
        fullscreen: false,
        float: false, // the draggable floating window (overlay seat)
        appearanceOpen: false, // the appearance picker (overlay seat)
        planExportOpen: false, // the monthly-plan export dialog (overlay seat)
        calMonth: null, // 'YYYY-MM' for the calendar view
        ganttAnchor: null, // 'YYYY-MM-DD' start of the gantt window
        day: null, // selected day in the calendar view
        toast: null,
        confirm: null, // { title, body, ok, danger, resolve } while a question is open
        menuList: null, // list popup for the current task
        listEditor: null, // list id whose settings dialog is open (overlay seat)
        viewBeforeFloat: null, // the view kind the float took over, put back on dock
        // -- the capture draft and the layers that read it ----------------------
        // The draft lives here, not in a component, because three seats render the
        // same input: the panel, the floating window and the global capture layer.
        // A component's state would be lost the moment the seat unmounted (which
        // is exactly the "switch seats, lose what I typed" bug), and the seats do
        // come and go -- the panel is hidden while the window is up.
        quick: '',
        qPreview: null, // the host's answer for the current draft
        quickFocus: null, // 'panel' | 'float' | 'overlay' -- a ONE-SHOT focus request
        capture: false, // the global capture layer is visible
        cmdk: false, // the command palette is visible
        // -- keyboard navigation -------------------------------------------------
        focusId: null, // the row the keyboard is on (roving tabindex)
        tagExpanded: false,
        dataOpen: false,
        // -- inline add ----------------------------------------------------------
        grpNew: null, // group key whose inline input is open
        colNew: null, // column id whose inline input is open
        // The rail's "new list" row is open. In the store, not in the panel, because
        // the command palette can open it too and a command that silently does
        // nothing is worse than no command.
        creatingList: false,
        feishuSync: null,
        feishuSyncOpen: false,
      }

      const listeners = new Set()
      function emit() { for (const fn of listeners) fn() }
      function setApp(patch) { Object.assign(app, patch); emit() }
      function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
      function openCompletion(id, task) {
        const target = task ?? app.data?.tasks?.find((item) => item.id === id)
        if (target === undefined || target === null || target.done === true) return
        const today = app.data?.today ?? todayStr()
        setApp({
          completionId: target.id,
          completionDraft: {
            summary: '',
            followUp: false,
            followUpTitle: `跟进：${target.title}`.slice(0, 500),
            followUpDue: addDaysStr(today, 30),
          },
          completionSaving: false,
          completionError: null,
          error: null,
        })
      }
      function patchCompletionDraft(patch) {
        if (app.completionDraft === null) return
        setApp({ completionDraft: { ...app.completionDraft, ...patch }, completionError: null })
      }
      // The four palette themes (方案 C) are token-only re-skins: same structure,
      // same type scale, different colours. Kept in the same list as the three
      // structural styles because one picker, one saved value, one attribute.
      const APPEARANCES = ['flat', 'editorial', 'playful', 'c1', 'c2', 'c3', 'c4']
      function appearanceKey(settings = app.data?.settings) {
        return APPEARANCES.includes(settings?.appearance) ? settings.appearance : 'flat'
      }

      function useApp() {
        const [snapshot, setSnapshot] = useState(app)
        useEffect(() => subscribe(() => setSnapshot({ ...app })), [])
        return snapshot
      }

      /** The view context every state request carries, so the host can answer with
       *  exactly the slice the active view renders. */
      function viewContext(patch = {}) {
        const a = { ...app, ...patch }
        const context = {
          view: a.view,
          filter: a.filter,
          listId: a.listId,
          tag: a.tag,
          query: a.query,
          includeDone: a.includeDone,
        }
        if (a.view === 'calendar') {
          const month = a.calMonth ?? monthOf(a.data?.today ?? todayStr())
          context.from = `${month}-01`
          context.to = addDaysStr(`${month}-01`, 41)
        } else if (a.view === 'gantt') {
          const anchor = a.ganttAnchor ?? a.data?.today ?? todayStr()
          context.from = addDaysStr(anchor, -7)
          context.to = addDaysStr(anchor, 30)
        }
        return context
      }

      let feishuEntryPromise = null
      let feishuEntryRequestedAt = 0
      let feishuEntryRetryTimer = null
      function clearFeishuEntryRetry() {
        if (feishuEntryRetryTimer !== null) clearTimeout(feishuEntryRetryTimer)
        feishuEntryRetryTimer = null
      }
      function scheduleFeishuEntryRetry() {
        if (feishuEntryRetryTimer !== null) return
        feishuEntryRetryTimer = setTimeout(() => {
          feishuEntryRetryTimer = null
          if (app.data?.settings?.feishu?.enabled === true) {
            void requestFeishuEntrySync(true).catch(() => {})
          }
        }, 1200)
      }
      function adoptFeishuEntry(result) {
        if (result === null || typeof result !== 'object') return
        if (result.state !== undefined) app.data = result.state
        if (result.enabled !== true) {
          clearFeishuEntryRetry()
          setApp({ data: result.state ?? app.data, feishuSync: null, feishuSyncOpen: false })
          return
        }
        const conflicts = Array.isArray(result.conflicts) ? result.conflicts : []
        const sync = result.sync ?? {}
        const next = {
          enabled: true,
          ok: result.ok !== false,
          busy: result.busy === true,
          stale: result.stale === true,
          at: result.at ?? null,
          imported: Number(result.imported) || 0,
          remoteUpdated: Number(result.remoteUpdated) || 0,
          pushed: {
            created: Number(sync.created) || 0,
            updated: Number(sync.updated) || 0,
            deleted: Number(sync.deleted) || 0,
          },
          conflicts,
          error: result.stale === true ? '两端状态在检查期间发生变化，请重新检查。' : null,
          resolving: null,
        }
        setApp({
          ...(result.state === undefined ? {} : { data: result.state, error: null }),
          feishuSync: next,
          // Background reconciliation updates the compact status control only;
          // it never steals focus by opening the conflict dialog for the user.
          feishuSyncOpen: app.feishuSyncOpen === true,
        })
        if (result.busy === true) scheduleFeishuEntryRetry()
        else clearFeishuEntryRetry()
      }
      function recordFeishuEntryError(error) {
        clearFeishuEntryRetry()
        const previous = app.feishuSync ?? {}
        setApp({ feishuSync: {
          ...previous,
          enabled: true,
          ok: false,
          busy: false,
          error: String(error?.message ?? error),
          conflicts: Array.isArray(previous.conflicts) ? previous.conflicts : [],
          resolving: null,
        } })
      }
      async function requestFeishuEntrySync(force = false) {
        if (feishuEntryPromise !== null) return feishuEntryPromise
        if (!force && Date.now() - feishuEntryRequestedAt < 1500) return null
        feishuEntryRequestedAt = Date.now()
        setApp({ feishuSync: {
          ...(app.feishuSync ?? {}), enabled: true, busy: true, error: null,
        } })
        feishuEntryPromise = (async () => {
          try {
            const result = await call('feishuEntrySync', { ...viewContext(), force })
            adoptFeishuEntry(result)
            return result
          } catch (error) {
            recordFeishuEntryError(error)
            throw error
          } finally {
            feishuEntryPromise = null
          }
        })()
        return feishuEntryPromise
      }

      let inflight = 0
      /** Load (or reload) the active view's data. */
      async function refresh(patch = {}, quiet = false) {
        if (!quiet) setApp({ loading: true })
        const token = ++inflight
        try {
          const data = await call('state', viewContext(patch))
          // A slower earlier request must not overwrite a newer answer.
          if (token === inflight) setApp({ data, error: null, loading: false })
        } catch (e) {
          if (token === inflight) setApp({ error: String(e?.message ?? e), loading: false })
        }
      }

      /** Run a mutation and adopt the state the host returns with it.
       *
       *  The view context rides along, so the echoed state is the view the user is
       *  actually looking at: toggling a task on the calendar must not come back
       *  as the list payload. */
      async function mutate(method, args) {
        try {
          const result = await call(method, { ...args, view: viewContext() })
          if (result !== null && typeof result === 'object' && result.state !== undefined) {
            setApp({ data: result.state, error: null })
          }
          return result
        } catch (e) {
          setApp({ error: String(e?.message ?? e) })
          return null
        }
      }

      // Agent tools can mutate the shared document while this client is open.
      // Re-fetch when opening details so an out-of-band completion summary is not
      // hidden behind a stale in-memory task projection.
      function openTaskDetails(id) {
        setApp({ openId: id })
        void refresh({}, true)
      }

      async function completeTask(id, draft) {
        const args = {
          id,
          done: true,
          completionSummary: String(draft?.summary ?? ''),
        }
        if (draft?.followUp === true) {
          const title = String(draft.followUpTitle ?? '').trim()
          const due = String(draft.followUpDue ?? '').trim()
          if (title === '') {
            setApp({ completionError: '请填写跟进任务标题。' })
            return null
          }
          if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(due)) {
            setApp({ completionError: '请选择有效的跟进截止日期。' })
            return null
          }
          args.followUp = { title, due }
        }
        setApp({ completionSaving: true, completionError: null, error: null })
        const result = await mutate('toggle', args)
        if (result === null) {
          setApp({ completionSaving: false, completionError: app.error ?? '完成任务失败，请重试。' })
          return null
        }
        setApp({ completionId: null, completionDraft: null, completionSaving: false, completionError: null })
        toast(result.followUp === null || result.followUp === undefined
          ? '任务已完成'
          : `任务已完成，已创建跟进任务（截止 ${String(result.followUp.due ?? '').slice(0, 10)}）`)
        return result
      }

      // ---------------------------------------------------------------------
      // the floating window
      //
      // A second surface on the SAME store, not a second app: the list it shows
      // is the list the panel shows, and the task dialog stays the overlay's, so
      // it can never be trapped inside the box. Only the box -- where it sits and
      // how big it is -- is local, and it is persisted, because a window the user
      // dragged somewhere is a preference, not a transient.
      // ---------------------------------------------------------------------

      const FLOAT_KEY = 'dsh-task-todo:float:v1'
      const FLOAT_MIN_W = 260
      const FLOAT_MIN_H = 200

      function clampNum(value, low, high) { return Math.min(Math.max(value, low), high) }

      /** The first box: the right edge under the header, where a widget belongs. */
      function floatBoxDefault() {
        const vw = typeof window === 'undefined' ? 1280 : (Number(window.innerWidth) || 1280)
        const vh = typeof window === 'undefined' ? 800 : (Number(window.innerHeight) || 800)
        const width = clampNum(Math.round(vw * 0.28), FLOAT_MIN_W, 380)
        return {
          left: vw - width - 28,
          top: 92,
          width,
          height: clampNum(vh - 200, FLOAT_MIN_H, 560),
        }
      }

      /**
       * Keep the box in the viewport with 56px of it always reachable: a window
       * dragged past an edge must still be draggable back, and a page narrowed
       * after the box was placed must not strand it off-screen.
       */
      function floatClamp(box) {
        const vw = typeof window === 'undefined' ? 1280 : (Number(window.innerWidth) || 1280)
        const vh = typeof window === 'undefined' ? 800 : (Number(window.innerHeight) || 800)
        const width = clampNum(box.width, FLOAT_MIN_W, Math.max(FLOAT_MIN_W, vw - 24))
        const height = clampNum(box.height, FLOAT_MIN_H, Math.max(FLOAT_MIN_H, vh - 24))
        return {
          width,
          height,
          left: clampNum(box.left, 12 - width + 56, Math.max(12, vw - 56)),
          top: clampNum(box.top, 4, Math.max(4, vh - 52)),
        }
      }

      function loadFloatBox() {
        try {
          if (typeof localStorage === 'undefined') return null
          const raw = localStorage.getItem(FLOAT_KEY)
          if (raw === null) return null
          const parsed = JSON.parse(raw)
          const box = {
            left: Number(parsed?.left), top: Number(parsed?.top),
            width: Number(parsed?.width), height: Number(parsed?.height),
          }
          if (!Object.values(box).every((n) => Number.isFinite(n))) return null
          return floatClamp(box)
        } catch { return null }
      }

      function saveFloatBox(box) {
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(FLOAT_KEY, JSON.stringify(box))
        } catch { /* a host that blocks storage only loses the position */ }
      }

      /**
       * Show or hide the floating window. Every host reads one store, so there is
       * one view kind: the window shows the LIST, and the kind the container was
       * on is remembered and put back when the window is docked again.
       */
      function setFloat(on) {
        if (on === app.float) return
        if (on) {
          const was = app.view
          setApp({
            float: true, fullscreen: false, view: 'list',
            // The window has no search box, so a query typed in the panel would
            // filter it invisibly, with nothing in the window to clear it with.
            // Opening the window therefore starts from the unfiltered list.
            query: '',
            viewBeforeFloat: was === 'list' ? null : was,
          })
          if (was !== 'list') refresh({ view: 'list' }, true)
        } else {
          const back = app.viewBeforeFloat ?? 'list'
          setApp({ float: false, view: back, viewBeforeFloat: null })
          if (back !== 'list') refresh({ view: back }, true)
        }
      }

      // ---------------------------------------------------------------------
      // asking the user something
      //
      // Never window.confirm / window.prompt. A host may block those outright --
      // which is exactly why "新建清单" appeared to do nothing -- and even where
      // they work they cannot say what is about to be lost, cannot be styled, and
      // cannot be reached from the fullscreen host. Everything goes through the
      // shared store instead, and is drawn by the overlay seat.
      // ---------------------------------------------------------------------

      function askConfirm(spec) {
        return new Promise((resolve) => { setApp({ confirm: { ...spec, resolve } }) })
      }

      function settleConfirm(answer) {
        const request = app.confirm
        setApp({ confirm: null })
        if (request !== null && request !== undefined) request.resolve(answer === true)
      }

      /** Move to trash, or permanently purge when already in the recycle bin. */
      async function askDelete(id, title) {
        const inTrash = app.filter === 'trash'
        const inArchive = app.filter === 'archive'
        const yes = await askConfirm({
          title: inTrash ? '永久清除任务' : '移入回收站',
          body: inTrash
            ? `「${title}」和它的回收站子任务将被永久清除，无法恢复。`
            : `「${title}」${inArchive ? '' : '和它的子任务'}将移入回收站，可随时恢复；是否自动清除取决于回收站设置。`,
          ok: inTrash ? '永久清除' : '移入回收站',
          danger: inTrash,
        })
        if (!yes) return
        if (inTrash) await mutate('purge', { id })
        else await mutate('remove', { id, ...(inArchive ? { source: 'archive' } : {}) })
      }

      async function restoreTask(id, source) {
        const result = await mutate('restore', { id, ...(source ? { source } : {}) })
        if (result !== null) toast('任务已恢复')
        return result
      }

      async function archiveTask(id) {
        const result = await mutate('archive', { id })
        if (result !== null) toast('任务已归档，可在「已归档」中恢复')
        return result
      }

      async function emptyRecycleBin() {
        const count = Number(app.data?.counts?.trash ?? 0)
        if (count <= 0) return
        const yes = await askConfirm({
          title: '清空回收站',
          body: `将永久清除回收站中的 ${count} 组任务，无法恢复。`,
          ok: '清空回收站',
          danger: true,
        })
        if (yes) await mutate('emptyTrash', {})
      }

      /**
       * Delete a LIST. Its tasks are never deleted -- they move to the inbox --
       * so the confirmation says exactly how many will be moved, and the view
       * filter is dropped when it pointed at the list that is going away.
       */
      async function askDeleteList(list) {
        const entry = (app.data?.counts?.byList ?? []).find((b) => b.id === list.id)
        const total = Number(entry?.total ?? 0)
        const open = Number(entry?.open ?? 0)
        const yes = await askConfirm({
          title: '删除清单',
          body: total > 0
            ? `「${list.name}」里的 ${total} 个任务（${open} 个未完成）会移到「收集箱」，清单本身被删除。这一步无法撤销。`
            : `「${list.name}」里没有任务。清单会被删除，这一步无法撤销。`,
          ok: '删除清单',
          danger: true,
        })
        if (!yes) return
        // Two pieces of UI state point at the doomed id: the open editor and the
        // rail's active filter. Left alone, the second one filters the view by a
        // list that no longer exists and the user sees an empty page.
        if (app.listEditor === list.id) setApp({ listEditor: null })
        if (app.listId === list.id) setApp({ listId: null })
        const result = await mutate('removeList', { id: list.id })
        if (result !== null && result !== undefined) {
          toast(`已删除清单「${list.name}」`
            + (result.moved > 0 ? `，${result.moved} 个任务已移到「${result.movedToName ?? '收集箱'}」` : ''))
        }
      }

      /**
       * Put a list at an absolute position. Position is what a drag expresses and
       * what the order buttons express, so both go through this one call.
       *
       * Reads the shared store rather than a component's props because the editor
       * lives in the overlay seat while the rail lives in the panel seat.
       */
      async function moveListTo(id, index) {
        const ordered = (app.data?.lists ?? []).map((l) => l.id)
        const from = ordered.indexOf(id)
        if (from < 0) return null
        if (index < 0 || index > ordered.length - 1 || index === from) return null
        return mutate('moveList', { id, index })
      }

      // ---------------------------------------------------------------------
      // backup
      //
      // Export writes a real file through a blob URL; import reads one back
      // through a file input. Both go through the host so the file that is read
      // and written is the same file the store is using -- a browser download
      // path cannot know where that is.
      // ---------------------------------------------------------------------

      function downloadBlob(name, blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 4000)
      }

      function downloadJson(name, text) {
        downloadBlob(name, new Blob([text], { type: 'application/json' }))
      }

      async function downloadPlanWorkbook({ moduleId, month, owner }) {
        const params = new URLSearchParams({ module: moduleId, month, owner })
        const res = await fetch(`${API}/plan-sheet?${params.toString()}`)
        if (!res.ok) {
          let message = `HTTP ${res.status}`
          try { message = (await res.json())?.error ?? message } catch { /* not a JSON error response */ }
          throw new Error(message)
        }
        const blob = await res.blob()
        const fallbackOwner = String(owner ?? '').trim().replace(/[\\/:*?\"<>|]/g, '-').replace(/[\u0000-\u001f]/g, '-').slice(0, 40)
        let filename = `月度计划表-${fallbackOwner ? `${fallbackOwner}-` : ''}${month}.xlsx`
        const header = res.headers?.get?.('content-disposition') ?? ''
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)
        if (encoded !== null) {
          try { filename = decodeURIComponent(encoded[1].trim()) } catch { /* use a safe local fallback */ }
        }
        downloadBlob(filename, blob)
        return filename
      }

      async function exportBackup() {
        const doc = await call('exportDocument', {})
        if (doc === null || typeof doc !== 'object') return
        const stamp = String(doc.document?.meta?.updatedAt ?? '').slice(0, 10) || todayStr()
        downloadJson(`todo-backup-${stamp}.json`, JSON.stringify(doc.document, null, 2))
        toast(`已导出待办备份（${(doc.document?.tasks ?? []).length} 个任务）`)
      }

      async function importBackup(file) {
        const text = await file.text()
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch (e) {
          setApp({ error: `备份文件不是合法 JSON：${String(e?.message ?? e)}` })
          return
        }
        const yes = await askConfirm({
          title: '导入备份',
          body: `将用「${file.name}」里的 ${(parsed?.tasks ?? []).length} 个任务替换当前全部数据，`
            + '当前数据会先自动备份到同目录。',
          ok: '导入并覆盖',
          danger: true,
        })
        if (!yes) return
        const result = await mutate('importDocument', { document: parsed })
        if (result !== null && result !== undefined) {
          toast(`已导入 ${result.tasks ?? 0} 个任务 · ${result.lists ?? 0} 个清单`)
        }
      }

      /** Write to the browser clipboard; a denied or missing API is a normal failure. */
      async function writeClipboard(text) {
        try {
          const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard
          if (typeof clipboard?.writeText !== 'function') return false
          await clipboard.writeText(text)
          return true
        } catch {
          return false
        }
      }

      async function copyText(text) {
        const copied = await writeClipboard(text)
        toast(copied ? '已复制' : '复制失败，请手动选中复制')
        return copied
      }

      let searchTimer = null
      function reloadSoon(ms = 180) {
        if (searchTimer !== null) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => { searchTimer = null; refresh({}, true) }, ms)
      }

      function toast(text) {
        setApp({ toast: text })
        setTimeout(() => { if (app.toast === text) setApp({ toast: null }) }, 2600)
      }

      async function chooseFeishuConflict(conflict, change, direction) {
        const operation = conflict.operation ?? 'field'
        const field = operation === 'field' ? String(change?.field ?? '') : '__delete__'
        const requestKey = `${conflict.key}:${field}`
        const previous = app.feishuSync ?? state.feishuSync ?? {}
        setApp({ feishuSync: { ...previous, busy: true, resolving: requestKey, error: null } })
        try {
          const expected = operation === 'field'
            ? { local: change.local, remote: change.remote }
            : { changes: conflict.changes ?? [] }
          const result = await call('feishuResolveConflict', {
            ...viewContext(),
            key: conflict.key,
            field,
            operation,
            direction,
            expected,
          })
          if (result.state !== undefined) setApp({ data: result.state })
          if (result.resolved !== true) {
            const current = app.feishuSync ?? previous
            setApp({ feishuSync: {
              ...current,
              busy: false,
              resolving: null,
              error: result.reason ?? '冲突尚未处理，请重新检查。',
            } })
            if (result.stale === true) void requestFeishuEntrySync(true).catch(() => {})
            return
          }
          toast(direction === 'local' ? '已保留本地选择' : '已采用飞书选择')
          await requestFeishuEntrySync(true)
        } catch (error) {
          recordFeishuEntryError(error)
        }
      }

      /**
       * Decide EVERY pending conflict in one direction — 「全部采用飞书」 /
       * 「全部保留本地」.
       *
       * One host call, not a loop: the host re-reads both sides once, applies
       * the same per-field decisions the individual buttons apply, and answers
       * with what it could not do. The re-check afterwards is the ordinary
       * entry pass, so the dialog always ends up showing live state rather than
       * an optimistic guess.
       */
      async function chooseAllFeishuConflicts(direction) {
        const previous = app.feishuSync ?? {}
        const conflicts = Array.isArray(previous.conflicts) ? previous.conflicts : []
        if (conflicts.length === 0) return
        setApp({ feishuSync: { ...previous, busy: true, resolving: '__all__', error: null } })
        const label = direction === 'local' ? '保留本地' : '采用飞书'
        // The displayed conflicts ride along so the host can refuse a stale
        // dialog: the same guarantee the per-field buttons give, one level up.
        const shown = conflicts.map((conflict) => ({
          key: conflict.key,
          operation: conflict.operation ?? 'field',
          title: conflict.title ?? '',
          changes: (conflict.changes ?? []).map((change) => ({
            field: change.field,
            local: String(change.local ?? ''),
            remote: String(change.remote ?? ''),
          })),
        }))
        try {
          const result = await call('feishuResolveAllConflicts', { ...viewContext(), direction, conflicts: shown })
          if (result.state !== undefined) setApp({ data: result.state })
          const resolved = Number(result.resolved) || 0
          const failed = Array.isArray(result.failed) ? result.failed : []
          toast(failed.length === 0
            ? `已全部${label}：处理 ${resolved} 项`
            : `已全部${label}：处理 ${resolved} 项，${failed.length} 项未处理`)
          try { await requestFeishuEntrySync(true) } catch { /* recorded by the caller below */ }
          if (failed.length > 0) {
            const current = app.feishuSync ?? {}
            setApp({ feishuSync: {
              ...current,
              resolving: null,
              error: `${failed.length} 项冲突未能处理：${failed[0].reason ?? '需要逐项处理'}`,
            } })
          }
        } catch (error) {
          recordFeishuEntryError(error)
        }
      }

      /** Build a task-scoped, read-only-by-default API for registered menu actions. */
      function taskActionApiFor(task) {
        const taskId = task.id
        const currentSettings = app.data?.settings ?? {}
        const settings = Object.freeze({
          appearance: currentSettings.appearance ?? 'flat',
          weekStart: currentSettings.weekStart ?? 1,
          defaultList: currentSettings.defaultList ?? '收集箱',
          badgeCount: currentSettings.badgeCount ?? 'today',
        })
        const allowedUpdateFields = new Set(['title', 'note', 'due', 'start', 'priority', 'tags'])
        const mutateTask = async (method, args) => {
          const result = await mutate(method, args)
          if (result === null || typeof result !== 'object') return null
          for (const key of ['task', 'moved', 'updated', 'created']) {
            const changedTask = result[key]
            if (changedTask !== null && typeof changedTask === 'object' && !Array.isArray(changedTask)) {
              // Host mutations also return the full view state. Do not leak that
              // payload (other tasks, lists or paths) through the extension ABI.
              return copyTaskSnapshot(changedTask)
            }
          }
          return null
        }
        return Object.freeze({
          refresh: () => refresh({}, true),
          settings,
          mutate: (method, args = {}) => {
            if (args === null || typeof args !== 'object' || Array.isArray(args)) {
              throw new TypeError('task action mutate args must be an object')
            }
            if (method === 'toggle') return mutateTask('toggle', { id: taskId })
            if (method === 'move') {
              if (typeof args.listId !== 'string' || args.listId === '') throw new TypeError('move requires listId')
              return mutateTask('move', {
                id: taskId,
                listId: args.listId,
                index: Number.isFinite(args.index) ? args.index : 0,
              })
            }
            if (method === 'update') {
              const fields = {}
              for (const key of allowedUpdateFields) {
                if (Object.prototype.hasOwnProperty.call(args, key)) fields[key] = args[key]
              }
              if (Object.keys(fields).length === 0) throw new TypeError('update requires an allowed task field')
              return mutateTask('update', { ...fields, id: taskId })
            }
            if (method === 'addSubtask') {
              if (typeof args.title !== 'string' || args.title.trim() === '') throw new TypeError('addSubtask requires title')
              return mutateTask('addSubtask', { parentId: taskId, title: args.title })
            }
            throw new Error(`task action mutation is not allowed: ${String(method)}`)
          },
        })
      }

      // ---------------------------------------------------------------------
      // the capture draft (one input, three seats)
      // ---------------------------------------------------------------------

      /**
       * Where focus should go back to when a layer closes.
       *
       * Not in the app store: it is a DOM node, and the store is spread into
       * render props where a node would be compared, cloned and logged. It is
       * also not state -- nothing re-renders because it changed.
       */
      let returnFocus = null

      function rememberFocus() {
        returnFocus = typeof document === 'undefined' ? null : (document.activeElement ?? null)
      }

      function restoreFocus() {
        const node = returnFocus
        returnFocus = null
        if (node === null || node === undefined) return
        if (typeof node.focus !== 'function') return
        try { node.focus({ preventScroll: true }) } catch { /* the node is gone */ }
      }

      function openCapture() {
        // A destructive question outranks a capture box: answering "delete this
        // list?" must not be interrupted by a layer that opens on top of it.
        if (app.confirm !== null) return
        rememberFocus()
        setApp({ capture: true, cmdk: false, quickFocus: 'overlay' })
      }

      function closeCapture() {
        setApp({ capture: false })
        restoreFocus()
      }

      function openCommandPalette() {
        rememberFocus()
        setApp({ cmdk: true, capture: false })
      }

      function closeCommandPalette() {
        setApp({ cmdk: false })
        restoreFocus()
      }

      /** Modifier state, for the one place a hotkey string is compared. */
      function hotkeyMatches(event, spec) {
        const parts = String(spec ?? '').split('+').map((p) => p.trim().toLowerCase()).filter((p) => p !== '')
        if (parts.length < 2) return false
        const key = parts[parts.length - 1]
        const mods = parts.slice(0, -1)
        if (String(event.key ?? '').toLowerCase() !== key) return false
        if (mods.includes('shift') !== (event.shiftKey === true)) return false
        if (mods.includes('alt') !== (event.altKey === true)) return false
        const wantsCtrl = mods.includes('ctrl')
        // Ctrl and Cmd are the same key to the user, so either satisfies either.
        return wantsCtrl === (event.ctrlKey === true || event.metaKey === true)
      }

      /**
       * Is this event aimed at something the user is typing into?
       *
       * The host's chat box is a Lexical `contenteditable`, and stealing a key
       * from it is the one failure a global shortcut must never have. The check
       * mirrors what Lexical itself does before it handles a key.
       */
      function isEditableTarget(target) {
        if (target === null || target === undefined) return false
        if (typeof target.closest === 'function' && target.closest('[contenteditable="true"]') !== null) return true
        if (target.isContentEditable === true) return true
        const tag = String(target.tagName ?? '').toUpperCase()
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      }

      /** Would this event insert text? Used to ignore keys while an IME composes. */
      function isComposingEvent(event) {
        return event.isComposing === true || event.keyCode === 229
      }

      /**
       * The one capture input.
       *
       * `mode` says which seat is drawing it -- panel, floating window, or the
       * global layer -- and the only things it changes are the placeholder (the
       * layer has no header to explain itself) and what Esc does when the draft
       * is empty (the layer closes; a docked bar has nowhere to go).
       */
      function CaptureBar(props) {
        const state = useApp()
        const mode = props.mode ?? 'panel'
        const inputRef = useRef(null)

        // A focus request is one-shot and addressed to ONE seat: consume it and
        // clear it, so two mounted seats cannot fight over the caret.
        useEffect(() => {
          if (state.quickFocus !== mode) return
          setApp({ quickFocus: null })
          const node = inputRef.current
          if (node !== null && typeof node.focus === 'function') {
            try { node.focus({ preventScroll: true }) } catch { /* not focusable yet */ }
          }
        }, [state.quickFocus, mode])

        const preview = state.qPreview
        const current = preview !== null && preview !== undefined && preview.text === String(state.quick ?? '').trim()
          ? preview.result
          : null
        const shown = current !== null && current !== undefined && current.empty !== true ? current : null
        const plan = shown?.plan ?? null
        const parsed = shown?.parsed ?? null
        const bits = []
        if (parsed !== null && parsed !== undefined) {
          if (parsed.priority > 0) bits.push(`优先级${PRIORITY_LABELS[parsed.priority] ?? parsed.priority}`)
          if (parsed.due) bits.push(fmtDue(parsed.due, app.data?.today ?? todayStr()))
          if (parsed.recurrence) bits.push(recurrenceRuleText(parsed.recurrence))
          const tags = Array.isArray(parsed.tags) ? parsed.tags : []
          if (tags.length) bits.push(tags.map((x) => `#${x}`).join(' '))
        }
        const listName = plan?.listName ?? shown?.listName ?? null
        const listExists = plan?.listExists ?? shown?.listExists ?? true

        return h('div', { className: 'td-qadd' + (mode === 'float' ? ' td-qadd-float' : '') },
          h('input', {
            ref: inputRef,
            className: 'td-in',
            value: state.quick,
            // The layer is mounted on demand, so autoFocus is exactly right for
            // it; the docked bar is not, and takes the one-shot quickFocus
            // request instead (see the effect above).
            autoFocus: mode === 'overlay',
            'aria-label': '添加任务',
            // The full syntax lives in the tooltip: a placeholder long enough to
            // teach it is also long enough to be cut off in a 214px rail.
            title: '语法：日期/时间、!高/!中/!低、#清单、@标签、重复规则（如 每周一三五）',
            placeholder: mode === 'overlay' ? '记一件事：明天 15:00 交报告 !高 #工作' : '添加任务（回车确认）',
            onChange: (event) => setApp({ quick: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                stopEvent(event)
                submitCapture(mode)
              }
              if (event.key === 'Escape') {
                // Both: this key is consumed HERE. Without it the same Escape
                // also reached the overlay's chain and left fullscreen behind
                // the capture bar -- one keypress, two layers.
                stopEvent(event)
                escapeCapture(mode)
              }
            },
          }),
          h('button', {
            type: 'button', className: 'td-send', title: '添加任务（回车）',
            'aria-label': '添加任务', onClick: () => submitCapture(mode),
          }, h(Glyph, { name: 'send', size: 15 })),
          h('button', {
            type: 'button', className: 'td-icon', title: '重新载入',
            'aria-label': '重新载入', onClick: () => refresh({}, true),
          }, h(Glyph, { name: 'refresh', size: 14 })),
          // The preview's slot is ALWAYS in the DOM, at a fixed height: it used
          // to be a sibling that mounted on demand, so the first character typed
          // moved the whole list down by its height. Only its visibility changes
          // now, which is why the list cannot jump.
          h('div', {
            className: `td-qprev${shown === null ? '' : ' on'}`,
            'aria-live': 'polite',
            'aria-hidden': shown === null ? 'true' : 'false',
          },
            h('span', { className: 'td-qprev-l' }, current?.added === true ? '已添加：' : '将添加：'),
            h('span', { className: 'td-qprev-t' },
              shown === null || parsed === null ? '' : (parsed.title === '' ? '（无标题）' : parsed.title)),
            ...bits.map((bit, i) => h('span', { key: `b${i}`, className: 'td-qprev-m' }, bit)),
            listName === null || shown === null
              ? null
              : h('span', {
                className: `td-qprev-m${listExists ? '' : ' new'}`,
                title: listExists ? '任务会放进这个清单' : '这个清单还不存在，回车时会自动创建',
              }, `${listExists ? '清单' : '新建清单'}「${listName}」`)))
      }

      /** preventDefault + stopPropagation, when the event can do either. */
      function stopEvent(event) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
      }

      /** Enter: hand the draft to the host, then stay put for the next one. */
      async function submitCapture(mode) {
        const text = String(app.quick ?? '').trim()
        if (text === '') return
        const result = await mutate('quickAdd', { text })
        if (result === null) return
        const parsed = result.parsed ?? {}
        setApp({
          quick: '',
          // The answer stays on screen until the next keystroke: it is the only
          // confirmation that the date the parser found is the date you meant.
          qPreview: {
            text,
            result: {
              parsed,
              added: true,
              listName: result.task?.listName ?? null,
              listExists: true,
            },
          },
        })
        if (mode === 'overlay') closeCapture()
        const bits = []
        if (result.task.due) bits.push(`截止 ${String(result.task.due).replace('T', ' ')}`)
        if (result.parsed?.recurrence) bits.push(recurrenceRuleText(result.parsed.recurrence))
        if (result.listCreated) bits.push(`已创建清单「${result.parsed.listName}」`)
        toast(`已添加「${result.task.title}」${bits.length ? ' · ' + bits.join(' · ') : ''}`)
      }

      /**
       * Escape inside the capture input: throw the draft away first, and only
       * close a layer when there was nothing to throw away. One keypress, one
       * meaning -- the caret stays in the box either way.
       */
      function escapeCapture(mode) {
        const hadDraft = String(app.quick ?? '').trim() !== ''
        setApp({ quick: '', qPreview: null })
        if (!hadDraft && mode === 'overlay') closeCapture()
      }

      /** Seed the draft from a group/column, without ever eating what is typed. */
      function seedQuick(text) {
        const current = String(app.quick ?? '')
        if (current.trim() === '') {
          setApp({ quick: text })
          return false
        }
        if (current.trim() === text.trim()) return false
        setApp({ quick: `${current.replace(/\s+$/, '')} ${text}` })
        return true
      }

      /**
       * The inline add row: one input, born inside the group or column that was
       * clicked.
       *
       * The seed -- which bucket, which list -- arrives with the payload, so the
       * browser never has to know that "本周内" means `today + 7`; that decision
       * lives in the store, with every other view semantic. A `due` key that is
       * absent means "no opinion" (the task keeps the create default), which is
       * different from the 未安排 group's explicit `due: null`.
       */
      function InlineAdd(props) {
        const [text, setText] = useState('')
        const seed = props.seed ?? {}
        const hasDue = Object.prototype.hasOwnProperty.call(seed, 'due')
        const submit = async () => {
          const value = text.trim()
          if (value === '') { props.onClose(); return }
          const payload = { text: value }
          if (hasDue) payload.due = seed.due
          if (seed.listId !== undefined && seed.listId !== null) payload.listId = seed.listId
          const result = await mutate('quickAdd', payload)
          if (result === null) return
          // The box stays open and empty: "记三件事" is one thought, and closing
          // it after each line would make the second one cost two more clicks.
          setText('')
          if (typeof props.onAdded === 'function') props.onAdded(result)
        }
        return h('div', { className: props.className ?? 'td-grp-new' },
          h('input', {
            className: 'td-in',
            autoFocus: true,
            value: text,
            'aria-label': props.label ?? '添加任务',
            title: '语法：日期/时间、!高/!中/!低、#清单、@标签',
            placeholder: props.placeholder ?? '回车添加，Esc 取消',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { stopEvent(event); submit() }
              if (event.key === 'Escape') { stopEvent(event); props.onClose() }
            },
          }),
          h('button', {
            type: 'button', className: 'td-send', title: '添加任务（回车）',
            'aria-label': '添加任务', onClick: submit,
          }, h(Glyph, { name: 'send', size: 15 })))
      }

      // ---------------------------------------------------------------------
      // styles
      // ---------------------------------------------------------------------

      // The palette is the host's own theme tokens, so the plugin tracks light/dark
      // and any future re-skin without a second design system to keep in sync.
      const CSS = `
/* The palette is the host's own theme tokens, so the plugin tracks light/dark and
   any future re-skin with no second design system to keep in sync. The local
   --td-* names below are aliases rather than a palette: every value still comes
   from the host, and the aliases let a rule say "a raised card" instead of
   repeating which of four near-identical layer tokens that happens to be today.

   They are declared on the seat marker, .td-seat, which every element the plugin
   hands to a host slot carries -- because those elements are SIBLINGS in the slot
   tree, not ancestors: the shell renders each shell.overlay entry side by side, and
   the sidebar's panel row is not inside the panel at all. A custom property is
   inherited, so a variable set only on .td-root simply does not exist inside the
   dialog, the capture layer, the command palette, or the sidebar badge -- and the
   failure is silent: every var(--td-*) there resolves to nothing, so the box paints
   with no surface at all.

   That trap has been sprung three times (.td-float in the v2 pass, then
   .td-cap-layer/.td-cmdk-layer and the sidebar badge, then the box model, the type
   baseline and the focus ring below, all found in the t12 repair). Every earlier fix
   was a longer selector list, and every longer list had one more rule to remember.
   The marker is the structural answer: a surface either carries it -- and gets the
   map, the box model, the baseline type and the focus ring at once -- or it does not
   exist yet. scripts/audit-css.mjs asserts the COVERAGE RELATION (which elements
   carry the marker, derived from the JSX) rather than a copy of any selector text,
   so a new surface that forgets the marker fails the gate instead of shipping
   invisible.

   v3: the ladder is DECLARED ONCE here and both themes move in the SAME
   direction -- the canvas is pulled down from the row, the well sits BETWEEN the
   canvas and the row, and a control sits below the surface it lives on. (The old
   sheet mixed the canvas down in the light theme and the row down in the dark one
   -- and then borrowed the host's layer-2 for the
   well in the dark theme, which put the well ABOVE the row and flipped the
   container/row relationship instead.) The direction is
   asserted per theme, not just the step sizes. All four steps stay derived from
   host tokens. */
.td-seat{
  font-size:12.5px;line-height:1.6;-webkit-font-smoothing:antialiased;
  /* ---------------------------------------------------------------------
     v5 — the gallery-blue refresh, after the dsh-style-gallery plugin's OWN
     interface (not just its written rules).

     The v4 pass read the gallery as "monochrome ink", but the gallery's real
     UI carries one calm blue (#3b82f6): its primary buttons, its selected
     chips, its tab underline. This sheet takes that hue as the plugin's single
     accent, and keeps everything the gallery does quietly:
       * FLAT, SOFT SURFACES — a 1px hairline or a faint grey wash; depth from
         the surface ladder plus at most one low blur, never stacked rings.
       * ONE BLUE — --td-accent is the only hue the chrome spends, and it buys
         exactly three things: primary actions, selection, and focus. Status
         keeps its own colours (green done, red late, amber today), the lists
         keep theirs, and the rest of the UI is ink at three steps.
       * QUIET WASHES — hover still reads as an ink wash (color-mix ink into
         transparent), so it shows on a card, a well and the canvas alike.
       * GENTLE LABELS — section eyebrows are soft sans, not uppercase mono;
         the mono face stays where it earns its keep (numbers, paths, kbd).
       * GENEROUS RHYTHM — 8/12/16 steps for gaps, 6/8/12 for padding, and the
         small type ladder; a control is never taller than it needs to be.

     Surfaces and ink still come from the host theme (light/dark and any
     re-skin track for free); the accent is the one declared hue.             */
  --td-card:var(--dsw-alias-bg-base);
  /* A faint blue canvas, a pale-blue well, and a near-white input surface.
     The surfaces differ by both value and hue rather than three grays; the
     order remains measurable in both themes (canvas < soft < card). */
  --td-canvas:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,var(--td-accent));
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,var(--td-accent));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-base) 97%,var(--td-accent));
  /* Interaction washes are a separate idea from the surface ladder: a hover has
     to show up ON whatever it lands on, including a card, a well and the canvas.
     Mixing ink into transparent is the only value that does that in any theme, so
     the two states below are deliberately NOT surface tokens. */
  --td-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);
  --td-hover-2:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);
  /* Three ink steps, and the third one is only legible on a card or on an inset
     surface (5.30 / 4.69 in the light theme). On the canvas it drops below 4.5,
     so the three rules that print small text there take --td-text-2 instead --
     that pairing is enforced by the visual-contract assertions. */
  --td-text:var(--dsw-alias-label-primary);
  --td-text-2:var(--dsw-alias-label-secondary);
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 96%,var(--dsw-alias-bg-base));
  /* Hairlines: 10% is a row/card boundary, 20% is a group or section boundary,
     so the boundary the eye is meant to read first is the stronger one (D19).
     Both sit a touch lighter than v4: the edge should hold the layout together,
     not draw a grid over it. */
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);
  /* The host's brand token stays mapped (the sidebar glyph and the calendar's
     no-colour fallback still reach for it), but the chrome's emphasis is the
     gallery blue below -- one calm hue for primary / selection / focus. */
  --td-brand:var(--dsw-alias-brand-primary);
  --td-danger:var(--dsw-alias-state-error-primary);
  --td-warn:var(--dsw-alias-state-warn-primary);
  /* Semantic editorial inks and the modal-mask colour cannot be derived from
     the host's grayscale tokens. Floating surfaces deliberately use the active
     appearance map instead of introducing a third palette. */
  --td-cream:#fffaf1;--td-cream-2:#f6eedd;
  --td-accent:#3b82f6;--td-accent-on:#fff;--td-ink:#16233a;--td-ink-2:#4d6076;
  /* A small semantic palette for the smart filters: blue=today/all,
     teal=upcoming, violet=inbox, red=overdue, green=done. These hues only tint
     their own tiny marker/count; task bars continue to identify their list. */
  --td-teal:#22a89a;--td-violet:#7c5cf0;
  /* The status and priority hues are the remaining literal semantic colours:
     their hue cannot be derived from a greyscale theme, and each is mixed into
     a surface. The gallery blue and its white on-colour are the one brand pair. */
  --td-ok:color-mix(in srgb,#1f9d61 88%,var(--dsw-alias-brand-primary));
  --td-warm:#e56d24;
  --td-pri-1:#8b97a6;--td-pri-2:#e0a53c;
  /* The radius ladder, one step tighter than v3 and matching the gallery's set:
     modal 12 / card 10 / control 6 / chip 999. Nothing in the sheet may invent a
     radius outside this list. */
  --td-r-xl:22px;--td-r-lg:12px;--td-r-md:10px;--td-r-sm:6px;
  /* Hairline first, blur second, and only one blur in the whole ladder: v3's
     sh-1/sh-2 carried a ring AND a blur, which double-drew every border the rules
     already declare. A ring that replaces a border is now --td-line itself.
     The blurs are a shade softer than v4: the gallery's cards float on one quiet
     shadow, they are not pinned to the page. */
  --td-sh-hair:0 0 0 1px var(--td-line);
  --td-sh-1:0 1px 2px rgba(16,24,40,.05);
  --td-sh-2:0 6px 20px rgba(16,24,40,.09);
  --td-sh-3:0 14px 44px rgba(16,24,40,.16);
  --td-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --td-ease:cubic-bezier(.23,1,.32,1)}
/* The dark theme is read from the host's signal on <body>. The well is derived
   rather than borrowed: the host layers stack upward (base < layer-1 < layer-2),
   so --td-soft is mixed from the row layer towards the canvas. The resulting
   canvas < soft < field < card ramp is asserted per theme. Every marked surface,
   including both parts of the floating window, gets this map; the saved appearance
   rules below refine flat, editorial and playful in either theme. */
body[data-ds-dark-theme] .td-seat{
  --td-canvas:var(--dsw-alias-bg-base);
  --td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
/* In the dark theme the canvas IS the host's own page colour, so the plugin area
   would have no edge at all; one inset hairline gives it one without adding a
   third surface. The overlay is skipped because it covers the page instead of
   sitting beside it. */
body[data-ds-dark-theme] .td-root:not(.td-overlay):not(.td-floatapp){
  box-shadow:inset 1px 0 0 var(--td-line-2)}
/* The panel's own box: layout only. The type baseline moved onto the marker (just
   above), because it is a property of every surface, not of this one -- the dialog
   layers had none, so they fell back to the host's line-height. */
.td-root{height:100%;min-height:0;display:flex;flex-direction:column;
  container:td / inline-size;
  background:var(--td-canvas);color:var(--td-text);
  overflow:hidden;position:relative}
.td-root.td-overlay{position:fixed;inset:0;z-index:9000}
/* Box model and focus ring are surface-wide too, so they hang on the marker: this
   is the half of the t12 defect a token-only fix would have left behind (the
   capture layer's and the palette's padding+border were laid out content-box, and
   the palette's rows fell back to the browser's own focus ring). */
.td-seat *{box-sizing:border-box}
.td-seat :focus-visible{outline:2px solid var(--td-text);
  outline-offset:2px}
.td-grow{flex:1;min-width:0}

/* ---- header ------------------------------------------------------------ */
.td-head{flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;height:56px;
  border-bottom:1px solid var(--td-line);background:var(--td-card);z-index:3}
.td-h1{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.td-countbadge{min-width:24px;height:22px;padding:0 8px;border-radius:999px;flex:none;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-field);
  color:var(--td-text-2);font-family:var(--td-mono);font-size:12.5px;font-weight:600;
  font-variant-numeric:tabular-nums}
.td-sub{color:var(--td-text-2);font-size:12.5px;font-family:var(--td-mono);
  font-variant-numeric:tabular-nums;padding-left:12px;
  border-left:1px solid var(--td-line-2)}
.td-sub b{color:var(--td-text);font-weight:600}
.td-headtools{display:flex;align-items:center;gap:8px;flex:none}
/* The rail carries the view switcher. Below this width it is simply gone, so the
   header keeps its own copy of the same four buttons and drops the metadata.
   The descendant selector is deliberate: .td-seg sets display:flex further down
   the sheet, and an equal-specificity rule cannot win against a later one. */
.td-headtools .td-headviews{display:none}
/* The narrow tier's second header line: the smart lists and the list switcher,
   which the dropped rail used to carry. It is hidden at every wider width (where
   the rail is right there), so the wide layouts pay nothing for it. */
.td-head2{display:none}
.td-head2-tabs{display:flex;overflow-x:auto;scrollbar-width:none}
.td-head2-tabs::-webkit-scrollbar{display:none}
.td-head2-tab{flex:none;border:0;background:transparent;color:var(--td-text-2);
  padding:4px 8px;border-radius:var(--td-r-sm);font-size:12.5px;font-family:inherit;
  cursor:pointer;transition:background-color .15s ease,color .15s ease}
.td-head2-tab:hover{color:var(--td-text)}
.td-head2-tab.on{background:color-mix(in srgb,var(--td-smart-accent,var(--td-accent)) 14%,var(--td-card));
  color:var(--td-text);font-weight:600}
.td-head2-sel{flex:1;min-width:0;height:28px;border-radius:var(--td-r-sm);font-size:12.5px}

/* ---- controls ----------------------------------------------------------
   v4: a control is a hairline box on whatever it sits on, not a filled tile.
   The gallery's button is transparent with a 1px border; hover is a grey wash and
   focus is the border changing colour. That is the whole state set -- no rings,
   no scale transforms, one transition duration (.15s) for the three properties
   that actually move.
   v5: the emphasis a state needs is spent in the accent blue -- a primary button
   is a blue fill, a chosen cell a blue tint -- instead of the heavy ink fills
   v4 used, which read as black holes next to the quiet greys around them. */
.td-btn{min-height:36px;border:1px solid var(--td-line-2);background:transparent;color:var(--td-text);
  border-radius:var(--td-r-sm);padding:6px 12px;cursor:pointer;font-size:12.5px;
  font-family:inherit;line-height:1.5;white-space:nowrap;display:inline-flex;
  align-items:center;justify-content:center;gap:4px;
  transition:background-color .15s ease,border-color .15s ease,color .15s ease}
.td-btn:hover{background:var(--td-hover);border-color:var(--td-text-3)}
.td-btn:active{background:var(--td-hover-2)}
.td-btn.primary{background:var(--td-accent);border-color:var(--td-accent);color:var(--td-accent-on);
  font-weight:600}
.td-btn.primary:hover{background:var(--td-accent);border-color:var(--td-accent);opacity:.9}
.td-btn.ghost{border-color:transparent;background:transparent;color:var(--td-text-2)}
.td-btn.ghost:hover{background:var(--td-hover);color:var(--td-text)}
/* "Chosen" is a blue tint with the ink kept for the label: the tint + weight
   carry the state, and the text stays AA on it in BOTH themes (a mixed-blue
   label dips under 4.5 in the dark theme). */
.td-btn.on{background:color-mix(in srgb,var(--td-accent) 12%,var(--td-card));
  border-color:color-mix(in srgb,var(--td-accent) 35%,transparent);
  color:var(--td-text);font-weight:600}
.td-btn.sm{min-height:32px;padding:4px 8px;font-size:12.5px;border-radius:var(--td-r-sm)}
.td-btn.danger{color:var(--td-danger);border-color:transparent;background:transparent}
.td-btn.danger:hover{background:color-mix(in srgb,var(--td-danger) 10%,transparent);
  border-color:color-mix(in srgb,var(--td-danger) 35%,transparent);color:var(--td-danger)}
/* Filled, for the one button that destroys: the ghost treatment reads as "cancel"
   next to the confirm it is meant to be the opposite of. */
.td-btn.danger-solid{background:var(--td-danger);border-color:var(--td-danger);
  color:var(--td-card);font-weight:600}
.td-btn.danger-solid:hover{background:var(--td-danger);opacity:.92}
.td-btn.icon{width:32px;height:32px;min-height:32px;padding:0;display:inline-flex;align-items:center;
  justify-content:center;line-height:0}
.td-icon{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;
  border:0;border-radius:var(--td-r-sm);background:transparent;color:var(--td-text-3);
  cursor:pointer;font-size:14px;font-family:inherit;line-height:1;padding:0;
  transition:background-color .15s ease,color .15s ease}
.td-icon:hover{background:var(--td-hover);color:var(--td-text)}
/* The segmented switcher is one joined hairline box, not a row of loose buttons:
   a shared outer border with dividers between the cells is what makes 中/低/无
   read as three settings of one control instead of three separate actions. */
.td-seg{display:inline-flex;gap:4px;padding:0;border-radius:var(--td-r-sm);
  border:1px solid var(--td-line-2);overflow:hidden;background:transparent;align-items:stretch}
.td-seg > button{border:0;background:transparent;color:var(--td-text-2);
  border-radius:0;padding:4px 12px;font-size:12.5px;font-family:inherit;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px;
  transition:background-color .15s ease,color .15s ease}
.td-seg > button + button{box-shadow:inset 1px 0 0 var(--td-line-2)}
.td-seg > button:hover{background:var(--td-hover);color:var(--td-text)}
.td-seg > button.on{background:color-mix(in srgb,var(--td-accent) 12%,var(--td-card));
  color:var(--td-text);font-weight:600}
.td-in{border:1px solid var(--td-line-2);background:transparent;color:var(--td-text);
  border-radius:var(--td-r-sm);padding:6px 8px;font-size:12.5px;font-family:inherit;
  min-width:0;outline:none;
  transition:border-color .15s ease,background-color .15s ease}
.td-in::placeholder{color:var(--td-text-3)}
.td-in:hover{border-color:var(--td-text-3)}
/* Focus is the border taking the accent, the gallery's own rule -- one soft
   blue wash instead of a ring, so a focused field cannot look like a selected
   one. The wash rides on the accent at 18%, which shows on a card, on a well
   and on the canvas alike. */
.td-in:focus{border-color:var(--td-accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-accent) 18%,transparent)}
.td-search{width:180px;background:transparent;border-color:var(--td-line)}
.td-search:focus{background:transparent;border-color:var(--td-accent)}
/* One search box, two seats. The rail owns it -- it filters whatever the rail has
   selected -- and the header copy exists only for the widths where the rail is
   dropped entirely, exactly like the view switcher below. */
.td-headtools .td-headsearch{display:none}
.td-railsearch{padding:0 0 12px}
.td-railsearch .td-search{width:100%}
/* The group right under the search box opens the rail, so it does not draw the
   separator it otherwise uses to part from the group above it. */
.td-railsearch + .td-rail-g{margin-top:0;padding-top:0;border-top:0}
/* What Enter will create. Muted on purpose: it is an answer, not a control, and
   a bright row under the add box would read as a second button. It sits on the
   canvas, so its label uses ink-2, not ink-3 (4.29 < 4.5).

   v2: the slot is a CHILD of the add row and keeps its height whether or not it
   has anything to say. It used to be a sibling that mounted on demand, so the
   first character typed pushed the whole list down by its height. Reserving the
   space with visibility (not display) is what keeps it from moving. */
.td-qprev{flex:1 1 100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  min-height:20px;font-size:12.5px;color:var(--td-text-2);
  visibility:hidden;opacity:0;transition:opacity .15s ease}
.td-qprev.on{visibility:visible;opacity:1}
.td-qprev-l{color:var(--td-text-2)}
.td-qprev-t{color:var(--td-text);font-weight:600}
.td-qprev-m{color:var(--td-text-2)}
.td-qprev-m.new{color:color-mix(in srgb,var(--td-warn) 88%,var(--td-text))}
.td-qadd{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 16px;
  border-bottom:1px solid var(--td-line-2);background:var(--td-card)}
.td-qadd .td-in{flex:1;height:40px;border-radius:var(--td-r-lg);background:var(--td-soft);
  border-color:transparent;padding:0 12px}
.td-qadd .td-in:hover{border-color:var(--td-line-2)}
.td-qadd .td-in:focus{background:var(--td-card);border-color:var(--td-accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-accent) 18%,transparent)}
/* The window's bar is one row and has no header above it, so the box is a touch
   taller there; the preview still owns its own line. */
.td-qadd-float{padding:8px 12px}
.td-send{flex:none;width:40px;height:40px;border:0;border-radius:var(--td-r-lg);cursor:pointer;
  background:var(--td-accent);color:var(--td-accent-on);display:inline-flex;align-items:center;
  justify-content:center;line-height:0;
  transition:background-color .15s ease,color .15s ease,transform .15s ease}
.td-send:hover{filter:brightness(1.1)}
.td-send:active{transform:scale(.94)}

/* ---- the inline "+": one box inside the group/column that was clicked ----- */
.td-grp-add{margin-left:auto;width:24px;height:24px;border:0;background:transparent;
  color:var(--td-text-3);border-radius:var(--td-r-sm);cursor:pointer;line-height:0;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .15s ease,color .15s ease}
.td-grp-add:hover{background:var(--td-hover);color:var(--td-text)}
.td-grp-new{display:flex;gap:8px;align-items:center;margin:0 0 8px}
.td-grp-new .td-in{flex:1;height:36px;border-radius:var(--td-r-md)}
.td-col-new{display:flex;gap:8px;align-items:center;margin:0 0 12px}
.td-col-new .td-in{flex:1;height:36px;border-radius:var(--td-r-md)}

/* ---- the global capture layer ------------------------------------------- */
.td-cap-layer{position:fixed;inset:0;z-index:9150;display:flex;align-items:flex-start;
  justify-content:center;padding:12vh 16px 16px;background:color-mix(in srgb,var(--td-ink) 32%,transparent)}
.td-cap{width:100%;max-width:640px;border-radius:var(--td-r-lg);overflow:hidden;
  background:var(--td-card);box-shadow:var(--td-sh-2)}
.td-cap .td-qadd{border-bottom:0}
.td-cap-h{padding:12px 16px 0;font-size:12.5px;color:var(--td-text-2)}

/* ---- the command palette ------------------------------------------------ */
.td-cmdk-layer{position:fixed;inset:0;z-index:9150;display:flex;align-items:flex-start;
  justify-content:center;padding:12vh 16px 16px;background:color-mix(in srgb,var(--td-ink) 32%,transparent)}
.td-cmdk{width:100%;max-width:560px;border-radius:var(--td-r-lg);overflow:hidden;
  background:var(--td-card);box-shadow:var(--td-sh-2);display:flex;flex-direction:column}
.td-cmdk-in{height:44px;border:0;border-bottom:1px solid var(--td-line-2);
  border-radius:0;background:var(--td-card);font-size:14px;padding:0 16px}
.td-cmdk-in:focus{box-shadow:none;background:var(--td-card)}
.td-cmdk-list{max-height:52vh;overflow:auto;padding:8px}
.td-cmdk-item{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;
  color:var(--td-text);font-family:inherit;font-size:14px;text-align:left;cursor:pointer;
  padding:8px 12px;border-radius:var(--td-r-md);
  transition:background-color .15s ease,color .15s ease}
.td-cmdk-item.on{background:color-mix(in srgb,var(--td-accent) 12%,var(--td-card))}
.td-cmdk-lab{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.td-cmdk-hint{flex:none;color:var(--td-text-3);font-size:12.5px;
  font-variant-numeric:tabular-nums}
.td-cmdk-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 16px;border-top:1px solid var(--td-line);color:var(--td-text-2);font-size:12.5px}
.td-kbd{font-family:var(--td-mono);font-size:10.5px;padding:2px 6px;border-radius:3px;
  background:var(--td-field);color:var(--td-text-2)}

/* ---- the search box: magnifier inside, tag filter as a removable chip ----- */
.td-searchbox{position:relative;display:flex;align-items:center;gap:8px}
.td-searchbox .td-in{padding-left:28px;width:100%}
.td-search-ico{position:absolute;left:8px;top:50%;transform:translateY(-50%);
  color:var(--td-text-3);pointer-events:none;line-height:0;display:inline-flex}
/* The chip sits over the field's right edge: it belongs to the search box, not
   to a row of its own, and it must not push the field narrower. */
.td-search-tag{position:absolute;right:6px;top:50%;transform:translateY(-50%);
  display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 6px;border:0;
  border-radius:var(--td-r-sm);background:var(--td-field);color:var(--td-text);
  font-family:inherit;font-size:12.5px;cursor:pointer;line-height:0}
.td-search-tag:hover{background:var(--td-hover)}
.td-searchbox .td-search{padding-right:88px}

/* ---- rail: the foldable data block, and the tag fold -------------------- */
.td-rail-toggle{display:flex;align-items:center;gap:8px;width:100%;border:0;
  background:transparent;cursor:pointer;font-family:inherit;text-align:left;padding:0}
.td-rail-toggle:hover{color:var(--td-text-2)}
.td-rail-toggle .td-caret{display:inline-block;font-size:10.5px;color:var(--td-text-3);
  transition:transform .15s ease}
.td-rail-toggle .td-caret.open{transform:rotate(90deg)}
.td-rail-more{display:block;width:100%;border:0;background:transparent;cursor:pointer;
  color:var(--td-text-3);font-family:inherit;font-size:12.5px;text-align:left;
  padding:4px 8px;border-radius:var(--td-r-sm)}
.td-rail-more:hover{background:var(--td-hover);color:var(--td-text)}
/* The file name is a button now: clicking it copies the path, which is the one
   thing anyone wanted from the three-button row it replaced. */
.td-rail-file{border:0;background:transparent;padding:0;cursor:pointer;font-family:var(--td-mono);
  color:var(--td-text);font-size:12.5px;text-align:left}
.td-rail-file:hover{color:var(--td-accent)}

.td-hint{font-size:12.5px;color:var(--td-text-3);line-height:1.6}
.td-dot{width:8px;height:8px;border-radius:999px;flex:none}
.td-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;color:inherit}

/* ---- body + rail ------------------------------------------------------- */
.td-body{flex:1;min-height:0;display:flex}
.td-rail{width:238px;flex:none;border-right:1px solid var(--td-line-2);overflow:auto;
  padding:16px 12px 24px;background:var(--td-card)}
/* v5: eyebrows are soft sans, not uppercase mono -- an all-caps mono label is
   a lot of voice for "清单". The mono face stays for numbers, paths and kbd. */
.td-rail-t{font-size:12.5px;color:var(--td-text-2);margin:0 8px 8px;
  letter-spacing:.04em;font-weight:600}
.td-rail-g{margin-top:16px;padding-top:16px;border-top:1px solid var(--td-line-2)}
.td-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.td-scroll{flex:1;min-height:0;overflow:auto;padding:16px 24px 48px;background:var(--td-canvas)}
.td-feishu-trigger{flex:none;gap:8px;white-space:nowrap;padding-inline:8px}
.td-feishu-sync-mark{width:8px;height:8px;flex:none;border-radius:50%;background:var(--td-ok)}
.td-feishu-trigger.conflict{border-color:color-mix(in srgb,var(--td-warm) 48%,var(--td-line-2));color:var(--td-text)}
.td-feishu-trigger.conflict .td-feishu-sync-mark{background:var(--td-warm)}
.td-feishu-trigger.error{border-color:color-mix(in srgb,var(--td-danger) 48%,var(--td-line-2));color:var(--td-danger)}
.td-feishu-trigger.error .td-feishu-sync-mark,.td-feishu-sync-mark.error{background:var(--td-danger)}
.td-feishu-sync-mark.conflict{background:var(--td-warm)}
.td-feishu-sync-layer{z-index:9110}
.td-feishu-sync-dialog{width:min(980px,100%);max-height:min(88vh,900px)}
.td-feishu-sync-body{padding:16px}
.td-feishu-sync-empty{min-height:120px;display:flex;align-items:center;justify-content:center}
.td-feishu-sync-status{display:flex;align-items:center;gap:8px;min-height:42px;padding:8px 12px;
  border:1px solid var(--td-line);border-radius:var(--td-r-md);background:var(--td-card);color:var(--td-text-2);
  font-size:12.5px;line-height:1.5;overflow-wrap:anywhere}
.td-feishu-sync-status.conflict{border-color:color-mix(in srgb,var(--td-warm) 42%,var(--td-line-2))}
.td-feishu-sync-status.error{border-color:color-mix(in srgb,var(--td-danger) 42%,var(--td-line-2))}
.td-feishu-sync-status.conflict .td-feishu-sync-mark{background:var(--td-warm)}
.td-feishu-sync-status.error .td-feishu-sync-mark{background:var(--td-danger)}
.td-feishu-conflicts{margin:0;padding:0;border:0;background:transparent}
.td-feishu-conflict{padding:8px 0;border-bottom:1px solid var(--td-line)}
.td-feishu-conflict:last-child{border-bottom:0}
.td-feishu-conflict-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.td-feishu-conflict-head strong{font-size:12.5px;color:var(--td-text)}
.td-feishu-conflict-head code{font:10.5px var(--td-mono);color:var(--td-text-3)}
.td-feishu-field-conflict{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0}
.td-feishu-field-copy{min-width:0;display:grid;grid-template-columns:minmax(80px,.4fr) minmax(120px,1fr) minmax(120px,1fr);
  gap:4px 8px;font-size:12.5px;color:var(--td-text-2)}
.td-feishu-field-copy strong{grid-row:span 2;color:var(--td-text)}
.td-feishu-field-copy span{min-width:0;overflow-wrap:anywhere}
.td-feishu-field-copy small{grid-column:2/-1;color:var(--td-text-3);font-size:10.5px}
.td-feishu-choice{display:flex;flex:none;align-items:center;gap:8px}
.td-feishu-delete-change{padding:2px 0;color:var(--td-text-2);font-size:12.5px;overflow-wrap:anywhere}
.td-feishu-conflict .td-feishu-choice{padding-top:6px}
.td-feishu-choice button:disabled{opacity:.45;cursor:not-allowed}
/* The bulk decision bar: "处理全部冲突" is one row above the per-field cards, on
   its own tinted strip, so a hurried click reads a sentence before it acts. */
.td-feishu-bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 4px;
  padding:8px 12px;border-radius:var(--td-r-md);background:var(--td-soft);
  box-shadow:var(--td-sh-hair)}
.td-feishu-bulk .td-hint{flex:1 1 240px;min-width:0}
/* A rail row is the reference library's nav item, count pill included: the pill is
   a surface chip on a tinted row, which reads as "badge" without a second colour.
   Selection is the same language the list rows use: an inset accent edge plus a
   tinted fill (v5: the gallery blue, where v4 spent ink). */
.td-side{min-height:36px;display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;
  color:var(--td-text-2);padding:6px 8px;border-radius:var(--td-r-sm);cursor:pointer;
  font-size:12.5px;font-family:inherit;text-align:left;margin-bottom:2px;
  transition:background-color .15s ease,color .15s ease}
.td-side:hover{background:var(--td-hover);color:var(--td-text)}
/* Active is a tint, not a squash: the gallery has no scale transforms anywhere,
   and a nav row that shrinks under the pointer reads as a bug, not as feedback. */
.td-side:active{background:var(--td-hover-2)}
/* v5 selection: a blue wash plus the blue edge -- the same two moves the
   gallery's selected chip makes, at nav-row scale. The label stays ink so it
   keeps AA contrast on the tint in both themes. */
.td-side.on{background:color-mix(in srgb,var(--td-smart-accent,var(--td-accent)) 12%,var(--td-card));
  color:var(--td-text);font-weight:600;
  box-shadow:inset 3px 0 0 var(--td-smart-accent,var(--td-accent))}
.td-side-l{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
/* The count is a flat chip: a borderless grey pill in the mono face, which reads
   as a number rather than as a button (a hairline ring made it look pressable). */
.td-side-n{min-width:24px;height:22px;padding:0 8px;border-radius:999px;flex:none;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-hover);
  color:var(--td-text-3);font-family:var(--td-mono);font-size:12.5px;
  font-variant-numeric:tabular-nums}
.td-side.on .td-side-n{color:var(--td-text-2)}
.td-side .td-glyph{color:var(--td-text-3)}
.td-side.on .td-glyph{color:var(--td-text-2)}
.td-seat [data-collection-filter="archive"]{--td-smart-accent:var(--td-ok)}
.td-seat [data-collection-filter="trash"]{--td-smart-accent:var(--td-danger)}
.td-collection-filter .td-side-n{background:color-mix(in srgb,var(--td-smart-accent) 10%,var(--td-card))}
/* Smart lists get a restrained semantic marker, so the rail gains color without
   turning every task card into a rainbow. The same token feeds the active row,
   the count pill, compact header tabs and the floating checklist. */
.td-seat [data-smart-filter="today"],.td-seat [data-smart-filter="all"]{--td-smart-accent:var(--td-accent)}
.td-seat [data-smart-filter="week"]{--td-smart-accent:var(--td-teal)}
.td-seat [data-smart-filter="overdue"]{--td-smart-accent:var(--td-danger)}
.td-seat [data-smart-filter="inbox"]{--td-smart-accent:var(--td-violet)}
.td-seat [data-smart-filter="done"]{--td-smart-accent:var(--td-ok)}
.td-smart-group .td-side.td-smart-filter::before{content:"";display:block;flex:none;width:8px;height:8px;
  border-radius:999px;background:var(--td-smart-accent,var(--td-accent))}
.td-smart-group .td-side-n{background:color-mix(in srgb,var(--td-smart-accent,var(--td-accent)) 12%,var(--td-card));
  color:var(--td-text-2)}
.td-head2-tab::before{content:"";display:inline-block;width:6px;height:6px;margin-right:4px;
  border-radius:999px;background:var(--td-smart-accent,var(--td-accent));vertical-align:middle}
.td-head2-tab.on{box-shadow:inset 0 -2px 0 var(--td-smart-accent,var(--td-accent))}
.td-create{display:flex;align-items:center;gap:8px;padding:2px 6px 2px 8px}
.td-create .td-in{flex:1;height:28px;font-size:12.5px;border-radius:var(--td-r-sm);padding:0 8px}
/* Each list in the rail is a row: the row selects the list, the trailing button
   opens its settings dialog. That button is painted on hover/focus -- and for the
   list you are actually filtered to, so a touch user reaches it by tapping the
   row once -- instead of turning the rail into a column of identical dots. */
.td-lrow{display:flex;align-items:center;gap:4px;margin-bottom:2px;
  border-radius:var(--td-r-sm);transition:box-shadow .15s ease}
.td-lrow .td-side{flex:1;min-width:0;margin-bottom:0}
.td-lrow.dragging{opacity:.5}
.td-lrow.drop{box-shadow:0 0 0 2px var(--td-accent)}
.td-lcfg{width:24px;height:24px;opacity:0;transition:opacity .15s ease}
.td-lrow:hover .td-lcfg,.td-lrow:focus-within .td-lcfg,.td-lrow.on .td-lcfg{opacity:1}
/* The data card answers "where does this live, and how do I keep a copy" right
   where the user went looking for it, instead of only in the README. */
.td-rail-data{padding:12px;border-radius:var(--td-r-md);background:var(--td-soft);
  box-shadow:var(--td-sh-hair)}
.td-rail-file{display:block;font-family:var(--td-mono);font-size:10.5px;color:var(--td-text-2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px}
.td-rail-note{font-size:12.5px;color:var(--td-text-3);line-height:1.6;margin-bottom:8px}
.td-rail-acts{display:flex;gap:4px;flex-wrap:wrap}

/* ---- list -------------------------------------------------------------- */
/* Group header per bucket, then the tasks as raised cards on a soft canvas.
   The cards are what keep a wide list scannable, and they are why the list is
   capped at its own max width instead of stretching to the window: at 1400px a
   title and its due date sit far enough apart to stop reading as one row. The
   cap widens in the wide tier instead of stretching (D15). */
.td-listwrap{max-width:1060px;margin:0 auto}
.td-grp{margin-bottom:24px}
.td-grp:last-child{margin-bottom:4px}
/* Sticky, because a group title that scrolls away stops answering "which bucket
   am I in" exactly when the list is long enough to need it (D06). The background
   is opaque so the rows slide UNDER it, and the rule below it is the strong
   boundary (22%) rather than the row hairline (12%) -- group first, row second. */
.td-grp-h{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;
  font-size:12.5px;font-weight:600;letter-spacing:.01em;color:var(--td-text);
  background:var(--td-canvas);padding:12px 2px 8px;margin:0 0 6px}
.td-grp-n{min-width:22px;height:22px;padding:0 8px;border-radius:999px;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-card);
  color:var(--td-text-3);font-family:var(--td-mono);font-size:12.5px;
  font-variant-numeric:tabular-nums;box-shadow:var(--td-sh-hair)}
/* On the sticky title the pill would need a white ring to survive the tinted
   canvas it is pasted on; as plain mono text it needs neither (D16). */
.td-grp-h .td-grp-n{background:transparent;box-shadow:none;color:var(--td-text-3)}
.td-grp-h::after{content:"";flex:1;height:1px;background:var(--td-line-2)}
/* Rows are hairlines, not pills. v3 gave every row a 22px radius and a ring+blur
   shadow, so a list of thirty tasks read as thirty floating capsules; the gallery
   instead draws one border and lets the gaps do the separating. The expanded row
   still relaxes its radius (the "this one is open" signal), just from 10 to 6. */
.td-item{position:relative;background:var(--td-card);border-radius:var(--td-r-md);
  box-shadow:0 0 0 1px var(--td-line);margin-bottom:8px;overflow:hidden;
  animation:tdRowIn .45s var(--td-ease) var(--td-delay,0ms) both;
  transition:border-radius .3s var(--td-ease),background-color .15s ease,box-shadow .15s ease}
/* Hover moves the FILL first and never the geometry: a list the pointer sweeps
   across used to bob one pixel per row (D12). The fill is the interaction wash,
   so it reads on a card, on a completed row and on the canvas alike. */
.td-item:hover{background:var(--td-hover);box-shadow:0 0 0 1px var(--td-line-2)}
.td-item:has(.td-tree){border-radius:var(--td-r-sm)}
.td-item.p1::before,.td-item.p2::before,.td-item.p3::before{content:"";position:absolute;
  left:0;top:0;bottom:0;width:3px}
.td-item.p1::before{background:var(--td-pri-1)}
.td-item.p2::before{background:var(--td-pri-2)}
.td-item.p3::before{background:var(--td-danger)}
/* The row whose dialog is open, in the same language as a selected rail row.
   Without it the only way to tell which card the centred dialog belongs to is to
   read the title twice (D13). */
.td-item.cur{background:var(--td-field);box-shadow:inset 3px 0 0 var(--td-accent)}
/* Completed is a nested surface, not a fainter card: --td-soft is one step in
   from the card in BOTH themes, so the state survives the dark theme (D13). */
.td-item.done{box-shadow:0 0 0 1px var(--td-line);background:var(--td-soft)}
.td-item.done:hover{box-shadow:0 0 0 1px var(--td-line-2)}
.td-item.sub{background:transparent;border-radius:0;box-shadow:none;margin-bottom:0;
  overflow:visible;animation:none}
.td-item.sub::before{display:none}
.td-item.sub:hover{background:var(--td-hover);box-shadow:none}
.td-row{display:flex;align-items:center;gap:12px;min-height:48px;padding:2px 12px;
  position:relative;cursor:pointer;border-radius:inherit}
.td-item.sub .td-row{min-height:36px;padding:0 8px;border-radius:var(--td-r-sm)}
.td-chk{position:relative;flex:none;width:22px;height:22px;border-radius:999px;cursor:pointer;padding:0;border:0;
  background:transparent;color:var(--td-card);font-size:12.5px;line-height:1;display:flex;
  align-items:center;justify-content:center;box-shadow:inset 0 0 0 1.5px var(--td-line-2);
  transition:box-shadow .15s ease,background-color .15s ease,color .15s ease,transform .15s ease}
.td-chk:hover{box-shadow:inset 0 0 0 1.5px var(--td-accent);transform:scale(1.06)}
.td-chk.on{background:var(--td-ok);color:var(--td-card);box-shadow:none;animation:tdPopIn .3s var(--td-ease) both}
.td-chk.p3{box-shadow:inset 0 0 0 1.5px var(--td-danger)}
.td-chk.p3.on{background:var(--td-ok);box-shadow:none}
.td-row-title{min-width:0;flex:1;word-break:break-word;font-size:14px;font-weight:500;
  transition:color .15s ease}
.td-item.done .td-row-title{color:var(--td-text-3);text-decoration:line-through;
  text-decoration-color:var(--td-line-2);text-decoration-thickness:1px;font-weight:400}
/* The metadata column has a FLOOR and a CEILING: a fixed minimum keeps its left
   edge from drifting row to row (the due date of one row no longer starts where
   the list chip of the next one ends), and the percentage keeps a long list name
   from eating the title. */
.td-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  justify-content:flex-end;flex:0 1 auto;min-width:132px;max-width:56%;
  min-height:22px;font-size:12.5px;color:var(--td-text-2)}
/* The reference library's status pill: a hue mixed into the surface for the fill
   and into the text colour for the label, so one recipe works in both themes. */
.td-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;
  border:1px solid transparent;border-radius:6px;font-size:12.5px;white-space:nowrap;
  background:var(--td-field);color:var(--td-text-2);font-variant-numeric:tabular-nums;flex:none}
.td-chip.today{border-color:color-mix(in srgb,var(--td-warm) 30%,var(--td-card));
  background:color-mix(in srgb,var(--td-warm) 14%,var(--td-card));
  color:color-mix(in srgb,var(--td-warm) 92%,var(--td-text))}
.td-chip.late{border-color:color-mix(in srgb,var(--td-danger) 30%,var(--td-card));
  background:color-mix(in srgb,var(--td-danger) 14%,var(--td-card));
  color:color-mix(in srgb,var(--td-danger) 90%,var(--td-text))}
.td-chip.ok{border-color:color-mix(in srgb,var(--td-ok) 30%,var(--td-card));
  background:color-mix(in srgb,var(--td-ok) 14%,var(--td-card));
  color:color-mix(in srgb,var(--td-ok) 92%,var(--td-text))}
.td-chip.tint{border-color:color-mix(in srgb,var(--td-tint,var(--td-line-2)) 34%,var(--td-card));
  background:color-mix(in srgb,var(--td-tint,var(--td-field)) 15%,var(--td-card))}
/* The overflow chip: it answers "there is more here" without spending a fourth
   slot on a 48px row, and it is a bare glyph group rather than a pill so it never
   reads as one more thing (D07). */
.td-meta-more{display:inline-flex;align-items:center;height:22px;padding:0 8px;
  border-radius:var(--td-r-sm);background:transparent;color:var(--td-text-3);
  font-size:12.5px;font-variant-numeric:tabular-nums;flex:none}
/* Without nowrap/flex:none a flex parent squeezes a tag the way it squeezes a
   long word -- down to one CJK character per line. */
.td-tag{color:var(--td-text-3);font-size:12.5px;font-family:var(--td-mono);
  white-space:nowrap;flex:none}
.td-tree{position:relative;margin:0 0 12px 32px;padding:2px 0 2px 16px}
.td-tree::before{content:"";position:absolute;left:0;top:-6px;bottom:8px;width:1px;
  background:var(--td-line-2)}
/* An element that leaves the DOM cannot animate, and a measured max-height is a
   guess that shows. The 0fr -> 1fr grid row animates the real height instead. */
.td-collapse{display:grid;grid-template-rows:0fr;opacity:0;
  transition:grid-template-rows .3s var(--td-ease),opacity .3s ease}
.td-collapse.open{grid-template-rows:1fr;opacity:1}
.td-clip{min-height:0;overflow:hidden}
.td-actions{display:flex;gap:4px;opacity:0;flex:none;transition:opacity .15s ease}
.td-actions .td-icon{width:28px;height:28px}
.td-item:hover .td-actions,.td-item:focus-within .td-actions{opacity:1}
.td-treebtn{flex:none;width:24px;height:24px;border:0;background:transparent;cursor:pointer;
  color:var(--td-text-3);padding:0;font-family:inherit;line-height:0;border-radius:6px;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .15s ease,color .15s ease}
.td-treebtn:hover{background:var(--td-hover);color:var(--td-text)}
.td-treebtn.empty{visibility:hidden}
.td-caret{transition:transform .3s var(--td-ease)}
.td-caret.open{transform:rotate(180deg)}

/* ---- board ------------------------------------------------------------- */
.td-board{flex:1;min-height:0;display:flex;gap:16px;align-items:flex-start;overflow:auto;
  padding:24px 24px 48px;background:var(--td-canvas)}
/* Each column carries its list colour as a tinted top edge, which is what makes
   four otherwise identical columns read as four different places. */
.td-col{width:322px;flex:none;display:flex;flex-direction:column;max-height:100%;
  background:var(--td-card);border-radius:var(--td-r-lg);
  box-shadow:inset 0 3px 0 var(--td-tint,transparent),var(--td-sh-1);
  transition:box-shadow .15s ease}
.td-col.drop{box-shadow:inset 0 3px 0 var(--td-tint,transparent),0 0 0 2px var(--td-accent)}
.td-col-h{display:flex;align-items:center;gap:8px;padding:16px 16px 12px;font-size:14px;
  font-weight:600;flex:none}
.td-col-n{min-width:24px;height:22px;padding:0 8px;border-radius:999px;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-field);
  color:var(--td-text-3);font-family:var(--td-mono);font-size:12.5px;
  font-variant-numeric:tabular-nums}
.td-col-add{width:28px;height:28px;border-radius:6px;border:0;background:transparent;
  color:var(--td-text-3);cursor:pointer;font-size:14px;font-family:inherit;line-height:1;
  padding:0;display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .15s ease,color .15s ease}
.td-col-add:hover{background:var(--td-hover);color:var(--td-text)}
.td-col-b{flex:1;min-height:56px;overflow:auto;padding:0 12px 16px}
.td-col-b::after{content:"";display:block;height:1px}
.td-card{position:relative;background:var(--td-soft);border-radius:var(--td-r-md);
  padding:12px 16px;margin-bottom:12px;cursor:pointer;display:flex;gap:12px;
  box-shadow:var(--td-sh-hair);
  transition:box-shadow .15s ease,background-color .15s ease}
.td-card:hover{box-shadow:0 0 0 1px var(--td-line-2);background:var(--td-hover)}
.td-card.dragging{opacity:.5}
.td-card-t{font-size:14px;word-break:break-word;margin-bottom:8px;font-weight:600;line-height:1.5}
.td-card.done{background:var(--td-soft)}
.td-card.done .td-card-t{text-decoration:line-through;color:var(--td-text-3)}
.td-card-side{display:flex;flex-direction:column;gap:8px;align-items:center;flex:none}
/* A board column is read standing back from the screen, and the list's 12.5px
   chip disappears inside a 322px card -- so cards get their own chip size. */
.td-card .td-chip{font-size:12.5px;height:24px;padding:0 8px}
.td-card .td-tag{font-size:12.5px}
.td-card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.td-col-empty{border:1px dashed var(--td-line-2);border-radius:var(--td-r-md);padding:24px 16px;
  text-align:center;color:var(--td-text-3);font-size:14px;cursor:pointer;
  transition:color .15s ease,border-color .15s ease,background-color .15s ease}
.td-col-empty:hover{color:var(--td-text);border-color:var(--td-text-2);
  background:var(--td-soft)}

/* ---- calendar ---------------------------------------------------------- */
.td-cal-h{display:flex;align-items:center;gap:12px;margin:0 auto 16px;max-width:1680px}
.td-cal-nav{display:inline-flex;gap:4px;padding:2px;border-radius:10px;background:var(--td-field)}
/* Named instead of a bare "> button" child selector: that styles the buttons but
   leaves them anonymous to anything looking for them. */
.td-cal-navb{border:0;background:transparent;color:var(--td-text-2);border-radius:var(--td-r-sm);
  padding:6px 12px;font-size:14px;font-family:inherit;cursor:pointer;
  transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}
.td-cal-navb:hover{background:var(--td-card);color:var(--td-text)}
.td-cal-title{font-size:20px;font-weight:600;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;margin-left:2px}
/* Cells are cards with a gutter, not table cells: the grid lines were doing all
   the work in the old sheet and made the month read as a spreadsheet. */
.td-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;
  max-width:1680px;margin:0 auto}
/* The weekday row sits on the canvas, so it takes ink-2: ink-3 measures 4.29:1
   there, which is below AA (D04). */
.td-cal-wd{padding:0 4px 8px;font-size:10.5px;font-weight:600;letter-spacing:.08em;
  color:var(--td-text-2);text-align:center}
.td-cal-cell{background:var(--td-card);border-radius:var(--td-r-md);box-shadow:var(--td-sh-hair);
  min-height:124px;padding:8px 8px;cursor:pointer;display:flex;flex-direction:column;gap:8px;
  overflow:hidden;transition:box-shadow .15s ease,background-color .15s ease}
.td-cal-cell:hover{box-shadow:var(--td-sh-hair);background:var(--td-soft)}
.td-cal-cell.out{background:transparent;box-shadow:none;opacity:.45}
.td-cal-cell.today{background:color-mix(in srgb,var(--td-warm) 6%,var(--td-card));
  box-shadow:var(--td-sh-hair)}
.td-cal-cell.sel{background:color-mix(in srgb,var(--td-accent) 8%,var(--td-card));
  box-shadow:inset 3px 0 0 var(--td-accent)}
.td-cal-d{font-size:12.5px;color:var(--td-text-3);display:flex;align-items:center;
  justify-content:space-between;font-variant-numeric:tabular-nums;min-height:24px}
.td-cal-d > span:first-child{width:24px;height:24px;display:inline-flex;align-items:center;
  justify-content:center;border-radius:999px;font-family:var(--td-mono);font-size:12.5px}
/* Today wears the one blue dot the month gets. */
.td-cal-cell.today .td-cal-d > span:first-child{background:var(--td-accent);color:var(--td-accent-on);
  font-weight:600}
.td-cal-task{font-size:14px;line-height:1.5;padding:4px 8px;border-radius:6px;
  border-left:3px solid var(--td-tint,var(--td-line-2));
  background:color-mix(in srgb,var(--td-tint,var(--td-field)) 12%,var(--td-card));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;
  transition:filter .15s ease}
.td-cal-task:hover{filter:brightness(.97)}
/* Done is said with ink and a strike, not with a translucent chip: opacity on a
   surface makes the divider behind it show through (D13). */
.td-cal-task.done{text-decoration:line-through;color:var(--td-text-3)}
.td-cal-more{font-size:12.5px;color:var(--td-text-3);padding-left:2px;
  font-family:var(--td-mono)}
.td-day{max-width:1680px;margin:24px auto 0;border-radius:var(--td-r-lg);overflow:hidden;
  background:var(--td-card);box-shadow:0 0 0 1px var(--td-line)}
.td-day-h{padding:16px 16px;font-size:14px;font-weight:600;border-bottom:1px solid var(--td-line-2);
  display:flex;align-items:center;gap:12px}
.td-day-b{padding:16px 16px}

/* ---- gantt ------------------------------------------------------------- */
/* The task and timeline panes scroll vertically in sync; each header is sticky. */
.td-gantt{display:flex;border-radius:var(--td-r-lg);overflow:hidden;background:var(--td-card);
  box-shadow:0 0 0 1px var(--td-line);max-width:1680px;max-height:68vh;margin:0 auto}
.td-gantt-l{width:300px;flex:none;border-right:1px solid var(--td-line);position:relative;z-index:2;
  background:var(--td-card);overflow-x:hidden;overflow-y:auto;max-height:68vh;overscroll-behavior:contain;scrollbar-width:none}
.td-gantt-l::-webkit-scrollbar{width:0;height:0}
.td-gantt-r{flex:1;min-width:0;overflow-x:auto;overflow-y:auto;max-height:68vh;overscroll-behavior:contain}
.td-gantt-th{height:64px;position:sticky;top:0;z-index:4;display:flex;align-items:flex-end;padding:0 16px 12px;font-size:12.5px;
  font-weight:600;letter-spacing:.04em;color:var(--td-text-2);
  border-bottom:1px solid var(--td-line);background:var(--td-soft)}
.td-gantt-row{height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;font-size:14px;
  border-bottom:1px solid var(--td-line);white-space:nowrap;overflow:hidden;cursor:pointer;
  transition:background-color .15s ease}
.td-gantt-row:hover{background:var(--td-hover)}
.td-gantt-row.done .td-gantt-t{color:var(--td-text-3);text-decoration:line-through}
.td-gantt-t{overflow:hidden;text-overflow:ellipsis}
.td-gantt-hd{position:sticky;top:0;z-index:4;border-bottom:1px solid var(--td-line);
  background:var(--td-soft);display:grid;grid-template-rows:24px 40px}
.td-gantt-month{display:flex;align-items:center;font-size:12.5px;font-weight:600;
  color:var(--td-text-2);letter-spacing:.04em;padding-left:8px;
  border-right:1px solid var(--td-line)}
.td-gantt-cell{font-size:12.5px;color:var(--td-text-3);text-align:center;
  border-right:1px solid var(--td-line);font-variant-numeric:tabular-nums;
  font-family:var(--td-mono);display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:4px;line-height:1}
.td-gantt-cell small{font-size:10.5px;opacity:.8;font-weight:400;font-family:inherit}
.td-gantt-cell.we{background:color-mix(in srgb,var(--td-field) 70%,transparent)}
.td-gantt-cell.today{color:var(--td-accent);font-weight:700}
.td-gantt-track{position:relative;height:48px;border-bottom:1px solid var(--td-line);display:grid}
.td-gantt-bg{border-right:1px solid var(--td-line);grid-row:1}
.td-gantt-bg.we{background:color-mix(in srgb,var(--td-field) 70%,transparent)}
.td-gantt-bg.today{background:color-mix(in srgb,var(--td-warm) 12%,transparent)}
/* The bar keeps the list colour; grab the body to translate the whole schedule,
   or its endpoint grips to change the interval. */
.td-gantt-bar{grid-row:1;align-self:center;height:22px;border-radius:999px;margin:0 2px;
  position:relative;background:var(--td-tint,var(--td-text-2));opacity:.9;cursor:grab;z-index:1;
  touch-action:none;user-select:none;box-shadow:0 1px 2px rgba(16,24,40,.16);
  transition:opacity .15s ease,background-color .15s ease}
.td-gantt-bar:hover{opacity:1;filter:brightness(.97)}
.td-gantt-bar.dragging{z-index:4;opacity:1;cursor:grabbing;transition:none}
.td-gantt-bar:focus-visible{outline:2px solid var(--td-accent);outline-offset:2px}
.td-gantt-handle{position:absolute;top:0;bottom:0;width:8px;padding:0;border:0;outline:0;
  display:flex;align-items:center;justify-content:center;background:transparent;opacity:0;
  cursor:ew-resize;z-index:3;touch-action:none}
.td-gantt-handle-start{left:-4px}
.td-gantt-handle-end{right:-4px}
.td-gantt-handle::after{content:"";width:2px;height:12px;border-radius:2px;
  background:var(--td-card);box-shadow:0 0 0 1px color-mix(in srgb,var(--td-ink) 18%,transparent)}
.td-gantt-bar:hover .td-gantt-handle,
.td-gantt-bar.dragging .td-gantt-handle,
.td-gantt-handle:focus-visible{opacity:1}
.td-gantt-handle:focus-visible{background:color-mix(in srgb,var(--td-card) 30%,transparent)}
.td-gantt-instruction{color:var(--td-text-3);font-size:10.5px;white-space:nowrap}
.td-gantt-bar.done{background:color-mix(in srgb,var(--td-text-3) 45%,var(--td-card));
  opacity:1;box-shadow:none}
.td-gantt-bar.late{background:var(--td-danger)}
.td-gantt-bar.ms{border-radius:3px;height:16px;width:16px;justify-self:start;margin-left:12px;
  transform:rotate(45deg)}
.td-gantt-bar.ms:hover{transform:rotate(45deg)}
.td-gantt-now{position:absolute;top:0;bottom:0;width:2px;background:var(--td-warm);
  opacity:.55;pointer-events:none;z-index:2}

/* ---- the centred task dialog ------------------------------------------ */
.td-modal-layer{position:fixed;inset:0;z-index:9100;display:flex;align-items:center;
  justify-content:center;padding:24px;background:rgb(0 0 0 / 48%);backdrop-filter:blur(6px);
  animation:tdFade .15s ease-out}
/* Three bands, not one sheet of white: a card-coloured header, a RECESSED body, a
   card-coloured footer. The dialog used to be white fields inside a white card
   separated by 8%-black hairlines, which read as one blank page -- "白花花一片".
   The recessed body is what makes a section, and the fields inside it, visible at
   all; the 3px top edge carries the list colour, the same signal the board column
   and the calendar chip already use. */
.td-modal{width:min(700px,100%);max-height:min(88vh,860px);display:flex;flex-direction:column;
  background:var(--td-card);border-radius:var(--td-r-lg);
  box-shadow:inset 0 3px 0 var(--td-tint,transparent),var(--td-sh-3);
  overflow:hidden;animation:tdModal .24s var(--td-ease)}
@keyframes tdFade{from{opacity:0}to{opacity:1}}
@keyframes tdModal{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
@keyframes tdPopIn{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}
@keyframes tdRowIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.td-modal-h{flex:none;display:flex;align-items:center;gap:12px;padding:16px 16px;
  border-bottom:1px solid var(--td-line)}
/* An eyebrow, not a heading: small, soft and muted so it labels the thing below
   without competing with the task title. (v4 used uppercase mono; the dialog's
   own words are Chinese, where uppercase is a no-op and only the mono noise
   survived -- v5 drops it.) */
.td-modal-kind{font-family:inherit;font-size:12.5px;font-weight:600;letter-spacing:.06em;
  color:var(--td-text-3)}
.td-modal-close{flex:none;width:28px;height:28px;border:0;border-radius:var(--td-r-sm);
  background:transparent;color:var(--td-text-2);cursor:pointer;font-size:16px;line-height:0;
  font-family:inherit;display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .15s ease,color .15s ease}
.td-modal-close:hover{background:var(--td-hover);color:var(--td-text)}
.td-modal-b{flex:1;min-height:0;overflow:auto;padding:16px 16px 24px;background:var(--td-canvas)}
/* Every block in the body is a card on that recessed canvas, and the gap between
   them is what lets the eye group the form instead of scanning a wall of white. */
.td-modal-b > * + *{margin-top:12px}
.td-modal-f{flex:none;display:flex;align-items:center;gap:12px;padding:12px 16px;
  border-top:1px solid var(--td-line);background:var(--td-card)}
/* A field on a card is tinted, because a white input on a white card is exactly
   the invisibility this is about; focus returns it to plain card white. Placed
   before the .td-hero rules below, which are meant to win for the title. */
.td-modal .td-in{background:var(--td-field);border-color:transparent}
.td-modal .td-in:hover{background:var(--td-hover);border-color:var(--td-line-2)}
.td-modal .td-in:focus{background:var(--td-card);border-color:var(--td-accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-accent) 18%,transparent)}
/* The list editor is a form, not a document: the same dialog shell, narrower. */
.td-narrow{width:min(460px,100%)}
.td-swatches{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
/* The ring is drawn OUTSIDE the swatch (a card-coloured gap then a text-coloured
   ring) because a 2px inset ring on a saturated dot is invisible at this size. */
.td-swatch{width:24px;height:24px;padding:0;border:0;border-radius:999px;cursor:pointer;
  box-shadow:inset 0 0 0 1px var(--td-line-2);transition:transform .15s ease,box-shadow .15s ease}
.td-swatch:hover{transform:scale(1.12)}
.td-swatch.on{box-shadow:0 0 0 2px var(--td-card),0 0 0 4px var(--td-accent)}
.td-posline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.td-preview{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:6px 12px;
  border-radius:999px;background:var(--td-field);font-size:12.5px;color:var(--td-text)}
.td-preview .td-side-l{flex:0 1 auto}
.td-hero{display:flex;align-items:flex-start;gap:12px;padding:16px 16px;
  background:var(--td-card);border-radius:var(--td-r-md);box-shadow:0 0 0 1px var(--td-line)}
.td-hero .td-chk{width:22px;height:22px;margin-top:4px;font-size:12.5px}
.td-hero .td-in{flex:1;width:100%;min-width:0;font-size:16px;font-weight:600;padding:6px 8px;border-color:transparent;
  background:transparent;letter-spacing:-.01em;border-radius:var(--td-r-sm)}
.td-hero .td-in:hover{border-color:var(--td-line);background:var(--td-hover)}
.td-hero .td-in:focus{border-color:var(--td-accent);background:var(--td-card);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-accent) 18%,transparent)}
.td-props{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;padding:16px 16px;
  background:var(--td-card);border-radius:var(--td-r-md);box-shadow:0 0 0 1px var(--td-line)}
.td-field{min-width:0}
.td-field > label{display:block;font-family:inherit;font-size:10.5px;font-weight:600;
  letter-spacing:.08em;color:var(--td-text-3);margin-bottom:8px}
.td-field .td-in{width:100%}
.td-sect{padding:16px 16px;background:var(--td-card);border-radius:var(--td-r-md);
  box-shadow:0 0 0 1px var(--td-line)}
.td-sect > label{display:block;font-family:inherit;font-size:10.5px;font-weight:600;
  letter-spacing:.08em;color:var(--td-text-3);margin-bottom:8px}
.td-rowline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.td-rowline .td-in{width:auto}
.td-ta{min-height:84px;resize:vertical;line-height:1.6;width:100%}
.td-sub-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--td-r-sm);
  transition:background-color .15s ease}
.td-sub-row:hover{background:var(--td-field)}
.td-sub-row .td-t{flex:1;min-width:0;cursor:pointer;word-break:break-word;font-size:14px}
.td-sub-row.done .td-t{text-decoration:line-through;color:var(--td-text-3)}
/* Priority as a row of radio pills rather than a dropdown: four options is few
   enough to show at once, and a vertical list would set the row height for the
   whole property grid -- leaving a hole under the fields beside it. */
.td-opts{display:flex;flex-wrap:wrap;gap:8px}
.td-opt{display:inline-flex;align-items:center;gap:8px;margin:0;padding:4px 12px 4px 8px;
  border:0;border-radius:999px;background:var(--td-soft);color:var(--td-text-2);
  font-size:12.5px;font-family:inherit;cursor:pointer;box-shadow:var(--td-sh-hair);
  transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}
.td-opt:hover{background:var(--td-field);color:var(--td-text)}
.td-opt.on{background:var(--td-card);color:var(--td-text);font-weight:600;
  box-shadow:var(--td-sh-1)}
.td-ind{display:flex;width:14px;height:14px;flex:none;align-items:center;justify-content:center;
  border-radius:999px;color:transparent;box-shadow:inset 0 0 0 1.5px var(--td-line-2);
  transition:background-color .15s ease,box-shadow .15s ease,color .15s ease}
.td-opt.on .td-ind{background:var(--td-accent);color:var(--td-accent-on);box-shadow:none}
.td-opt-dot{width:6px;height:6px;border-radius:999px;flex:none}
.td-wd{display:flex;gap:4px}
.td-wd button{width:32px;height:30px;border-radius:var(--td-r-sm);border:0;background:var(--td-field);
  color:var(--td-text-2);cursor:pointer;font-size:12.5px;font-family:inherit;
  transition:background-color .15s ease,color .15s ease}
.td-wd button:hover{color:var(--td-text)}
.td-wd button.on{background:var(--td-accent);color:var(--td-accent-on);font-weight:600}

/* ---- feedback ---------------------------------------------------------- */
.td-toast{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);z-index:20;
  display:flex;height:36px;max-width:calc(100% - 32px);align-items:center;padding:0 12px;
  border-radius:999px;background:var(--td-text);
  color:var(--td-card);font-size:12.5px;font-weight:500;box-shadow:var(--td-sh-3);
  animation:tdToast .22s var(--td-ease)}
@keyframes tdToast{from{opacity:0;transform:translate(-50%,8px) scale(.96)}
  to{opacity:1;transform:translate(-50%,0) scale(1)}}
/* The empty state is the first thing a new document shows, and it sits on the
   canvas: ink-2 (4.69), not ink-3 (4.29). */
.td-empty{color:var(--td-text-2);font-size:12.5px;padding:48px 16px;text-align:center;
  line-height:1.6}
.td-empty-t{font-size:14px;font-weight:600;color:var(--td-text)}
.td-empty-ex{margin-top:16px}
.td-empty-l{margin-bottom:8px}
.td-empty-gap{height:8px}
.td-empty code{background:var(--td-field);padding:2px 8px;border-radius:6px;
  font-size:12.5px;font-family:var(--td-mono);color:var(--td-text-2)}
.td-warn{border-radius:var(--td-r-md);padding:8px 12px;font-size:12.5px;margin-bottom:12px;
  color:color-mix(in srgb,var(--td-warn) 88%,var(--td-text));
  background:color-mix(in srgb,var(--td-warn) 12%,var(--td-card))}
.td-err{border-radius:var(--td-r-md);padding:8px 12px;font-size:12.5px;margin-bottom:12px;
  color:color-mix(in srgb,var(--td-danger) 90%,var(--td-text));white-space:pre-wrap;
  background:color-mix(in srgb,var(--td-danger) 12%,var(--td-card))}
.td-pop{position:absolute;z-index:30;background:var(--td-card);border-radius:var(--td-r-md);
  padding:4px;min-width:168px;box-shadow:var(--td-sh-3);animation:tdPop .16s var(--td-ease);
  transform-origin:top right}
@keyframes tdPop{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}
.td-pop button{display:block;width:100%;text-align:left;border:0;background:transparent;
  color:var(--td-text-2);padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;
  font-family:inherit;transition:background-color .15s ease,color .15s ease}
.td-pop button:hover{background:var(--td-hover);color:var(--td-text)}
.td-pop .td-task-action{white-space:normal}
.td-pop button:disabled{opacity:.48;cursor:not-allowed}
.td-pop button:disabled:hover{background:transparent;color:var(--td-text-2)}

/* ---- the floating window ---------------------------------------------- */
/* The app in a box the user drags around the page. The box owns the definite
   height the list scrolls inside, so every layer below it keeps the panel's own
   flex chain -- no second scroll model for the same list. */
.td-float{position:fixed;z-index:9050;display:flex;flex-direction:column;min-width:260px;
  min-height:200px;background:var(--td-card);border:1px solid var(--td-line-2);
  border-radius:var(--td-r-lg);box-shadow:var(--td-sh-2);overflow:hidden;
  animation:tdModal .22s var(--td-ease)}
.td-float.dragging{user-select:none;border-color:var(--td-accent)}
.td-float .td-root,.td-root.td-floatapp{height:100%;background:var(--td-card)}
/* The header IS the drag handle: the strip grabs, the controls inside it do not
   (the pointerdown handler skips anything inside a button or an input). */
.td-float .td-head{height:auto;min-height:48px;padding:0 12px;cursor:move;
  touch-action:none;border-bottom:1px solid var(--td-line);
  border-radius:var(--td-r-lg) var(--td-r-lg) 0 0}
.td-float .td-head .td-btn,.td-float .td-head .td-icon{cursor:pointer}
.td-float .td-qadd{padding:12px 12px}
.td-float .td-rail{display:none}
/* Search and the smart lists stay reachable inside the window: a box that could
   only show one slice of the tasks would send the user back to the panel for
   every question. The chips scroll sideways instead of wrapping to two rows. */
.td-float-bar{flex:none;display:flex;flex-direction:column;gap:8px;padding:8px 12px;
  border-bottom:1px solid var(--td-line);background:var(--td-card)}
.td-float-bar .td-float-lists{display:flex;align-items:center;gap:8px;padding:0 2px}
.td-float-sel{flex:1;min-width:0;height:28px;padding:0 6px;border-radius:var(--td-r-sm);
  font-family:inherit;font-size:12.5px;font-weight:600;color:var(--td-text-2);
  background:transparent;border-color:transparent}
.td-float-sel:hover{background:var(--td-hover)}
.td-float-sel:focus{background:var(--td-card);border-color:var(--td-accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-accent) 18%,transparent)}
.td-float-tabs{display:flex;overflow-x:auto;scrollbar-width:none}
.td-float-tabs::-webkit-scrollbar{display:none}
.td-float-tabs > button{flex:none;padding:4px 8px;font-size:12.5px;border-radius:var(--td-r-sm)}
/* The checklist skin: one line per task, the title ellipsised instead of broken
   one CJK character per line, and the rows flattened from cards to lines --
   which is all a "name + checkbox" row needs. */
.td-float .td-scroll{padding:8px 8px 24px}
.td-cmp .td-item{background:transparent;border-radius:var(--td-r-sm);box-shadow:none}
.td-cmp .td-item:hover{background:var(--td-hover);box-shadow:none}
.td-cmp .td-item::before{display:none}
.td-cmp .td-item.done{background:transparent}
.td-cmp .td-row{min-height:36px;padding:0 8px;gap:8px}
.td-cmp .td-row-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  word-break:normal;font-size:14px}
.td-cmp .td-grp-h{margin-bottom:4px}
.td-cmp .td-grp + .td-grp{margin-top:12px}
/* The sticky group title belongs to the panel's scrolling list; the window's
   checklist is a short column inside its own box, and a title pasted over the
   rows there would only hide them. */
.td-cmp .td-grp .td-grp-h{position:static;background:transparent}
/* Floating-seat refinement: keep the checklist compact, but let its frame,
   surfaces and typography inherit whichever approved appearance is active. The
   window should be a smaller seat of the same app, not a third visual theme. */
.td-flogo{width:10px;height:10px;border-radius:2px;flex:none;
  background:var(--td-accent)}
.td-float .td-head{min-height:48px;padding:0 12px;border-bottom:0;
  background:var(--td-card)}
.td-float .td-h1{font-size:14px;font-weight:650;color:var(--td-text)}
/* The count is context, not a badge: a plain number cannot out-shout the rows. */
.td-float .td-countbadge{min-width:0;height:auto;padding:0 0 0 4px;background:transparent;
  color:var(--td-text-3);font-size:10.5px;font-weight:600}
.td-float .td-headtools .td-btn,.td-float .td-headtools .td-icon{background:transparent;
  color:var(--td-text-3);font-weight:600}
.td-float .td-headtools .td-btn:hover,.td-float .td-headtools .td-icon:hover{
  background:var(--td-soft);color:var(--td-accent)}
/* The filter row is a row of words, not a segmented control: remove the trough
   and dividers, and let the selected slice carry the only tint. */
.td-float .td-seg{background:transparent;border:0;padding:0;overflow:visible}
.td-float .td-seg > button + button{box-shadow:none}
.td-float .td-float-tabs > button{padding:4px 8px;font-size:12.5px;font-weight:600;
  border-radius:var(--td-r-sm);color:var(--td-text-2)}
.td-float .td-float-tabs > button:hover{background:var(--td-hover);color:var(--td-text)}
/* One tint per row: the slice being viewed. */
.td-float .td-seg > button.on{background:color-mix(in srgb,var(--td-smart-accent,var(--td-accent)) 14%,var(--td-card));
  color:var(--td-text);font-weight:700}
.td-float .td-send{width:36px;height:36px;border-radius:var(--td-r-sm);
  background:color-mix(in srgb,var(--td-accent) 12%,var(--td-card));color:var(--td-accent)}
.td-float .td-send:hover{background:var(--td-accent);color:var(--td-accent-on);filter:none}
.td-float .td-qadd{padding:12px}
.td-float .td-qadd .td-in{height:36px}
/* The input already has an accent border and wash; suppress the global ink outline
   here so keyboard focus remains clear without the double-ring from the screenshot. */
.td-float .td-qadd .td-in:focus-visible{outline:0;outline-offset:0}
.td-cmp .td-grp{margin-bottom:16px}
.td-cmp .td-grp:first-child{margin-top:4px}
.td-cmp .td-grp-h{padding:0 0 6px;margin:0 0 6px}
.td-cmp .td-grp-h > span:first-child{font-size:12.5px;letter-spacing:.06em;font-weight:700;
  color:color-mix(in srgb,var(--td-accent) 40%,var(--td-text))}
.td-cmp .td-grp-n{background:transparent;box-shadow:none;color:var(--td-text-3);font-weight:600}
.td-cmp .td-grp-h::after{background:var(--td-line)}
/* A checklist reads as a column, not as a stack of cards; the row you are on is
   where the accent returns, as a 2px edge rather than a whole filled card. */
.td-cmp .td-item{margin-bottom:2px}
.td-cmp .td-row{min-height:36px;padding:0 8px;gap:12px}
.td-cmp .td-row-title{font-size:14px;font-weight:600;color:var(--td-text)}
.td-cmp .td-item:hover{box-shadow:inset 2px 0 0 var(--td-accent)}
.td-cmp .td-item.done:hover{box-shadow:inset 2px 0 0 var(--td-line-2)}
.td-cmp .td-chk{width:18px;height:18px}
/* The only row action retained in the floating checklist is its task menu. Keep
   it visible without hover too, so the copy action remains reachable on touch. */
.td-cmp .td-float-actions{opacity:1}
.td-cmp .td-float-actions .td-icon{width:26px;height:26px;color:var(--td-text-3)}
.td-cmp .td-float-actions .td-icon:hover{color:var(--td-accent)}
/* The last row fades instead of being cut: the column has no bottom edge.
   rgb() rather than a hex literal -- a mask only reads the alpha, and the sheet
   keeps one token map (see scripts/audit-css.mjs). */
.td-float .td-scroll{
  mask-image:linear-gradient(180deg,rgb(0 0 0) calc(100% - 24px),transparent 100%);
  -webkit-mask-image:linear-gradient(180deg,rgb(0 0 0) calc(100% - 24px),transparent 100%)}

/* ---- the celebration ---------------------------------------------------- */
/* Ten sparks and a ring for under a second after a box is ticked. Purely CSS: the
   component only decides WHEN to mount them, so a re-render cannot restart or
   strand the animation. The colour rides on --c, which keeps one class for all
   ten. Both the ring and the sparks use --td-ok / --td-warm: ticking a box is
   a COMPLETION, so the celebration speaks the green the checkbox speaks -- the
   accent blue stays reserved for primary / selection / focus. */
@keyframes tdSpark{
  0%{opacity:0;transform:rotate(var(--a,0deg)) translateX(2px) scale(.4)}
  15%{opacity:1}
  100%{opacity:0;transform:rotate(var(--a,0deg)) translateX(var(--d,20px)) scale(1)}}
@keyframes tdRing{
  0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--td-ok) 55%,transparent)}
  100%{box-shadow:0 0 0 14px color-mix(in srgb,var(--td-ok) 0%,transparent)}}
.td-burst{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:2}
.td-spark{position:absolute;left:-2px;top:-2px;width:5px;height:5px;
  border-radius:0;background:var(--c,var(--td-ok));opacity:0;
  animation:tdSpark .78s var(--td-ease) var(--t,0ms) forwards}
.td-chk.ring{animation:tdPopIn .3s var(--td-ease) both,tdRing .7s ease-out}
.td-dragh{cursor:move;touch-action:none}
.td-float-grip{position:absolute;right:0;bottom:0;width:20px;height:20px;z-index:2;
  cursor:nwse-resize;touch-action:none}
.td-float-grip::after{content:'';position:absolute;right:4px;bottom:4px;width:8px;height:8px;
  border-right:2px solid var(--td-line-2);border-bottom:2px solid var(--td-line-2);
  border-radius:0 0 3px 0;opacity:.8}
.td-float-grip:hover::after{border-color:var(--td-text-2)}

/* ---- sidebar glyph + badge -------------------------------------------- */
.td-glyphwrap{position:relative;display:inline-flex;align-items:center;justify-content:center;
  line-height:0;color:inherit}
/* Aliases, not raw host tokens: this badge is the one place outside the alias
   block that used to reach for --dsw-alias-brand-primary directly, which is what
   made it the only element that ignored the plugin's own ink ladder (D11). */
.td-glyphbadge{position:absolute;top:-5px;right:-7px;min-width:14px;height:14px;padding:0 4px;
  border-radius:6px;background:var(--td-accent);color:var(--td-accent-on);
  font-family:var(--td-mono);font-size:10.5px;font-weight:700;line-height:14px;text-align:center;
  font-variant-numeric:tabular-nums;
  box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill);pointer-events:none}

/* ---------------------------------------------------------------------------
   Density tiers. The container is .td-root itself, so these are CONTAINER
   queries: the panel decides its own density from the width it was given, not
   from the window it happens to sit in.
   --------------------------------------------------------------------------- */

/* WIDE (>= 1600px): the list stops growing at 1280px and the board's columns
   share out the extra width instead of leaving two empty margins (D15). */
@container td (min-width:1600px){
  .td-listwrap{max-width:1280px}
  .td-row{padding:2px 16px}
  .td-col{flex:1 1 322px;max-width:420px}
  .td-board{gap:16px}
}

/* NARROW (<= 680px): the rail is dropped entirely -- a 238px rail inside a
   400px panel leaves neither column readable -- and everything it carried comes
   back in the header (the view switcher, the search box, and the second row with
   the smart lists and the list switcher). The month grid and the board columns
   shrink with it: seven 124px cells do not fit in a 400px panel, and a column
   that kept its 322px width would push the second column out of sight. */
@container td (max-width:680px){
  .td-rail{display:none}
  .td-head{flex-wrap:wrap;height:auto;min-height:56px;padding:0 12px;gap:8px}
  .td-head2{display:flex;align-items:center;gap:8px;flex:none;padding:8px 12px;
    overflow-x:auto;scrollbar-width:none;background:var(--td-card);
    border-bottom:1px solid var(--td-line)}
  .td-head2::-webkit-scrollbar{display:none}
  .td-headtools .td-headviews{display:inline-flex}
  /* ...and the search box comes back to the header with it. The class sits on the
     box, not the field, so the magnifier and the tag chip travel with it. */
  .td-headtools .td-headsearch{display:block}
  .td-sub{display:none}
  .td-headsearch .td-search{width:140px}
  .td-modal-layer{padding:12px}
  .td-feishu-field-conflict{align-items:stretch;flex-direction:column;gap:8px}
  .td-feishu-field-copy{grid-template-columns:minmax(0,1fr);gap:4px}
  .td-feishu-field-copy strong{grid-row:auto}
  .td-feishu-field-copy small{grid-column:1}
  .td-feishu-choice{justify-content:flex-end;flex-wrap:wrap}
  .td-feishu-sync-footer{flex-wrap:wrap}
  .td-feishu-sync-footer .td-hint{flex:1 1 100%}
  .td-feishu-bulk{flex-direction:column;align-items:stretch}
  .td-feishu-bulk .td-hint{flex:1 1 auto}
  .td-feishu-bulk .td-btn{justify-content:center}
  .td-set-sync{grid-template-columns:minmax(0,1fr)}
  .td-set-footerhead .td-set-hint{flex:1 1 100%}
  .td-gantt-l{width:200px}
  .td-cal-cell{min-height:88px;padding:6px 6px}
  .td-cal-task{font-size:12.5px;padding:2px 6px}
  .td-col{width:262px}
  /* The row goes two lines instead of shrinking its type -- and the FIRST line is
     the row's identity: checkbox + title, then the metadata on its own line, and
     the row grows rather than the font shrinking. The title keeps flex:1 1 auto
     (not 100%) so it shares line one with the checkbox: giving it the whole line
     left every row as a lone checkbox above a stranded title, and the list read as
     a stack of stray rings. The metadata is indented to the title's own left edge
     (caret 20 + gap 12 + box 20 + gap 12) so the second line hangs off the title
     instead of drifting back under the checkbox column. */
  .td-row{flex-wrap:wrap;min-height:56px;padding:4px 12px;row-gap:2px}
  .td-row-title{flex:1 1 auto;min-width:0;order:1}
  .td-actions{order:1;margin-left:auto}
  .td-meta{order:2;flex:1 1 100%;min-width:0;max-width:100%;justify-content:flex-start;
    padding-left:64px}
}

/* ---------------------------------------------------------------------------
   the settings page (settings.section)

   The plugin owns this page. DSH's own Plugins page only hosts tabs contributed
   by a feature package, and the host settings service on this DSH line has no
   scope API -- so before this page existed the plugin's feishu block had
   nowhere to be filled in, which is precisely what a user reported. Everything
   is sized for the settings panel's content column; nothing here is fixed or
   frame-wide, so no seat marker is needed beyond the token-carrying root. */
.td-set{display:flex;flex-direction:column;gap:16px;max-width:760px;padding:2px 2px 24px;
  color:var(--td-text);font-size:12.5px;line-height:20px}
.td-set-head{display:flex;flex-direction:column;gap:4px}
.td-set-title{margin:0;font-size:14px;font-weight:600;line-height:22px}
.td-set-sub{margin:0;color:var(--td-text-3);font-size:12.5px;font-family:var(--td-mono);
  overflow-wrap:anywhere}
.td-set-banner{padding:8px 12px;border-radius:var(--td-r-md);background:var(--td-soft);
  box-shadow:var(--td-sh-hair);font-size:12.5px}
.td-set-banner.error{color:var(--td-danger)}
.td-set-banner.ok{color:var(--td-text-2)}
.td-set-group{display:flex;flex-direction:column;gap:4px;padding:12px;border-radius:var(--td-r-lg);
  background:var(--td-card);box-shadow:0 0 0 1px var(--td-line)}
.td-set-grouphead{display:flex;flex-direction:column;gap:4px;padding-bottom:2px}
.td-set-grouptitle{font-weight:600;font-size:12.5px}
.td-set-groupdesc{color:var(--td-text-3);font-size:12.5px}
.td-set-row{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:1px solid var(--td-line)}
.td-set-row.first{border-top:0}
.td-set-name{font-weight:500}
.td-set-desc{color:var(--td-text-3);font-size:12.5px}
.td-set-input{width:100%;padding:6px 8px;border:1px solid var(--td-line-2);border-radius:var(--td-r-sm);
  background:var(--td-field);color:var(--td-text);font:inherit;font-size:12.5px}
.td-set-input:focus-visible{outline:2px solid var(--td-accent);outline-offset:1px}
.td-set-input.mono{font-family:var(--td-mono)}
.td-set-checkline{display:flex;align-items:center;gap:8px;cursor:pointer}
.td-set-check{width:15px;height:15px;accent-color:var(--td-accent);margin:0}
.td-set-state{color:var(--td-text-2);font-size:12.5px}
.td-set-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.td-set-btn{padding:6px 12px;border:1px solid var(--td-line-2);border-radius:var(--td-r-sm);
  background:var(--td-card);color:var(--td-text);font:inherit;font-size:12.5px;cursor:pointer}
.td-set-btn:hover:not(:disabled){border-color:var(--td-accent)}
.td-set-btn:disabled{opacity:.55;cursor:default}
.td-set-btn.primary{background:var(--td-accent);border-color:var(--td-accent);color:var(--td-accent-on);
  font-weight:600}
/* The footer is two tiers: the form's own actions, then the Feishu toolbox
   grouped by the direction of the work (check / push / pull). */
.td-set-footer{display:flex;flex-direction:column;gap:8px;padding:12px;
  border-radius:var(--td-r-lg);background:var(--td-soft);box-shadow:var(--td-sh-hair)}
.td-set-footerhead{padding-bottom:8px;border-bottom:1px solid var(--td-line)}
.td-set-hint{flex:1 1 200px;min-width:0;color:var(--td-text-3);font-size:12.5px;line-height:1.6}
.td-set-sync{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.td-set-syncgroup{display:flex;flex-direction:column;gap:8px;min-width:0}
.td-set-synctitle{color:var(--td-text-3);font-size:10.5px;font-weight:600;letter-spacing:.04em}
.td-set-syncgroup .td-set-btn{justify-content:center;text-align:center}
.td-set-report{display:flex;flex-direction:column;gap:4px;padding:12px;border-radius:var(--td-r-lg);
  background:var(--td-soft);box-shadow:var(--td-sh-hair)}
.td-set-reporttitle{font-weight:600;font-size:12.5px}
.td-set-decisions{margin-top:10px;padding-top:10px;border-top:1px solid var(--td-line)}
.td-set-reportline{color:var(--td-text-2);font-size:12.5px;font-family:var(--td-mono);
  overflow-wrap:anywhere}

/* ---- saved appearance variants -----------------------------------------
   All variants use the same components, task data and layout. Only the tokens
   and a small set of surface rules change, so every task operation stays shared. */
.td-seat[data-todo-appearance="flat"]{
  --td-accent:#145df0;--td-brand:var(--td-accent);--td-accent-on:#fff;
  --td-canvas:color-mix(in srgb,var(--dsw-alias-bg-base) 92%,var(--dsw-alias-label-primary));
  --td-card:var(--dsw-alias-bg-base);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-base) 97%,var(--dsw-alias-label-primary));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-base) 99%,var(--dsw-alias-label-primary));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);
  --td-sh-hair:0 0 0 1px var(--td-line);--td-sh-1:none;--td-sh-2:none;--td-sh-3:none;
  --td-r-xl:2px;--td-r-lg:2px;--td-r-md:2px;--td-r-sm:2px}
body[data-ds-dark-theme] .td-seat[data-todo-appearance="flat"]{
  --td-canvas:var(--dsw-alias-bg-base);--td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
.td-seat[data-todo-appearance="flat"] .td-h1{color:var(--td-text);font-size:16px;letter-spacing:-.035em}
.td-seat[data-todo-appearance="flat"] .td-head{background:var(--td-card);border-bottom-color:var(--td-line-2)}
.td-seat[data-todo-appearance="flat"] .td-side.on{background:color-mix(in srgb,var(--td-smart-accent,var(--td-accent)) 10%,var(--td-card));
  box-shadow:none;color:var(--td-text);border-radius:2px}
.td-seat[data-todo-appearance="flat"] .td-side.on .td-glyph{color:var(--td-smart-accent,var(--td-accent))}
.td-seat[data-todo-appearance="flat"] .td-side.on .td-side-n{color:var(--td-accent)}
.td-seat[data-todo-appearance="flat"] .td-headviews{gap:4px;border:0;border-bottom:1px solid var(--td-line-2);border-radius:0}
.td-seat[data-todo-appearance="flat"] .td-headviews>button + button{box-shadow:none}
.td-seat[data-todo-appearance="flat"] .td-headviews>button.on{background:transparent;color:var(--td-text);
  box-shadow:inset 0 -2px 0 var(--td-accent)}
.td-seat[data-todo-appearance="flat"] .td-item{border-radius:0;background:var(--td-card);
  box-shadow:inset 0 -1px 0 var(--td-line);margin-bottom:0}
.td-seat[data-todo-appearance="flat"] .td-item:hover{background:var(--td-hover);box-shadow:inset 0 -1px 0 var(--td-line-2)}
.td-seat[data-todo-appearance="flat"] .td-item.done{background:var(--td-soft);box-shadow:inset 0 -1px 0 var(--td-line)}
.td-seat[data-todo-appearance="flat"] .td-item.done:hover{box-shadow:inset 0 -1px 0 var(--td-line-2)}
.td-seat[data-todo-appearance="flat"] .td-item.cur{background:var(--td-field);
  box-shadow:inset 3px 0 0 var(--td-accent),inset 0 -1px 0 var(--td-line)}
.td-seat[data-todo-appearance="flat"] .td-item.sub{background:transparent;box-shadow:none}
.td-seat[data-todo-appearance="flat"] .td-item.sub:hover{background:var(--td-hover);box-shadow:none}
.td-seat[data-todo-appearance="flat"] .td-chk{border-radius:2px}
.td-seat[data-todo-appearance="flat"] .td-countbadge,
.td-seat[data-todo-appearance="flat"] .td-side-n,
.td-seat[data-todo-appearance="flat"] .td-grp-n,
.td-seat[data-todo-appearance="flat"] .td-chip{border-radius:2px}
.td-seat[data-todo-appearance="flat"] .td-modal,
.td-seat[data-todo-appearance="flat"] .td-pop{border:1px solid var(--td-line-2)}

.td-seat[data-todo-appearance="editorial"]{
  --td-accent:#496f89;--td-brand:var(--td-accent);--td-accent-on:#fff;
  --td-canvas:color-mix(in srgb,var(--dsw-alias-bg-base) 96%,var(--dsw-alias-label-primary));
  --td-card:var(--dsw-alias-bg-base);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,var(--dsw-alias-label-primary));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-base) 98%,var(--dsw-alias-label-primary));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 13%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 23%,transparent);
  --td-warm:#b85e53;--td-teal:#568b83;
  --td-r-xl:8px;--td-r-lg:5px;--td-r-md:3px;--td-r-sm:2px;
  --td-sh-1:none;--td-sh-2:none;--td-sh-3:none;
  --td-serif:ui-serif,Georgia,"Songti SC",STSong,serif}
body[data-ds-dark-theme] .td-seat[data-todo-appearance="editorial"]{
  --td-canvas:var(--dsw-alias-bg-base);--td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);
  --td-accent:color-mix(in srgb,var(--dsw-alias-bg-base) 78%,var(--dsw-alias-label-primary) 22%);
  --td-brand:var(--td-accent)}
.td-seat[data-todo-appearance="editorial"] .td-head{height:60px;padding-inline:22px;
  border-bottom:2px solid var(--td-line-2);background:var(--td-card)}
.td-seat[data-todo-appearance="editorial"] .td-h1,
.td-seat[data-todo-appearance="editorial"] .td-set-title,
.td-seat[data-todo-appearance="editorial"] .td-grp-h,
.td-seat[data-todo-appearance="editorial"] .td-rail-t,
.td-seat[data-todo-appearance="editorial"] .td-style-heading{font-family:var(--td-serif)}
.td-seat[data-todo-appearance="editorial"] .td-h1{font-size:18px;font-weight:500;letter-spacing:.015em}
.td-seat[data-todo-appearance="editorial"] .td-scroll{padding:16px 24px 48px}
.td-seat[data-todo-appearance="editorial"] .td-rail{
  --td-text:var(--td-cream);--td-text-2:var(--td-cream-2);
  --td-text-3:color-mix(in srgb,var(--td-cream-2) 70%,var(--td-ink));
  --td-card:var(--td-ink);--td-soft:color-mix(in srgb,var(--td-ink) 88%,var(--td-cream));
  --td-field:color-mix(in srgb,var(--td-ink) 80%,var(--td-cream));
  --td-line:color-mix(in srgb,var(--td-cream) 13%,transparent);
  --td-line-2:color-mix(in srgb,var(--td-cream) 23%,transparent);
  --td-hover:color-mix(in srgb,var(--td-cream) 8%,transparent);
  --td-hover-2:color-mix(in srgb,var(--td-cream) 14%,transparent);
  border-right:1px solid var(--td-line-2);background:var(--td-ink);color:var(--td-cream)}
.td-seat[data-todo-appearance="editorial"] .td-rail-t{font-size:12.5px;letter-spacing:.04em;color:var(--td-text-2)}
.td-seat[data-todo-appearance="editorial"] .td-side.on{background:color-mix(in srgb,var(--td-accent) 24%,var(--td-ink));
  box-shadow:none;color:var(--td-cream);border-radius:2px}
.td-seat[data-todo-appearance="editorial"] .td-side.on .td-glyph{color:var(--td-cream)}
.td-seat[data-todo-appearance="editorial"] .td-side-n{background:var(--td-hover);color:var(--td-text-3)}
.td-seat[data-todo-appearance="editorial"] .td-lcfg{color:var(--td-text-2)}
.td-seat[data-todo-appearance="editorial"] .td-grp-h{font-size:14px;letter-spacing:.025em}
.td-seat[data-todo-appearance="editorial"] .td-grp-h::after{background:var(--td-line-2)}
.td-seat[data-todo-appearance="editorial"] .td-item{border-radius:0;background:transparent;
  box-shadow:inset 0 -1px 0 var(--td-line);margin-bottom:0}
.td-seat[data-todo-appearance="editorial"] .td-item:hover{background:var(--td-hover);box-shadow:inset 0 -1px 0 var(--td-line-2)}
.td-seat[data-todo-appearance="editorial"] .td-item.done{background:transparent;box-shadow:inset 0 -1px 0 var(--td-line)}
.td-seat[data-todo-appearance="editorial"] .td-item.done:hover{box-shadow:inset 0 -1px 0 var(--td-line-2)}
.td-seat[data-todo-appearance="editorial"] .td-item.cur{background:var(--td-hover);box-shadow:inset 2px 0 0 var(--td-accent),inset 0 -1px 0 var(--td-line)}
.td-seat[data-todo-appearance="editorial"] .td-item.sub{background:transparent;box-shadow:none}
.td-seat[data-todo-appearance="editorial"] .td-item.sub:hover{background:var(--td-hover);box-shadow:none}
.td-seat[data-todo-appearance="editorial"] .td-modal{border:1px solid var(--td-line-2);box-shadow:none}
.td-seat[data-todo-appearance="editorial"] .td-set-title{font-size:18px;font-weight:500}
.td-seat[data-todo-appearance="editorial"] .td-set-group{border-radius:var(--td-r-md);box-shadow:none;border:1px solid var(--td-line)}
.td-seat[data-todo-appearance="editorial"] .td-btn,
.td-seat[data-todo-appearance="editorial"] .td-icon,
.td-seat[data-todo-appearance="editorial"] .td-in{transition-duration:.12s}

/* The date views and task editor used to keep their rounded, softly filled
   controls after the shell had switched to the approved flatter language. Keep
   their layout intact, but carry the same surface, radius and accent decisions
   all the way into these frequently used details. */
.td-seat[data-todo-appearance="flat"] .td-cal-h{
  gap:12px;padding-bottom:12px;border-bottom:1px solid var(--td-line);flex-wrap:wrap}
.td-seat[data-todo-appearance="flat"] .td-cal-nav{
  gap:4px;padding:0;border-radius:0;border-bottom:1px solid var(--td-line-2);background:transparent}
.td-seat[data-todo-appearance="flat"] .td-cal-navb{border-radius:0;padding:6px 8px}
.td-seat[data-todo-appearance="flat"] .td-viewnav-today{
  color:var(--td-accent);font-weight:600;box-shadow:inset 0 -2px 0 var(--td-accent)}
.td-seat[data-todo-appearance="flat"] .td-cal-title{font-size:18px;letter-spacing:-.025em}
.td-seat[data-todo-appearance="flat"] .td-viewbar-divider,
.td-seat[data-todo-appearance="editorial"] .td-viewbar-divider{
  width:1px;height:18px;flex:none;background:var(--td-line-2)}
.td-seat[data-todo-appearance="flat"] .td-gantt-range{font-size:16px}
.td-seat[data-todo-appearance="flat"] .td-gantt-instruction,
.td-seat[data-todo-appearance="editorial"] .td-gantt-instruction{
  color:var(--td-text-3);font-size:10.5px;white-space:nowrap}
.td-seat[data-todo-appearance="flat"] .td-cal-cell{
  border:1px solid var(--td-line);border-radius:2px;box-shadow:none}
.td-seat[data-todo-appearance="flat"] .td-cal-cell.out{border-color:transparent}
.td-seat[data-todo-appearance="flat"] .td-cal-cell.today{background:var(--td-card);border-color:var(--td-accent)}
.td-seat[data-todo-appearance="flat"] .td-cal-cell.sel{
  background:var(--td-card);box-shadow:inset 3px 0 0 var(--td-accent)}
.td-seat[data-todo-appearance="flat"] .td-cal-task{
  border-left-width:2px;border-radius:2px;background:transparent;padding:4px 8px}
.td-seat[data-todo-appearance="flat"] .td-cal-task:hover{filter:none;background:var(--td-hover)}
.td-seat[data-todo-appearance="flat"] .td-modal-b > * + *{margin-top:8px}
.td-seat[data-todo-appearance="flat"] .td-hero,
.td-seat[data-todo-appearance="flat"] .td-props,
.td-seat[data-todo-appearance="flat"] .td-sect{
  border:1px solid var(--td-line);border-radius:2px;box-shadow:none}
.td-seat[data-todo-appearance="flat"] .td-modal .td-in{
  border:1px solid var(--td-line);border-radius:2px;background:var(--td-card)}
.td-seat[data-todo-appearance="flat"] .td-opt{
  border:1px solid var(--td-line-2);border-radius:2px;background:transparent;box-shadow:none}
.td-seat[data-todo-appearance="flat"] .td-opt.on{
  border-color:var(--td-accent);background:color-mix(in srgb,var(--td-accent) 7%,var(--td-card));
  box-shadow:inset 0 -2px 0 var(--td-accent)}
.td-seat[data-todo-appearance="flat"] .td-gantt-bar{
  height:18px;border-radius:2px;box-shadow:none;opacity:1}
.td-seat[data-todo-appearance="flat"] .td-gantt-bar:hover{filter:brightness(.96);transform:none}
.td-seat[data-todo-appearance="flat"] .td-gantt-bar.done{
  background:color-mix(in srgb,var(--td-text-3) 35%,var(--td-card))}
.td-seat[data-todo-appearance="flat"] .td-gantt-bar.late{background:var(--td-danger)}

.td-seat[data-todo-appearance="editorial"] .td-cal-h{
  gap:16px;padding-bottom:14px;border-bottom:1px solid var(--td-line);flex-wrap:wrap}
.td-seat[data-todo-appearance="editorial"] .td-cal-nav{
  gap:4px;padding:0;border-radius:0;border-bottom:1px solid var(--td-line-2);background:transparent}
.td-seat[data-todo-appearance="editorial"] .td-cal-navb{border-radius:0;padding:6px 8px}
.td-seat[data-todo-appearance="editorial"] .td-viewnav-today{
  color:var(--td-accent);font-weight:600;box-shadow:inset 0 -2px 0 var(--td-accent)}
.td-seat[data-todo-appearance="editorial"] .td-cal-title,
.td-seat[data-todo-appearance="editorial"] .td-gantt-range{
  font-family:var(--td-serif);font-size:18px;font-weight:500;letter-spacing:.01em}
.td-seat[data-todo-appearance="editorial"] .td-cal-grid{gap:8px}
.td-seat[data-todo-appearance="editorial"] .td-cal-cell{
  border:1px solid var(--td-line);border-radius:0;box-shadow:none}
.td-seat[data-todo-appearance="editorial"] .td-cal-cell.out{border-color:transparent}
.td-seat[data-todo-appearance="editorial"] .td-cal-task{
  border-left-width:2px;border-radius:0;background:transparent;padding:4px 8px}
.td-seat[data-todo-appearance="editorial"] .td-cal-task:hover{filter:none;background:var(--td-hover)}
.td-seat[data-todo-appearance="editorial"] .td-hero,
.td-seat[data-todo-appearance="editorial"] .td-props,
.td-seat[data-todo-appearance="editorial"] .td-sect{
  border:1px solid var(--td-line);border-radius:0;box-shadow:none}
.td-seat[data-todo-appearance="editorial"] .td-hero .td-in{
  font-family:var(--td-serif);font-weight:500}
.td-seat[data-todo-appearance="editorial"] .td-opt{
  border:1px solid var(--td-line-2);border-radius:0;background:transparent;box-shadow:none}
.td-seat[data-todo-appearance="editorial"] .td-opt.on{
  border-color:var(--td-accent);background:var(--td-field);box-shadow:inset 0 -2px 0 var(--td-accent)}
.td-seat[data-todo-appearance="editorial"] .td-gantt-bar{
  height:18px;border-radius:0;background:var(--td-accent);box-shadow:none;opacity:.92}
.td-seat[data-todo-appearance="editorial"] .td-gantt-bar:hover{filter:brightness(.94);transform:none}
.td-seat[data-todo-appearance="editorial"] .td-gantt-bar.done{
  background:color-mix(in srgb,var(--td-text-3) 35%,var(--td-card));opacity:1}
.td-seat[data-todo-appearance="editorial"] .td-gantt-bar.late{background:var(--td-danger);opacity:1}

/* ---- playful quest: Duolingo-inspired color, adapted for a real task tool -- */
.td-seat[data-todo-appearance="playful"]{
  font-family:"Mona Sans","Helvetica Neue",system-ui,sans-serif;
  --td-font-display:"Feather Bold","DIN Round Pro","Helvetica Neue",sans-serif;
  --td-accent:#58cc02;--td-brand:#58cc02;--td-accent-on:#24420f;
  --td-canvas:#fff;--td-card:#fff;--td-soft:#f7f7f7;--td-field:#fff;
  --td-text:#3c3c3c;--td-text-2:#777;--td-text-3:#777;
  --td-line:#e5e5e5;--td-line-2:#d7d7d7;
  --td-hover:color-mix(in srgb,#58cc02 8%,transparent);
  --td-hover-2:color-mix(in srgb,#58cc02 14%,transparent);
  --td-danger:#ff4b4b;--td-warn:#ffc800;--td-warm:#ff9600;--td-ok:#58cc02;
  --td-teal:#1cb0f6;--td-violet:#ce82ff;--td-pri-1:#afafaf;--td-pri-2:#ffc800;
  --td-r-xl:22px;--td-r-lg:14px;--td-r-md:14px;--td-r-sm:10px;
  --td-playful-white:#fff;--td-playful-surface:#f7f7f7;
  --td-playful-line:#e5e5e5;--td-playful-line-strong:#d7d7d7;--td-playful-hover-line:#afafaf;
  --td-playful-ink:#3c3c3c;--td-playful-muted:#777;
  --td-playful-pale:#dbf8c5;--td-playful-pale-line:#b6e895;--td-playful-pale-depth:#b6df91;
  --td-playful-pale-text:#28530c;--td-playful-selected:#f5ffe9;
  --td-playful-done:#f1fbe9;--td-playful-done-line:#c2e9a5;--td-playful-done-depth:#a9d886;
  --td-playful-accent-deep:#58a700;--td-playful-accent-hover:#89e219;--td-playful-accent-ink:#24420f;
  --td-playful-danger-line:#ffc4c4;--td-playful-danger-soft-line:#ffd1d1;
  --td-playful-danger-pale:#fff0f0;--td-playful-danger-ink:#b42323;
  --td-playful-danger-depth:#cc3b3b;--td-playful-danger-on:#fff;
  --td-playful-warm-line:#ffd580;--td-playful-warm-pale:#fff1d6;--td-playful-warm-ink:#8a4d00;
  --td-playful-tint-shadow:#3c3c3c;
  --td-playful-depth:#d7d7d7;
  --td-sh-hair:0 0 0 2px #e5e5e5;
  --td-sh-1:0 4px 0 var(--td-playful-depth);
  --td-sh-2:0 6px 0 var(--td-playful-depth),0 10px 18px rgba(60,60,60,.08);
  --td-sh-3:0 8px 0 var(--td-playful-depth),0 16px 28px rgba(60,60,60,.12);
  --td-ease:cubic-bezier(.34,1.56,.64,1)}
body[data-ds-dark-theme] .td-seat[data-todo-appearance="playful"]{
  --td-accent:#89e219;--td-brand:#89e219;--td-accent-on:#1d3210;--td-ok:#89e219;
  --td-canvas:var(--dsw-alias-bg-base);--td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 42%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,var(--dsw-alias-bg-base));
  --td-text:var(--dsw-alias-label-primary);--td-text-2:var(--dsw-alias-label-secondary);
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);
  --td-hover:color-mix(in srgb,#89e219 12%,transparent);
  --td-hover-2:color-mix(in srgb,#89e219 18%,transparent);
  --td-playful-white:var(--dsw-alias-bg-layer-1);--td-playful-surface:var(--td-soft);
  --td-playful-line:var(--td-line);--td-playful-line-strong:var(--td-line-2);--td-playful-hover-line:var(--td-line-2);
  --td-playful-ink:var(--td-text);--td-playful-muted:var(--td-text-2);
  --td-playful-pale:color-mix(in srgb,#89e219 17%,var(--td-card));
  --td-playful-pale-line:color-mix(in srgb,#89e219 40%,var(--td-line));
  --td-playful-pale-depth:#4d712f;--td-playful-pale-text:#d5ffae;
  --td-playful-selected:color-mix(in srgb,#89e219 14%,var(--td-card));
  --td-playful-done:color-mix(in srgb,#89e219 12%,var(--td-card));
  --td-playful-done-line:color-mix(in srgb,#89e219 28%,var(--td-line));
  --td-playful-done-depth:#30441f;
  --td-playful-accent-ink:#1d3210;
  --td-playful-danger-line:#754244;--td-playful-danger-soft-line:#68383a;
  --td-playful-danger-pale:#391f20;--td-playful-danger-ink:#ff9999;--td-playful-danger-depth:#542f31;
  --td-playful-warm-line:#6e4c23;--td-playful-warm-pale:#3b2c1a;--td-playful-warm-ink:#ffd08a;
  --td-playful-tint-shadow:#0d150f;
  --td-playful-depth:#111a14;--td-sh-hair:0 0 0 2px var(--td-line)}
.td-seat[data-todo-appearance="playful"] .td-h1,
.td-seat[data-todo-appearance="playful"] .td-set-title,
.td-seat[data-todo-appearance="playful"] .td-grp-h,
.td-seat[data-todo-appearance="playful"] .td-rail-t,
.td-seat[data-todo-appearance="playful"] .td-style-heading{
  font-family:var(--td-font-display);font-weight:800;letter-spacing:-.01em}
.td-seat[data-todo-appearance="playful"] .td-h1{font-size:20px;line-height:1.2}
.td-seat[data-todo-appearance="playful"] .td-set-title,
.td-seat[data-todo-appearance="playful"] .td-style-heading{font-size:20px}
.td-seat[data-todo-appearance="playful"] .td-grp-h{font-size:14px}
.td-seat[data-todo-appearance="playful"] .td-head{background:var(--td-card);border-bottom:2px solid var(--td-line)}
.td-seat[data-todo-appearance="playful"] .td-rail{
  background:var(--td-soft);border-right:2px solid var(--td-line)}
.td-seat[data-todo-appearance="playful"] .td-rail-t{font-size:12.5px;letter-spacing:.01em}
.td-seat[data-todo-appearance="playful"] .td-side{
  min-height:38px;border:2px solid transparent;border-bottom-width:3px;border-radius:10px;
  font-weight:700;transition:background-color .18s ease,border-color .18s ease,color .18s ease,transform .18s ease}
.td-seat[data-todo-appearance="playful"] .td-side.on{
  background:color-mix(in srgb,var(--td-accent) 17%,var(--td-card));
  border-color:color-mix(in srgb,var(--td-accent) 28%,var(--td-line));
  border-bottom-color:color-mix(in srgb,var(--td-accent) 48%,var(--td-playful-depth));
  color:var(--td-text);box-shadow:0 3px 0 color-mix(in srgb,var(--td-accent) 36%,var(--td-playful-depth))}
.td-seat[data-todo-appearance="playful"] .td-side.on .td-glyph{color:color-mix(in srgb,var(--td-accent) 76%,var(--td-playful-accent-ink))}
.td-seat[data-todo-appearance="playful"] .td-side-n,
.td-seat[data-todo-appearance="playful"] .td-countbadge,
.td-seat[data-todo-appearance="playful"] .td-grp-n{
  border-radius:999px;font-family:var(--td-font-display);font-weight:800}
.td-seat[data-todo-appearance="playful"] .td-head2-tab.on,
.td-seat[data-todo-appearance="playful"] .td-float-tabs>button.on{
  background:var(--td-playful-pale);color:var(--td-playful-pale-text);border-radius:999px;font-weight:800}
body[data-ds-dark-theme] .td-seat[data-todo-appearance="playful"] .td-head2-tab.on,
body[data-ds-dark-theme] .td-seat[data-todo-appearance="playful"] .td-float-tabs>button.on{
  background:color-mix(in srgb,var(--td-playful-accent-hover) 22%,var(--td-card));color:var(--td-playful-pale-text)}
.td-seat[data-todo-appearance="playful"] .td-btn{
  min-height:40px;padding:8px 12px;border:2px solid var(--td-playful-line);border-bottom-width:4px;
  border-radius:10px;background:var(--td-playful-white);color:var(--td-playful-muted);font-family:var(--td-font-display);
  font-size:12.5px;font-weight:800;transition:transform .18s var(--td-ease),background-color .18s ease,
  border-color .18s ease,color .18s ease,box-shadow .18s ease}
.td-seat[data-todo-appearance="playful"] .td-btn:hover:not(:disabled){
  background:var(--td-playful-white);border-color:var(--td-playful-hover-line);color:var(--td-playful-ink);transform:translateY(-1px)}
.td-seat[data-todo-appearance="playful"] .td-btn:active:not(:disabled){
  transform:translateY(3px);border-bottom-width:1px}
.td-seat[data-todo-appearance="playful"] .td-btn.primary{
  background:var(--td-accent);border-color:var(--td-accent);border-bottom-color:var(--td-playful-accent-deep);color:var(--td-playful-accent-ink)}
.td-seat[data-todo-appearance="playful"] .td-btn.primary:hover:not(:disabled){
  background:var(--td-playful-accent-hover);border-color:var(--td-playful-accent-hover);border-bottom-color:var(--td-playful-accent-deep);color:var(--td-playful-accent-ink)}
.td-seat[data-todo-appearance="playful"] .td-btn.ghost{
  background:var(--td-playful-white);border-color:var(--td-playful-line);border-bottom-color:var(--td-playful-depth);color:var(--td-playful-muted)}
.td-seat[data-todo-appearance="playful"] .td-btn.danger{
  color:var(--td-playful-danger-ink);border-color:var(--td-playful-danger-soft-line);border-bottom-color:var(--td-playful-danger-depth);background:var(--td-playful-white)}
.td-seat[data-todo-appearance="playful"] .td-btn.danger-solid{
  background:var(--td-danger);border-color:var(--td-danger);border-bottom-color:var(--td-playful-danger-depth);color:var(--td-playful-danger-on)}
.td-seat[data-todo-appearance="playful"] .td-btn.sm{min-height:34px;padding:4px 8px}
.td-seat[data-todo-appearance="playful"] .td-btn.icon{width:36px;height:36px;padding:0}
.td-seat[data-todo-appearance="playful"] .td-icon{
  border:2px solid var(--td-playful-line);border-bottom-width:4px;border-radius:10px;background:var(--td-playful-white);color:var(--td-playful-muted);
  transition:transform .18s var(--td-ease),background-color .18s ease,border-color .18s ease,color .18s ease}
.td-seat[data-todo-appearance="playful"] .td-icon:hover{
  background:var(--td-playful-surface);border-color:var(--td-playful-hover-line);color:var(--td-playful-ink);transform:translateY(-1px)}
.td-seat[data-todo-appearance="playful"] .td-icon:active{transform:translateY(3px);border-bottom-width:1px}
.td-seat[data-todo-appearance="playful"] .td-send{
  border:2px solid var(--td-accent);border-bottom:4px solid var(--td-playful-accent-deep);border-radius:10px;
  background:var(--td-accent);color:var(--td-playful-accent-ink);transition:transform .18s var(--td-ease),background-color .18s ease}
.td-seat[data-todo-appearance="playful"] .td-send:hover{background:var(--td-playful-accent-hover);filter:none}
.td-seat[data-todo-appearance="playful"] .td-send:active{transform:translateY(3px);border-bottom-width:1px}
.td-seat[data-todo-appearance="playful"] .td-seg{
  padding:4px;border:2px solid var(--td-line);border-radius:14px;background:var(--td-card)}
.td-seat[data-todo-appearance="playful"] .td-seg>button{border-radius:10px;font-weight:700}
.td-seat[data-todo-appearance="playful"] .td-seg>button.on,
.td-seat[data-todo-appearance="playful"] .td-btn.on{
  background:var(--td-playful-pale);border-color:var(--td-playful-pale-line);color:var(--td-playful-pale-text);box-shadow:0 3px 0 var(--td-playful-pale-depth)}
.td-seat[data-todo-appearance="playful"] .td-in,
.td-seat[data-todo-appearance="playful"] .td-set-input{
  border:2px solid var(--td-playful-line);border-radius:10px;background:var(--td-playful-white);padding:8px 12px}
.td-seat[data-todo-appearance="playful"] .td-in:focus,
.td-seat[data-todo-appearance="playful"] .td-set-input:focus{
  border-color:var(--td-teal);box-shadow:0 0 0 3px color-mix(in srgb,var(--td-teal) 20%,transparent)}
.td-seat[data-todo-appearance="playful"] .td-qadd{border-bottom:2px solid var(--td-line);background:var(--td-soft)}
.td-seat[data-todo-appearance="playful"] .td-qadd .td-in{background:var(--td-playful-white)}
.td-seat[data-todo-appearance="playful"] .td-grp-add,
.td-seat[data-todo-appearance="playful"] .td-col-add{
  border:2px solid var(--td-playful-line);border-bottom-width:4px;border-radius:10px;background:var(--td-playful-white);
  color:var(--td-playful-accent-deep);box-shadow:0 2px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-grp-add:hover,
.td-seat[data-todo-appearance="playful"] .td-col-add:hover{background:var(--td-playful-pale);border-color:var(--td-playful-pale-line);color:var(--td-playful-pale-text)}
.td-seat[data-todo-appearance="playful"] .td-item{
  border:2px solid var(--td-playful-line);border-bottom-width:4px;border-radius:14px;
  background:var(--td-playful-white);box-shadow:0 4px 0 var(--td-playful-depth);margin-bottom:10px;
  transition:transform .18s var(--td-ease),background-color .18s ease,border-color .18s ease,box-shadow .18s ease}
.td-seat[data-todo-appearance="playful"] .td-item:hover{
  background:var(--td-hover);border-color:var(--td-playful-depth);box-shadow:0 6px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-item.cur{
  background:var(--td-playful-selected);border-color:var(--td-playful-pale-line);box-shadow:0 4px 0 var(--td-playful-pale-depth),inset 0 0 0 2px var(--td-playful-pale-line)}
.td-seat[data-todo-appearance="playful"] .td-item.done{
  background:var(--td-playful-done);border-color:var(--td-playful-done-line);border-bottom-color:var(--td-playful-done-depth);box-shadow:0 4px 0 var(--td-playful-done-line)}
.td-seat[data-todo-appearance="playful"] .td-item.sub{
  border:0;border-radius:0;background:transparent;box-shadow:none;margin-bottom:0}
.td-seat[data-todo-appearance="playful"] .td-item.sub:hover{background:var(--td-hover);box-shadow:none;transform:none}
.td-seat[data-todo-appearance="playful"] .td-chk{
  border:2px solid var(--td-playful-line);box-shadow:inset 0 0 0 1px var(--td-playful-line);background:var(--td-playful-white)}
.td-seat[data-todo-appearance="playful"] .td-chk:hover{border-color:var(--td-accent);box-shadow:0 2px 0 var(--td-playful-pale-depth);transform:scale(1.04)}
.td-seat[data-todo-appearance="playful"] .td-chk.on{
  background:var(--td-accent);border-color:var(--td-accent);color:var(--td-playful-accent-ink);box-shadow:0 3px 0 var(--td-playful-accent-deep);
  animation:tdPopIn .32s var(--td-ease) both}
.td-seat[data-todo-appearance="playful"] .td-row-title{font-weight:650}
.td-seat[data-todo-appearance="playful"] .td-item.done .td-row-title{color:var(--td-playful-muted)}
.td-seat[data-todo-appearance="playful"] .td-chip{border-radius:999px;border:2px solid var(--td-playful-line);background:var(--td-playful-surface)}
.td-seat[data-todo-appearance="playful"] .td-chip.ok{
  border-color:var(--td-playful-pale-line);background:var(--td-playful-pale);color:var(--td-playful-pale-text)}
.td-seat[data-todo-appearance="playful"] .td-chip.today{
  border-color:var(--td-playful-warm-line);background:var(--td-playful-warm-pale);color:var(--td-playful-warm-ink)}
.td-seat[data-todo-appearance="playful"] .td-chip.late{
  border-color:var(--td-playful-danger-line);background:var(--td-playful-danger-pale);color:var(--td-playful-danger-ink)}
.td-seat[data-todo-appearance="playful"] .td-col{
  border:2px solid var(--td-playful-line);border-bottom-width:4px;border-radius:22px;
  background:var(--td-playful-surface);box-shadow:inset 0 3px 0 var(--td-tint,transparent),0 4px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-col-h{font-family:var(--td-font-display);font-weight:800}
.td-seat[data-todo-appearance="playful"] .td-card{
  border:2px solid var(--td-playful-line);border-bottom-width:4px;border-radius:14px;
  background:var(--td-playful-white);box-shadow:0 4px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-card:hover{
  background:var(--td-hover);border-color:var(--td-playful-depth);box-shadow:0 6px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-cal-cell{
  border:2px solid var(--td-playful-line);border-radius:10px;box-shadow:0 3px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-cal-cell.today{
  border-color:var(--td-accent);background:var(--td-playful-done)}
.td-seat[data-todo-appearance="playful"] .td-cal-cell.sel{
  border-color:var(--td-accent);background:var(--td-playful-pale);box-shadow:0 3px 0 var(--td-playful-pale-depth)}
.td-seat[data-todo-appearance="playful"] .td-cal-task{border-radius:999px;background:var(--td-soft);font-weight:700}
.td-seat[data-todo-appearance="playful"] .td-gantt{
  border:2px solid var(--td-line);border-radius:22px;box-shadow:0 4px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-gantt-hd,
.td-seat[data-todo-appearance="playful"] .td-gantt-row,
.td-seat[data-todo-appearance="playful"] .td-gantt-track{border-bottom-width:2px}
.td-seat[data-todo-appearance="playful"] .td-gantt-bar{
  height:18px;border:2px solid color-mix(in srgb,var(--td-tint,var(--td-accent)) 78%,var(--td-playful-tint-shadow));
  border-radius:999px;box-shadow:0 3px 0 color-mix(in srgb,var(--td-tint,var(--td-accent)) 72%,var(--td-playful-tint-shadow));opacity:1}
.td-seat[data-todo-appearance="playful"] .td-gantt-bar:hover{filter:brightness(1.04);transform:translateY(-1px)}
.td-seat[data-todo-appearance="playful"] .td-gantt-bar.done{
  background:var(--td-playful-pale);border-color:var(--td-playful-pale-line);box-shadow:0 3px 0 var(--td-playful-done-depth)}
.td-seat[data-todo-appearance="playful"] .td-gantt-bar.late{
  background:var(--td-danger);border-color:var(--td-playful-danger-depth);box-shadow:0 3px 0 var(--td-playful-danger-depth)}
.td-seat[data-todo-appearance="playful"] .td-modal-layer{
  background:color-mix(in srgb,var(--td-playful-ink) 36%,transparent);backdrop-filter:blur(4px)}
.td-seat[data-todo-appearance="playful"] .td-modal{
  border:2px solid var(--td-playful-line);border-radius:22px;box-shadow:0 7px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-modal-h{border-bottom:2px solid var(--td-line)}
.td-seat[data-todo-appearance="playful"] .td-modal-f{border-top:2px solid var(--td-line)}
.td-seat[data-todo-appearance="playful"] .td-modal-h{font-family:var(--td-font-display);font-weight:800}
.td-seat[data-todo-appearance="playful"] .td-modal-b{background:var(--td-soft)}
.td-seat[data-todo-appearance="playful"] .td-hero,
.td-seat[data-todo-appearance="playful"] .td-props,
.td-seat[data-todo-appearance="playful"] .td-sect,
.td-seat[data-todo-appearance="playful"] .td-set-group{
  border:2px solid var(--td-line);border-bottom-width:4px;border-radius:14px;
  background:var(--td-card);box-shadow:0 4px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-set-group{padding:16px}
.td-seat[data-todo-appearance="playful"] .td-set-btn{
  min-height:38px;padding:8px 12px;border:2px solid var(--td-playful-line);
  border-bottom:4px solid var(--td-playful-depth);border-radius:10px;
  background:var(--td-playful-white);color:var(--td-playful-muted);
  font-family:var(--td-font-display);font-weight:800;transition:transform .18s var(--td-ease),background-color .18s ease}
.td-seat[data-todo-appearance="playful"] .td-set-btn:hover:not(:disabled){
  border-color:var(--td-playful-hover-line);background:var(--td-playful-surface);transform:translateY(-1px)}
.td-seat[data-todo-appearance="playful"] .td-set-btn:active:not(:disabled){transform:translateY(3px);border-bottom-width:1px}
.td-seat[data-todo-appearance="playful"] .td-set-btn.primary{
  background:var(--td-accent);border-color:var(--td-accent);
  border-bottom-color:var(--td-playful-accent-deep);color:var(--td-playful-accent-ink)}
.td-seat[data-todo-appearance="playful"] .td-style-choice{
  border:2px solid var(--td-playful-line);border-bottom-width:4px;border-radius:14px;
  background:var(--td-playful-white);box-shadow:0 3px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-style-choice.on{
  border-color:var(--td-accent);box-shadow:0 3px 0 var(--td-playful-accent-deep)}
.td-seat[data-todo-appearance="playful"] .td-pop{
  border:2px solid var(--td-line);border-radius:14px;box-shadow:0 6px 0 var(--td-playful-depth)}
.td-seat[data-todo-appearance="playful"] .td-pop button{border-radius:10px;font-weight:700}
.td-seat[data-todo-appearance="playful"] .td-toast{
  border:2px solid var(--td-accent);border-bottom:4px solid var(--td-playful-accent-deep);border-radius:999px;
  background:var(--td-playful-pale);color:var(--td-playful-pale-text);font-family:var(--td-font-display);font-weight:800}
.td-seat[data-todo-appearance="playful"] .td-empty-t{
  font-family:var(--td-font-display);font-size:18px;font-weight:800}
.td-style-mini.td-style-mini-playful{
  --mini-rail:#dbf8c5;--mini-rule:#b6e895;--mini-accent:#58cc02;--mini-ink:#3c3c3c;
  --mini-outline:#e5e5e5;--mini-surface:#fff;--mini-depth:#d7d7d7;--mini-accent-depth:#58a700;
  border:2px solid var(--mini-outline);border-radius:10px;background:var(--mini-surface);box-shadow:0 3px 0 var(--mini-depth)}
body[data-ds-dark-theme] .td-style-mini.td-style-mini-playful{
  --mini-rail:#2b3c23;--mini-rule:#425b34;--mini-accent:#89e219;--mini-ink:#e6efdf;
  --mini-outline:#3b4a3d;--mini-surface:#232324;--mini-depth:#111a14;--mini-accent-depth:#557d2b}
.td-style-mini-playful .td-style-mini-page em{
  height:8px;border-radius:999px;background:var(--mini-accent);box-shadow:0 2px 0 var(--mini-accent-depth)}
/* ---- 方案 C palettes (token-only re-skins) ------------------------------ */
/* The four 方案 C palettes change 23 colour tokens and nothing else: the layout,
   the type ladder, the semantic colours and every component rule stay shared, so
   switching between them can never move a box. Values come from the DESIGN.md
   deliverables, including the TEXT-SAFE overrides -- the brighter prototype hexes
   fail AA on a white label (C2 #E8618C = 3.22, C4 #F2865E = 2.52), so the button
   fill is the "brand-cta" value and the ink on it stays white; the third ink step
   is mixed up from ink-3 to ink-2 so the sheet's small print keeps its measured
   4.5:1 instead of the 3.1 the palette's own "ink-3" only allows at 14px+.
   The ladder below is the theme's own radius set (22 / 18 / 14 / 11). */


.td-seat[data-todo-appearance="c1"]{
  --td-canvas:#fdfbff;--td-card:#fff;--td-soft:#f8f4ff;--td-field:#f2eeff;
  --td-text:#2c2440;--td-text-2:#5f5875;--td-text-3:#726b88;
  --td-line:#f0eaf9;--td-line-2:#e3dbff;
  --td-accent:#5f55d8;--td-accent-on:#fff;--td-brand:#7c74e8;
  --td-r-xl:22px;--td-r-lg:18px;--td-r-md:14px;--td-r-sm:11px;
  --td-sh-hair:0 0 0 1px var(--td-line);--td-sh-1:0 1px 2px rgba(124,116,232,.18);
  --td-sh-2:0 6px 18px -10px rgba(124,116,232,.42);
  --td-sh-3:0 18px 44px -20px rgba(124,116,232,.5)}
/* The palette has no dark sheet of its own: the host keeps the surfaces and the
   palette supplies the inverted fill (brand-3 with the palette ink on it, 6:1 in
   every one of the four), so dark mode is a re-tint, not a second design. */
body[data-ds-dark-theme] .td-seat[data-todo-appearance="c1"]{
  --td-canvas:var(--dsw-alias-bg-base);--td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-text:var(--dsw-alias-label-primary);
  --td-text-2:var(--dsw-alias-label-secondary);
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);
  --td-accent:#a99bff;--td-accent-on:#2c2440;--td-brand:#a99bff;
  --td-sh-1:0 1px 2px rgba(0,0,0,.36);
  --td-sh-2:0 6px 18px -10px rgba(0,0,0,.58);
  --td-sh-3:0 18px 44px -20px rgba(0,0,0,.64)}

.td-seat[data-todo-appearance="c2"]{
  --td-canvas:#fff9fb;--td-card:#fff;--td-soft:#fff3f7;--td-field:#fff0f4;
  --td-text:#3a2530;--td-text-2:#6e5560;--td-text-3:#806873;
  --td-line:#fbeaf1;--td-line-2:#ffdce6;
  --td-accent:#be4470;--td-accent-on:#fff;--td-brand:#e8618c;
  --td-r-xl:22px;--td-r-lg:18px;--td-r-md:14px;--td-r-sm:11px;
  --td-sh-hair:0 0 0 1px var(--td-line);--td-sh-1:0 1px 2px rgba(232,97,140,.18);
  --td-sh-2:0 6px 18px -10px rgba(232,97,140,.42);
  --td-sh-3:0 18px 44px -20px rgba(232,97,140,.5)}
/* The palette has no dark sheet of its own: the host keeps the surfaces and the
   palette supplies the inverted fill (brand-3 with the palette ink on it, 6:1 in
   every one of the four), so dark mode is a re-tint, not a second design. */
body[data-ds-dark-theme] .td-seat[data-todo-appearance="c2"]{
  --td-canvas:var(--dsw-alias-bg-base);--td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-text:var(--dsw-alias-label-primary);
  --td-text-2:var(--dsw-alias-label-secondary);
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);
  --td-accent:#ff9db8;--td-accent-on:#3a2530;--td-brand:#ff9db8;
  --td-sh-1:0 1px 2px rgba(0,0,0,.36);
  --td-sh-2:0 6px 18px -10px rgba(0,0,0,.58);
  --td-sh-3:0 18px 44px -20px rgba(0,0,0,.64)}

.td-seat[data-todo-appearance="c3"]{
  --td-canvas:#fbfffd;--td-card:#fff;--td-soft:#f2fbf7;--td-field:#e9f9f3;
  --td-text:#1f3a33;--td-text-2:#4e6a62;--td-text-3:#5f7a72;
  --td-line:#e8f4ef;--td-line-2:#cdefe4;
  --td-accent:#1f7a64;--td-accent-on:#fff;--td-brand:#2fa98c;
  --td-r-xl:22px;--td-r-lg:18px;--td-r-md:14px;--td-r-sm:11px;
  --td-sh-hair:0 0 0 1px var(--td-line);--td-sh-1:0 1px 2px rgba(47,169,140,.18);
  --td-sh-2:0 6px 18px -10px rgba(47,169,140,.42);
  --td-sh-3:0 18px 44px -20px rgba(47,169,140,.5)}
/* The palette has no dark sheet of its own: the host keeps the surfaces and the
   palette supplies the inverted fill (brand-3 with the palette ink on it, 6:1 in
   every one of the four), so dark mode is a re-tint, not a second design. */
body[data-ds-dark-theme] .td-seat[data-todo-appearance="c3"]{
  --td-canvas:var(--dsw-alias-bg-base);--td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-text:var(--dsw-alias-label-primary);
  --td-text-2:var(--dsw-alias-label-secondary);
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);
  --td-accent:#71d2b9;--td-accent-on:#1f3a33;--td-brand:#71d2b9;
  --td-sh-1:0 1px 2px rgba(0,0,0,.36);
  --td-sh-2:0 6px 18px -10px rgba(0,0,0,.58);
  --td-sh-3:0 18px 44px -20px rgba(0,0,0,.64)}

.td-seat[data-todo-appearance="c4"]{
  --td-canvas:#fffbf8;--td-card:#fff;--td-soft:#fff5ee;--td-field:#fff1ea;
  --td-text:#3b2a23;--td-text-2:#6e564b;--td-text-3:#80695e;
  --td-line:#f8ebe2;--td-line-2:#ffdccb;
  --td-accent:#b2552f;--td-accent-on:#fff;--td-brand:#f2865e;
  --td-r-xl:22px;--td-r-lg:18px;--td-r-md:14px;--td-r-sm:11px;
  --td-sh-hair:0 0 0 1px var(--td-line);--td-sh-1:0 1px 2px rgba(242,134,94,.18);
  --td-sh-2:0 6px 18px -10px rgba(242,134,94,.42);
  --td-sh-3:0 18px 44px -20px rgba(242,134,94,.5)}
/* The palette has no dark sheet of its own: the host keeps the surfaces and the
   palette supplies the inverted fill (brand-3 with the palette ink on it, 6:1 in
   every one of the four), so dark mode is a re-tint, not a second design. */
body[data-ds-dark-theme] .td-seat[data-todo-appearance="c4"]{
  --td-canvas:var(--dsw-alias-bg-base);--td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-text:var(--dsw-alias-label-primary);
  --td-text-2:var(--dsw-alias-label-secondary);
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);
  --td-accent:#ffb394;--td-accent-on:#3b2a23;--td-brand:#ffb394;
  --td-sh-1:0 1px 2px rgba(0,0,0,.36);
  --td-sh-2:0 6px 18px -10px rgba(0,0,0,.58);
  --td-sh-3:0 18px 44px -20px rgba(0,0,0,.64)}

.td-style-mini.td-style-mini-c1{
  --mini-rail:#f2eeff;--mini-rule:#e3dbff;
  --mini-accent:#5f55d8;--mini-ink:#5f5875}
body[data-ds-dark-theme] .td-style-mini.td-style-mini-c1{
  --mini-rail:#332c4d;--mini-rule:#463c66;
  --mini-accent:#a99bff;--mini-ink:#c9c1de}

.td-style-mini.td-style-mini-c2{
  --mini-rail:#fff0f4;--mini-rule:#ffdce6;
  --mini-accent:#be4470;--mini-ink:#6e5560}
body[data-ds-dark-theme] .td-style-mini.td-style-mini-c2{
  --mini-rail:#4a2c38;--mini-rule:#63394a;
  --mini-accent:#ff9db8;--mini-ink:#e6ccd6}

.td-style-mini.td-style-mini-c3{
  --mini-rail:#e9f9f3;--mini-rule:#cdefe4;
  --mini-accent:#1f7a64;--mini-ink:#4e6a62}
body[data-ds-dark-theme] .td-style-mini.td-style-mini-c3{
  --mini-rail:#1f3b34;--mini-rule:#2b5045;
  --mini-accent:#71d2b9;--mini-ink:#c2dcd2}

.td-style-mini.td-style-mini-c4{
  --mini-rail:#fff1ea;--mini-rule:#ffdccb;
  --mini-accent:#b2552f;--mini-ink:#6e564b}
body[data-ds-dark-theme] .td-style-mini.td-style-mini-c4{
  --mini-rail:#4a3226;--mini-rule:#63432f;
  --mini-accent:#ffb394;--mini-ink:#e8d3c7}

@media (prefers-reduced-motion:reduce){
  .td-seat[data-todo-appearance="playful"] *,
  .td-seat[data-todo-appearance="playful"] *::before,
  .td-seat[data-todo-appearance="playful"] *::after{
    animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}

/* ---- appearance picker ------------------------------------------------- */
.td-style-trigger{border:1px solid var(--td-line);color:var(--td-text-2)}
.td-style-trigger:hover{border-color:var(--td-accent);color:var(--td-accent)}
.td-style-modal{width:min(560px,100%);border-radius:var(--td-r-lg)}
.td-style-modal .td-modal-h{padding:16px}
.td-style-title{display:flex;flex-direction:column;gap:4px}
.td-style-kicker{color:var(--td-text-3);font-size:10.5px;letter-spacing:.08em}
.td-style-heading{margin:0;color:var(--td-text);font-size:20px;font-weight:600;line-height:1.3}
.td-style-body{padding:16px}
.td-style-intro{margin:0 0 12px;color:var(--td-text-2);font-size:12.5px;line-height:1.65}
.td-style-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
/* The four palettes are the same kind of choice as the three layouts -- one saved
   value -- but they are a colour decision, so they sit in their own band instead
   of reading as "four more layouts". */
.td-style-group{margin:0 0 8px;color:var(--td-text-3);font-size:10.5px;letter-spacing:.08em}
.td-style-palettes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.td-style-choice{display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;padding:8px;
  border:1px solid var(--td-line-2);border-radius:var(--td-r-md);background:var(--td-card);
  color:var(--td-text);font:inherit;text-align:left;cursor:pointer;
  transition:border-color .15s ease,background-color .15s ease,box-shadow .15s ease}
.td-style-choice:hover:not(:disabled){border-color:var(--td-accent)}
.td-style-choice.on{border-color:var(--td-accent);box-shadow:inset 0 0 0 1px var(--td-accent)}
.td-style-choice:disabled{opacity:.72;cursor:wait}
.td-style-mini{height:72px;display:flex;overflow:hidden;border:1px solid var(--td-line);
  background:var(--td-canvas);--mini-rail:var(--td-card);--mini-rule:var(--td-line-2);
  --mini-accent:var(--td-accent);--mini-ink:var(--td-text-2)}
.td-style-mini-flat{--mini-accent:#145df0}
.td-style-mini-editorial{--mini-rail:var(--td-ink);--mini-rule:var(--td-ink-2);
  --mini-accent:#496f89;--mini-ink:var(--td-cream-2)}
.td-style-mini-rail{width:24%;flex:none;display:flex;flex-direction:column;justify-content:center;gap:8px;
  padding:0 4px;border-right:1px solid var(--mini-rule);background:var(--mini-rail)}
.td-style-mini-rail i{display:block;width:72%;height:3px;background:var(--mini-ink);opacity:.68}
.td-style-mini-rail i:first-child{width:48%;background:var(--mini-accent);opacity:1}
.td-style-mini-page{flex:1;display:flex;flex-direction:column;justify-content:center;gap:8px;padding:0 8px}
.td-style-mini-page b{width:47%;height:6px;background:var(--td-text)}
.td-style-mini-page i{display:block;width:100%;height:1px;background:var(--mini-rule)}
.td-style-mini-page i:nth-of-type(2){width:74%}
.td-style-mini-page em{width:34%;height:6px;margin-top:2px;background:var(--mini-accent)}
.td-style-copy{display:flex;flex-direction:column;gap:4px}
.td-style-copy strong{font-size:12.5px;font-weight:650}
.td-style-copy small{min-height:34px;color:var(--td-text-2);font-size:10.5px;line-height:1.55}
.td-style-state{display:flex;align-items:center;justify-content:center;min-height:25px;padding:4px 8px;
  border:1px solid var(--td-line);border-radius:var(--td-r-sm);color:var(--td-text-2);font-size:10.5px}
.td-style-choice.on .td-style-state{border-color:var(--td-accent);color:var(--td-accent);font-weight:600}
.td-style-error{margin-top:8px;color:var(--td-danger);font-size:12.5px;line-height:1.5}
.td-style-help{margin:12px 0 0;color:var(--td-text-3);font-size:10.5px}
.td-style-modal .td-modal-f{padding:12px 16px}
@media (max-width:480px){
  .td-style-modal .td-modal-h{padding:12px}
  .td-style-body{padding:12px}
  .td-style-options{grid-template-columns:1fr;gap:8px}
  .td-style-palettes{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .td-style-choice{display:grid;grid-template-columns:92px minmax(0,1fr) auto;align-items:center;gap:8px}
  .td-style-palettes .td-style-choice{grid-template-columns:56px minmax(0,1fr);row-gap:4px}
  .td-style-palettes .td-style-state{grid-column:1 / -1}
  .td-style-mini{height:58px}
  .td-style-copy small{min-height:0}
  .td-style-state{padding-inline:4px;font-size:10.5px}
  .td-style-modal .td-modal-f{padding:12px}
}
`

      // ---------------------------------------------------------------------
      // atoms
      // ---------------------------------------------------------------------

      /**
       * The completion control.
       *
       * A done task fills the ring with the success colour and shows a stroked
       * tick, rather than tinting the ring: the fill is the only state in the list
       * that is not a shade of grey, so "already handled" is readable at a glance
       * from across the screen. The tick is an SVG path, not the `✓` character --
       * the character sits on a different baseline and optical weight than the
       * stroke it is meant to match.
       */
      function Check(props) {
        const priority = Number(props.priority ?? 0)
        const size = Number(props.size ?? 0)
        // The celebration is local and one-shot: a burst that outlives its click
        // is noise, and a shared-store flag would have to be cleared by whoever
        // happens to re-render next.
        const [cheer, setCheer] = useState(false)
        const cheerTimer = useRef(null)
        useEffect(() => () => {
          if (cheerTimer.current !== null) clearTimeout(cheerTimer.current)
        }, [])
        const onClick = (event) => {
          event.stopPropagation()
          if (props.disabled === true) return
          if (props.done !== true) {
            setCheer(true)
            if (cheerTimer.current !== null) clearTimeout(cheerTimer.current)
            cheerTimer.current = setTimeout(() => setCheer(false), 820)
          }
          props.onToggle()
        }
        return h('button', {
          type: 'button',
          className: `td-chk${props.done ? ' on' : ''}${priority === 3 && !props.done ? ' p3' : ''}${cheer ? ' ring' : ''}`,
          style: size > 0 ? { width: size, height: size } : null,
          title: props.disabled === true ? '请先恢复任务再修改' : props.done ? '标记为未完成' : '标记完成',
          'aria-label': props.done ? '标记为未完成' : '标记完成',
          'aria-pressed': props.done === true,
          disabled: props.disabled === true,
          onClick,
        }, props.done
          ? h('svg', {
            width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 3.4, strokeLinecap: 'round',
            strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
          }, h('path', { d: 'M20 6L9 17l-5-5' }))
          : null,
        // The sparks live IN the button rather than in a wrapper around it: `.td-chk`
        // is the anchor the rest of the UI looks for, and a wrapper would hide it
        // behind a span nobody else knows about.
        cheer
          ? h('span', { className: 'td-burst', 'aria-hidden': 'true' },
            ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => h('span', {
              key: i,
              className: 'td-spark',
              style: {
                '--a': `${i * 36 + 18}deg`,
                '--d': `${17 + (i % 3) * 6}px`,
                '--t': `${(i % 4) * 45}ms`,
                '--c': i % 2 === 0 ? 'var(--td-ok)' : 'var(--td-warm)',
              },
            })))
          : null)
      }

      // Every colour here goes through the alias block: a raw host token in the
      // JSX is a second palette that the stylesheet's own rules cannot reach.
      const PRIORITY_COLORS = ['transparent', '#8b97a6', '#e0a53c', 'var(--td-danger)']
      const PRIORITY_LABELS = ['无', '低', '中', '高']

      /**
       * The priority modifier, looked up rather than templated.
       *
       * A ` p${n}` template reads the same at runtime but hides all four class
       * names from anything that inspects this file statically -- including
       * `scripts/audit-css.mjs`, whose whole job is to notice a class the
       * stylesheet forgot. Spelling them out keeps that gate honest.
       */
      const PRIORITY_CLASS = ['', ' p1', ' p2', ' p3']
      const priorityClass = (value) => PRIORITY_CLASS[Number(value) || 0] ?? ''

      /**
       * The metadata strip's icons.
       *
       * These are SVG paths rather than the unicode glyphs they replaced
       * (`⟳ ☑ 📝`): an emoji-presentation character renders as a full-colour
       * picture that ignores the theme and sits at a different optical weight
       * from the text beside it, which is exactly what a metadata chip must not
       * do. `currentColor` keeps them on the same token as the chip text.
       */
      const GLYPHS = {
        repeat: 'M4.2 8a4.3 4.3 0 0 1 4.3-4.3h3M9.9 1.8l2 1.9-2 1.9M11.8 8a4.3 4.3 0 0 1-4.3 4.3H4.4M6.1 14.2l-2-1.9 2-1.9',
        note: 'M3 4.2h10M3 8h10M3 11.8h6.4',
        check: 'M3 8.6l3.2 3.2L13 5',
        list: 'M3 4.5h10M3 8h7M3 11.5h7',
        board: 'M2.6 3.4h4.3v9.2H2.6zM9.1 3.4h4.3v5.6H9.1z',
        calendar: 'M2.6 4.4h10.8v9H2.6zM2.6 7.2h10.8M5.4 2.6v2.6M10.6 2.6v2.6',
        gantt: 'M2.6 4.2h4.4M5.4 8h6M3.6 11.8h4.8',
        export: 'M8 2.4v7.2M5.2 6.8L8 9.6l2.8-2.8M2.8 13.4h10.4',
        import: 'M8 10.6V3.4M5.2 6.2L8 3.4l2.8 2.8M2.8 13.4h10.4',
        copy: 'M6.2 2.6h7.2v7.2H6.2zM2.6 6.2v7.2h7.2',
        refresh: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.6v3.2h-3.2',
        send: 'M8 13.4V3.2M3.6 7.6L8 3.2l4.4 4.4',
        plus: 'M8 3.6v8.8M3.6 8h8.8',
        search: 'M10.6 10.6l2.8 2.8M11.6 7.2a4.4 4.4 0 1 1-8.8 0 4.4 4.4 0 0 1 8.8 0z',
        move: 'M2.6 8h6.8M6.6 5.2L9.4 8l-2.8 2.8M12 3.4v9.2',
        popout: 'M9.1 3h4v4M13 3.1 7.7 8.4M10.2 8.2v3.6a1 1 0 0 1-1 1H4.1a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1h3.2',
        dock: 'M2.6 3.2h10.8v9.6H2.6zM5.5 3.2v9.6M12 8H7.8M9.7 6.1 7.8 8l1.9 1.9',
        close: 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2',
        chevron: 'M4.8 6.2L8 9.4l3.2-3.2',
        more: 'M4.2 8h.9M7.6 8h.9M11 8h.9',
        up: 'M8 12.6V4M4.8 7.2L8 4l3.2 3.2',
        down: 'M8 3.4V12M4.8 8.8L8 12l3.2-3.2',
        trash: 'M3.4 4.8h9.2M6.4 4.8V3.4h3.2v1.4M4.9 4.8l.5 8h5.2l.5-8',
        tune: 'M2.5 4h11M2.5 8h11M2.5 12h11M5.5 2.5v3M10.5 6.5v3M6.5 10.5v3',
      }

      function Glyph({ name, size }) {
        const path = GLYPHS[name]
        if (path === undefined) return null
        const px = Number(size ?? 12)
        return h('svg', {
          className: 'td-glyph',
          width: px, height: px, viewBox: '0 0 16 16',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false',
        }, h('path', { d: path }))
      }

      /**
       * The metadata strip shared by list rows and board cards.
       *
       * Priority is deliberately absent: it is already the card's left edge, and
       * saying it twice in a 300px row is noise. The completed-run counter is
       * absent for the same reason -- the dialog is where the history belongs.
       */
      function Meta({ task, today, showList, listName, listColor }) {
        const due = parseDue(task.due)
        const late = !task.done && due !== null && due.date < today
        const isToday = due !== null && due.date === today
        // A FIXED order -- due -> repeat -> subtasks -> list -> note -> tags --
        // because a strip whose order follows "which fields happen to be set"
        // makes the eye re-read every row from scratch. Each entry carries a plain
        // label beside its node so the overflow chip can name what it swallowed.
        const entries = []
        if (due !== null) {
          const label = `${task.due.replace('T', ' ')}${late ? '（已逾期）' : ''}`
          entries.push({
            key: 'due',
            label,
            node: h('span', {
              key: 'due',
              className: `td-chip${late ? ' late' : isToday ? ' today' : ''}`,
              title: label,
            }, fmtDue(task.due, today)),
          })
        }
        if (task.recurrence !== null) {
          entries.push({
            key: 'rec',
            label: recurrenceRuleText(task.recurrence),
            node: h('span', {
              key: 'rec', className: 'td-chip', title: recurrenceRuleText(task.recurrence),
            }, h(Glyph, { key: 'g', name: 'repeat', size: 11 }),
              task.completedCount > 0 ? `${task.completedCount} 次` : '重复'),
          })
        }
        if (task.subtaskTotal > 0) {
          entries.push({
            key: 'sub',
            label: `${task.subtaskDone}/${task.subtaskTotal} 个子任务已完成`,
            node: h('span', {
              key: 'sub',
              className: 'td-chip',
              title: `${task.subtaskDone}/${task.subtaskTotal} 个子任务已完成`,
            }, h(Glyph, { key: 'g', name: 'check', size: 11 }), `${task.subtaskDone}/${task.subtaskTotal}`),
          })
        }
        if (showList === true && listName) {
          entries.push({
            key: 'list',
            label: listName,
            node: h('span', { key: 'list', className: 'td-chip', title: `清单：${listName}` },
              listColor
                ? h('span', { key: 'd', className: 'td-dot', style: { background: listColor, width: 6, height: 6 } })
                : null,
              listName),
          })
        }
        if (task.note && task.note.length > 0) {
          entries.push({
            key: 'note',
            label: '备注',
            node: h('span', {
              key: 'note', className: 'td-chip', title: task.note.slice(0, 300),
            }, h(Glyph, { key: 'g', name: 'note', size: 11 })),
          })
        }
        // A tag that only repeats the list name says nothing the list chip has not
        // said already -- and it says it one slot further right (D07).
        for (const tag of task.tags) {
          if (tag === listName) continue
          entries.push({
            key: `tag-${tag}`,
            label: `#${tag}`,
            node: h('span', { key: `tag-${tag}`, className: 'td-tag' }, `#${tag}`),
          })
        }
        if (entries.length === 0) return null
        // Three slots, then a "+N": the strip is the row's right edge, and an
        // unbounded one is what pushed a long title off a narrow panel. What did
        // not fit is still readable through the overflow chip's tooltip.
        const shown = entries.slice(0, 3)
        const hidden = entries.slice(3)
        return h('span', { className: 'td-meta' },
          ...shown.map((entry) => entry.node),
          hidden.length === 0
            ? null
            : h('span', {
              key: 'more',
              className: 'td-meta-more',
              title: hidden.map((entry) => entry.label).join(' · '),
            }, `+${hidden.length}`))
      }

      /** [kind, label, glyph] for the four views, in the order the rail lists them. */
      const VIEW_KINDS = [
        ['list', '列表', 'list'],
        ['board', '看板', 'board'],
        ['calendar', '日历', 'calendar'],
        ['gantt', '甘特图', 'gantt'],
      ]

      /** The last path segment: the rail shows `tasks.json`, the tooltip the rest. */
      const fileNameOf = (file) => {
        const text = String(file ?? '')
        const parts = text.split(/[\\/]/)
        return parts[parts.length - 1] || text
      }

      function EmptyState({ text, examples }) {
        return h('div', { className: 'td-empty' },
          h('div', { className: 'td-empty-t' }, text),
          examples === true
            ? h('div', { className: 'td-empty-ex' },
              h('div', { className: 'td-empty-l' }, '在下面一行直接输入，例如：'),
              h('div', null, h('code', null, '明天 15:00 交报告 !高 #工作 @紧要')),
              h('div', { className: 'td-empty-gap' }),
              h('div', null, h('code', null, '每周一三五 晨跑')),
              h('div', { className: 'td-empty-gap' }),
              h('div', null, h('code', null, '每月5日 交房租')))
            : null)
      }

      // ---------------------------------------------------------------------
      // the task row (list view) -- recursive, because subtasks nest
      // ---------------------------------------------------------------------

      /**
       * One task in the list view.
       *
       * The card wraps its own subtasks instead of sitting beside them, so a
       * parent and everything under it share one surface and one priority edge.
       * `depth` only changes the styling (`.sub`): the indent itself comes from
       * the `.td-tree` gutter the parent drew, so nesting stays visible no matter
       * how deep it goes.
       */
      function TaskRow(props) {
        const { id, depth, today, byId, collapsed, toggleCollapsed } = props
        const task = byId.get(id)
        if (task === undefined) return null
        // Compact is the floating window's checklist: a name and a checkbox, no
        // chips, no row actions, no subtask tree. The box is a few hundred pixels
        // wide, and a card that shares that width with the metadata wraps to one
        // CJK character per line.
        const compact = props.compact === true
        const inactive = props.inactive === true
        const children = compact ? [] : (props.childrenOf.get(id) ?? [])
        const isCollapsed = collapsed[id] === true
        const isSub = depth > 0

        const caret = children.length > 0 && !compact
          ? h('button', {
            type: 'button',
            className: 'td-treebtn',
            'aria-expanded': isCollapsed !== true,
            'aria-label': isCollapsed ? '展开子任务' : '收起子任务',
            title: isCollapsed ? '展开子任务' : '收起子任务',
            onClick: (event) => { event.stopPropagation(); toggleCollapsed(id) },
          }, h('svg', {
            // Drawn pointing down and rotated by CSS when open, so the arrow and the
            // panel move on the same curve instead of swapping between two glyphs.
            className: `td-caret${isCollapsed ? '' : ' open'}`,
            width: 12, height: 12, viewBox: '0 0 16 16',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': 'true', focusable: 'false',
          }, h('path', { d: GLYPHS.chevron })))
          // A leaf keeps the caret's width so every checkbox in a group lines up.
          : h('span', { className: 'td-treebtn empty', 'aria-hidden': 'true' })

        const rowActions = compact
          ? props.onMoveMenu === undefined
            ? null
            : h('span', { className: 'td-actions td-float-actions' },
              h('button', {
                type: 'button', className: 'td-icon', title: '更多任务操作',
                'aria-label': '更多任务操作',
                onClick: (event) => { event.stopPropagation(); props.onMoveMenu(id, event) },
              }, h(Glyph, { name: 'more', size: 13 })))
          : h('span', { className: 'td-actions' },
            inactive ? null : h('button', {
              type: 'button', className: 'td-icon', title: '添加子任务',
              onClick: (event) => { event.stopPropagation(); props.onAddSubtask(id) },
            }, h(Glyph, { name: 'plus', size: 13 })),
            props.onMoveMenu === undefined ? null : h('button', {
              type: 'button', className: 'td-icon', title: '更多任务操作',
              'aria-label': '更多任务操作',
              onClick: (event) => { event.stopPropagation(); props.onMoveMenu(id, event) },
            }, h(Glyph, { name: 'more', size: 13 })),
            h('button', {
              type: 'button', className: 'td-icon',
              title: props.trashMode === true ? '永久删除任务' : '移入回收站',
              onClick: (event) => {
                event.stopPropagation()
                props.askDelete(id, task.title)
              },
            }, h(Glyph, { name: 'close', size: 13 })))

        const row = h('div', {
          className: 'td-row',
          // The whole row opens the editor, not just the title: a 13px title is a
          // small target, and the nested controls stop propagation themselves.
          onClick: () => props.onOpen(id),
        },
          caret,
          h(Check, { done: task.done, priority: task.priority, disabled: inactive, onToggle: () => props.onToggle(id) }),
          // In compact the tooltip carries the full title, which is what the
          // single truncated line cannot show.
          h('span', { className: 'td-row-title', title: compact ? task.title : '点击查看/编辑' }, task.title),
          compact ? null : h(Meta, {
            task,
            today,
            showList: props.showList,
            listName: props.listName === undefined ? undefined : props.listName(id),
            listColor: props.listColor === undefined ? undefined : props.listColor(id),
          }),
          rowActions,
        )

        const cls = 'td-item' + priorityClass(task.priority)
          + (task.done ? ' done' : '') + (isSub ? ' sub' : '')
          + (props.openId === id ? ' cur' : '')
        // Staggered entrance, capped: forty rows at 30ms each would take longer
        // than the list is worth waiting for, and the eye only reads the first few.
        const style = isSub || props.index === undefined
          ? null
          : { '--td-delay': `${Math.min(props.index, 8) * 30}ms` }

        return h('div', {
          className: cls,
          style,
          'data-row-id': id,
          // Roving tabindex: exactly ONE row is tabbable, and it is the one the
          // keyboard is on. That is what makes the arrow keys a cursor rather
          // than a way to tab through forty rows.
          role: 'treeitem',
          tabIndex: props.focusId === id ? 0 : -1,
          'aria-level': depth + 1,
          'aria-selected': props.openId === id ? 'true' : 'false',
          ...(children.length === 0 ? {} : { 'aria-expanded': isCollapsed ? 'false' : 'true' }),
          onFocus: () => { if (typeof props.onFocusRow === 'function') props.onFocusRow(id) },
        },
          row,
          children.length === 0
            ? null
            // Always rendered, collapsed to zero height: an element that leaves the
            // DOM cannot animate, and the 0fr -> 1fr grid trick animates a height
            // nobody has to measure.
            : h('div', { className: `td-collapse${isCollapsed ? '' : ' open'}` },
              h('div', { className: 'td-clip' },
                h('div', { className: 'td-tree' },
                  ...children.map((childId) => h(TaskRow, {
                    key: childId,
                    id: childId,
                    depth: depth + 1,
                    today,
                    byId,
                    childrenOf: props.childrenOf,
                    collapsed,
                    toggleCollapsed,
                    onToggle: props.onToggle,
                    onOpen: props.onOpen,
                    onAddSubtask: props.onAddSubtask,
                    onMoveMenu: props.onMoveMenu,
                    askDelete: props.askDelete,
                    inactive,
                    trashMode: props.trashMode,
                    showList: props.showList,
                    listName: props.listName,
                    listColor: props.listColor,
                    openId: props.openId,
                    focusId: props.focusId,
                    onFocusRow: props.onFocusRow,
                  }))))),
        )
      }

      // ---------------------------------------------------------------------
      // list view
      // ---------------------------------------------------------------------

      function ListView(props) {
        const { state, groups, byId, childrenOf } = props
        if (groups.length === 0) {
          return h(EmptyState, {
            text: state.query
              ? `没有匹配「${state.query}」的任务。`
              : state.filter === 'done' ? '还没有已完成的任务。'
                : state.filter === 'archive' ? '归档中还没有任务。'
                  : state.filter === 'trash' ? '回收站是空的。' : '这里还没有任务。',
            examples: state.query === '' && state.filter !== 'archive' && state.filter !== 'trash',
          })
        }
        // `td-cmp` is the compact skin the floating window asks for.
        return h('div', {
          className: `td-listwrap${props.compact ? ' td-cmp' : ''}`,
          // The list IS a tree (subtasks nest inside their parent), so it is
          // announced as one -- and the roving tabindex on the rows is what makes
          // the arrow keys a cursor instead of a way to tab through forty rows.
          //
          // The tree itself is the Tab stop until the cursor is on a row. Without
          // this the list was reachable by keyboard only in theory: no row is
          // tabbable before something focuses one, and nothing could focus one with
          // the keyboard, so Tab skipped the whole tree (measured: tabindex null on
          // this element, -1 on all eight rows, i.e. ZERO stops). One stop exists at
          // every moment -- here before the cursor moves, on the cursor row after --
          // which is what the roving-tabindex pattern promises and what
          // verify-client-render now asserts.
          role: 'tree',
          tabIndex: props.focusId === null ? 0 : -1,
          'aria-label': '任务列表',
        }, ...groups.map((group) => h('div', { className: 'td-grp', key: group.key },
          h('div', { className: 'td-grp-h' },
            h('span', null, group.label),
            h('span', { className: 'td-grp-n' }, String(group.ids.length)),
            // The group's own "+": the new task lands in THIS bucket, which is
            // the whole point -- the old path prefilled the global box and let
            // the task fall wherever the parser felt like putting it.
            props.inactive === true || props.onAddHere === undefined || group.seed?.addable !== true
              ? null
              : h('button', {
                type: 'button',
                className: 'td-grp-add',
                title: `在「${group.label}」中添加`,
                'aria-label': `在「${group.label}」中添加`,
                onClick: () => props.onAddHere(group.key),
              }, h(Glyph, { name: 'plus', size: 13 }))),
          ...group.ids.map((id, index) => h(TaskRow, {
            key: id,
            id,
            index,
            depth: 0,
            today: state.today,
            byId,
            childrenOf,
            collapsed: state.collapsed,
            toggleCollapsed: props.toggleCollapsed,
            onToggle: props.onToggle,
            onOpen: props.onOpen,
            onAddSubtask: props.onAddSubtask,
            onMoveMenu: props.onMoveMenu,
            askDelete: props.askDelete,
            inactive: props.inactive,
            trashMode: props.trashMode,
            // Naming the list inline is what makes the "全部任务" and "未安排"
            // buckets readable; inside one list it would repeat the rail.
            showList: props.showList,
            listName: props.listName,
            listColor: props.listColor,
            compact: props.compact,
            openId: props.openId,
            focusId: props.focusId,
            onFocusRow: props.onFocusRow,
          })),
          props.newGroup === group.key
            ? h(InlineAdd, {
              key: 'new',
              seed: group.seed,
              label: `在「${group.label}」中添加任务`,
              onClose: () => props.onAddHere(null),
            })
            : null)))
      }

      // ---------------------------------------------------------------------
      // board view (columns = lists, drag between them)
      // ---------------------------------------------------------------------

      function BoardCard({ id, task, today, dragging, onOpen, onToggle, onDragStart, onDragEnd, onMoveMenu }) {
        return h('div', {
          className: 'td-card' + priorityClass(task.priority)
            + (task.done ? ' done' : '') + (dragging ? ' dragging' : ''),
          draggable: true,
          onDragStart: (event) => {
            // A plain-text payload keeps the drag working even when the drop
            // target is outside this component's React tree.
            try { event.dataTransfer.setData('text/plain', id) } catch { /* some browsers refuse */ }
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
            onDragStart(id)
          },
          onDragEnd,
          onClick: () => onOpen(id),
        },
          h('div', { className: 'td-grow' },
            h('div', { className: 'td-card-t' }, task.title),
            h(Meta, { task, today }),
            ),
          h('div', { className: 'td-card-side' },
            h(Check, { done: task.done, priority: task.priority, size: 20, onToggle: () => onToggle(id) }),
            h('button', {
              type: 'button', className: 'td-icon', title: '移动到其他清单',
              onClick: (event) => { event.stopPropagation(); onMoveMenu(id, event) },
            }, h(Glyph, { name: 'move', size: 13 }))),
        )
      }

      function BoardView(props) {
        const { state, columns, byId, dragId } = props
        if (columns.length === 0) return h(EmptyState, { text: '还没有清单。' })
        return h('div', { className: 'td-board' }, ...columns.map((column) => h('div', {
          key: column.id,
          className: `td-col${props.dropTarget === column.id ? ' drop' : ''}`,
          // The list colour becomes the column's top edge; nothing else tells
          // four otherwise identical columns apart at a glance.
          style: { '--td-tint': column.color },
          onDragOver: (event) => { event.preventDefault(); props.onDragOver(column.id) },
          onDragLeave: () => props.onDragOver(null),
          onDrop: (event) => {
            event.preventDefault()
            const id = dragId ?? (() => { try { return event.dataTransfer.getData('text/plain') } catch { return null } })()
            if (id) props.onDrop(id, column.id)
          },
        },
          h('div', { className: 'td-col-h' },
            h('span', { className: 'td-dot', style: { background: column.color } }),
            h('span', { className: 'td-side-l' }, column.name),
            h('span', { className: 'td-col-n' }, String(column.ids.length)),
            h('span', { className: 'td-grow' }),
            h('button', {
              type: 'button', className: 'td-col-add', title: `在「${column.name}」中新建任务`,
              onClick: (event) => { event.stopPropagation(); props.onAddHere(column.id) },
            }, h(Glyph, { name: 'plus', size: 13 }))),
          h('div', { className: 'td-col-b' },
            // The new-card box is born INSIDE the column. It used to prefill the
            // global capture bar instead, which threw the caret out of the column
            // and made the user scroll back to see what they had just made.
            props.newColumn === column.id
              ? h(InlineAdd, {
                key: 'new',
                className: 'td-col-new',
                seed: column.seed,
                label: `在「${column.name}」中新建任务`,
                placeholder: '回车添加，Esc 取消',
                onClose: () => props.onAddHere(null),
              })
              : null,
            ...column.ids.map((id) => h(BoardCard, {
              key: id,
              id,
              task: byId.get(id),
              today: state.today,
              dragging: dragId === id,
              onOpen: props.onOpen,
              onToggle: props.onToggle,
              onDragStart: props.onDragStart,
              onDragEnd: props.onDragEnd,
              onMoveMenu: props.onMoveMenu,
            })),
            column.ids.length === 0
              ? h('div', {
                className: 'td-col-empty',
                onClick: () => props.onAddHere(column.id),
              }, '拖到这里，或点击新建')
              : null))))
      }

      // ---------------------------------------------------------------------
      // calendar view
      // ---------------------------------------------------------------------

      function CalendarView(props) {
        const { state, byId, view } = props
        const weekStart = Number(state.settings?.weekStart) === 0 ? 0 : 1
        const month = state.calMonth ?? monthOf(state.today)
        const cells = monthGrid(month, weekStart)
        const dayMap = new Map((view.days ?? []).map((d) => [d.date, d.ids]))
        const [y, m] = month.split('-').map(Number)
        const selected = state.day
        const selectedIds = selected === null ? [] : (dayMap.get(selected) ?? [])

        return h('div', null,
          h('div', { className: 'td-cal-h' },
            h('div', { className: 'td-cal-nav' },
              h('button', { type: 'button', className: 'td-cal-navb', title: '上个月', onClick: () => props.onMonth(addMonthsStr(month, -1)) }, '‹'),
              h('button', { type: 'button', className: 'td-cal-navb td-viewnav-today', onClick: () => props.onMonth(monthOf(state.today)) }, '今天'),
              h('button', { type: 'button', className: 'td-cal-navb', title: '下个月', onClick: () => props.onMonth(addMonthsStr(month, 1)) }, '›')),
            h('strong', { className: 'td-cal-title' }, `${y} 年 ${m} 月`),
            h('span', { className: 'td-viewbar-divider', 'aria-hidden': 'true' }),
            h('span', { className: 'td-sub' },
              `本月 ${(view.days ?? []).reduce((sum, d) => sum + d.ids.length, 0)} 项安排`),
            h('span', { className: 'td-grow' }),
            state.counts.overdue > 0
              ? h('span', { className: 'td-chip late' }, `逾期 ${state.counts.overdue}`)
              : null),
          h('div', { className: 'td-cal-grid' },
            ...weekdayHeaders(weekStart).map((name, i) => h('div', { className: 'td-cal-wd', key: `wd-${i}` }, `周${name}`)),
            ...cells.map((cell) => {
              const ids = dayMap.get(cell.date) ?? []
              return h('div', {
                key: cell.date,
                className: `td-cal-cell${cell.inMonth ? '' : ' out'}`
                  + `${selected === cell.date ? ' sel' : ''}${cell.date === state.today ? ' today' : ''}`,
                onClick: () => props.onSelectDay(cell.date),
              },
                h('div', { className: 'td-cal-d' },
                  h('span', null, String(cell.day)),
                  ids.length > 3 ? h('span', { className: 'td-cal-more' }, `+${ids.length - 3}`) : null),
                ...ids.slice(0, 3).map((id) => {
                  const task = byId.get(id)
                  if (task === undefined) return null
                  return h('div', {
                    key: id,
                    className: `td-cal-task${task.done ? ' done' : ''}`,
                    style: { '--td-tint': props.listColor(id) },
                    title: `${task.title}${task.due ? ' · ' + task.due.replace('T', ' ') : ''}`,
                    onClick: (event) => { event.stopPropagation(); props.onOpen(id) },
                  }, task.title)
                }))
            })),
          (view.unscheduled ?? []).length > 0
            ? h('div', { className: 'td-hint', style: { marginTop: 8 } },
              `${view.unscheduled.length} 个任务没有日期，不显示在日历上（可在列表或看板中安排）。`)
            : null,
          selected !== null
            ? h('div', { className: 'td-day' },
              h('div', { className: 'td-day-h' },
                fmtDateFull(selected),
                h('span', { className: 'td-grp-n' }, String(selectedIds.length)),
                h('span', { className: 'td-grow' }),
                h('button', {
                  type: 'button', className: 'td-btn sm',
                  onClick: () => props.onAddOnDay(selected),
                }, '＋ 在这一天添加')),
              h('div', { className: 'td-day-b' },
                selectedIds.length === 0
                  ? h('div', { className: 'td-hint' }, '这一天没有安排。')
                  : h('div', null, ...selectedIds.map((id, index) => h(TaskRow, {
                    key: id,
                    id,
                    index,
                    depth: 0,
                    today: state.today,
                    byId,
                    childrenOf: props.childrenOf,
                    collapsed: state.collapsed,
                    toggleCollapsed: props.toggleCollapsed,
                    onToggle: props.onToggle,
                    onOpen: props.onOpen,
                    onAddSubtask: props.onAddSubtask,
                    askDelete: props.askDelete,
                    showList: props.showList,
                    listName: props.listName,
                    listColor: props.listColor,
                  })))))
            : null)
      }

      // ---------------------------------------------------------------------
      // gantt view
      // ---------------------------------------------------------------------

      function GanttView(props) {
        const { state, byId, view } = props
        const from = view.from
        const to = view.to
        const total = dayIndexOf(to) - dayIndexOf(from) + 1
        const days = []
        for (let i = 0; i < total; i++) days.push(dateFromIndex(dayIndexOf(from) + i))
        // One shared width drives the header, rows, scroll extent, and today line.
        // The wider 44px day cell leaves room for both the date and weekday label;
        // the timeline already owns horizontal scrolling.
        const DAY_WIDTH = 44
        const columns = `repeat(${total}, ${DAY_WIDTH}px)`
        const offset = (date) => dayIndexOf(date) - dayIndexOf(from)
        const todayOffset = offset(state.today)
        const [drag, setDrag] = useState(null)
        const dragRef = useRef(null)
        const didDragRef = useRef(false)
        // The task labels and date timeline scroll independently, but their
        // scrollTop stays paired so each label remains beside its bar row.
        const ganttLeftScrollRef = useRef(null)
        const ganttRightScrollRef = useRef(null)
        const syncGanttVertical = (event, targetRef) => {
          const source = event?.currentTarget
          const target = targetRef.current
          if (source !== null && source !== undefined && target !== null && target !== undefined
            && target.scrollTop !== source.scrollTop) target.scrollTop = source.scrollTop
        }
        const dragDelta = (mode, row, delta) => {
          if (mode === 'move') return delta
          const span = dayIndexOf(row.end) - dayIndexOf(row.start)
          return mode === 'start' ? Math.min(delta, span) : Math.max(delta, -span)
        }
        const beginDrag = (row, mode, event) => {
          event.preventDefault?.()
          event.stopPropagation?.()
          didDragRef.current = false
          const session = {
            id: row.id,
            mode,
            startX: Number(event.clientX) || 0,
            delta: 0,
            pointerId: event.pointerId,
          }
          dragRef.current = session
          setDrag(session)
          const target = event.currentTarget
          if (event.pointerId !== undefined && typeof target?.setPointerCapture === 'function') {
            try { target.setPointerCapture(event.pointerId) } catch { /* pointer may already be released */ }
          }
        }
        const moveDrag = (row, event) => {
          const active = dragRef.current
          if (active === null || active.id !== row.id) return
          if (active.pointerId !== undefined && event.pointerId !== undefined
            && active.pointerId !== event.pointerId) return
          const raw = Math.round((Number(event.clientX) - active.startX) / DAY_WIDTH)
          const delta = dragDelta(active.mode, row, raw)
          if (delta === active.delta) return
          if (delta !== 0) didDragRef.current = true
          const next = { ...active, delta }
          dragRef.current = next
          setDrag(next)
        }
        const dateLike = (value, date) => {
          const parsed = parseDue(value)
          return `${date}${parsed?.time ? `T${parsed.time}` : ''}`
        }
        const shiftedDate = (value, days) => {
          const parsed = parseDue(value)
          return parsed === null ? value : dateLike(value, addDaysStr(parsed.date, days))
        }
        const anchorForRange = (start, end) => {
          const startIndex = dayIndexOf(start)
          const endIndex = dayIndexOf(end)
          if (startIndex >= dayIndexOf(from) && endIndex <= dayIndexOf(to)) return null
          if (endIndex - startIndex + 1 >= total) {
            return dateFromIndex(Math.floor((startIndex + endIndex) / 2) - 11)
          }
          if (startIndex < dayIndexOf(from)) return addDaysStr(start, 7)
          return addDaysStr(end, -30)
        }
        const commitDelta = async (row, mode, delta) => {
          if (delta === 0) return null
          const task = byId.get(row.id)
          if (task === undefined) return null
          const startDate = row.start
          const endDate = row.end
          let nextStart = startDate
          let nextEnd = endDate
          const patch = {}
          if (mode === 'move') {
            if (task.start !== null) patch.start = shiftedDate(task.start, delta)
            if (task.due !== null) patch.due = shiftedDate(task.due, delta)
            nextStart = addDaysStr(startDate, delta)
            nextEnd = addDaysStr(endDate, delta)
          } else {
            const storedStart = parseDue(task.start)
            const storedDue = parseDue(task.due)
            const reversed = storedStart !== null && storedDue !== null
              && storedStart.date > storedDue.date
            const visualStartField = reversed ? 'due' : 'start'
            const visualEndField = reversed ? 'start' : 'due'
            const valueFor = (field, date) => dateLike(task[field] ?? task.start ?? task.due, date)
            if (mode === 'start') {
              nextStart = addDaysStr(startDate, delta)
              if (dayIndexOf(nextStart) > dayIndexOf(endDate)) nextStart = endDate
              patch[visualStartField] = valueFor(visualStartField, nextStart)
              if (task[visualEndField] === null) patch[visualEndField] = valueFor(visualEndField, endDate)
            } else {
              nextEnd = addDaysStr(endDate, delta)
              if (dayIndexOf(nextEnd) < dayIndexOf(startDate)) nextEnd = startDate
              patch[visualEndField] = valueFor(visualEndField, nextEnd)
              if (task[visualStartField] === null) patch[visualStartField] = valueFor(visualStartField, startDate)
            }
          }
          const anchor = anchorForRange(nextStart, nextEnd)
          if (anchor !== null) props.onAnchor(anchor)
          return typeof props.onPatch === 'function' ? await props.onPatch(row.id, patch) : null
        }
        const finishDrag = async (row, event) => {
          const active = dragRef.current
          if (active === null || active.id !== row.id) return
          let delta = active.delta
          if (Number.isFinite(Number(event.clientX))) {
            const raw = Math.round((Number(event.clientX) - active.startX) / DAY_WIDTH)
            delta = dragDelta(active.mode, row, raw)
          }
          dragRef.current = null
          setDrag(null)
          if (delta === 0) return
          event.preventDefault?.()
          event.stopPropagation?.()
          didDragRef.current = true
          await commitDelta(row, active.mode, delta)
        }
        const cancelDrag = (row) => {
          const active = dragRef.current
          if (active === null || active.id !== row.id) return
          dragRef.current = null
          didDragRef.current = false
          setDrag(null)
        }
        const keyboardResize = (row, mode, event) => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
          event.preventDefault?.()
          event.stopPropagation?.()
          const days = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 7 : 1)
          void commitDelta(row, mode, dragDelta(mode, row, days))
        }
        const tickMap = new Map()
        for (const item of view.occurrences ?? []) {
          for (const date of item.dates) {
            if (!tickMap.has(item.id)) tickMap.set(item.id, new Set())
            tickMap.get(item.id).add(date)
          }
        }

        // A month band above the day numbers: over a six-week window the bare
        // day numbers give no clue where one month turns into the next.
        const months = []
        for (const date of days) {
          const key = date.slice(0, 7)
          const last = months[months.length - 1]
          if (last !== undefined && last.key === key) last.span += 1
          else months.push({ key, span: 1, start: months.reduce((n, m) => n + m.span, 0) + 1 })
        }
        const isWeekend = (date) => {
          const jsDay = new Date(`${date}T00:00:00`).getDay()
          return jsDay === 0 || jsDay === 6
        }
        const dayTitle = (date) => `${date} 周${WEEKDAY_CN[new Date(`${date}T00:00:00`).getDay()]}`

        return h('div', null,
          h('div', { className: 'td-cal-h' },
            h('div', { className: 'td-cal-nav' },
              h('button', { type: 'button', className: 'td-cal-navb', onClick: () => props.onAnchor(addDaysStr(from, -21)) }, '‹ 前移三周'),
              h('button', { type: 'button', className: 'td-cal-navb td-viewnav-today', onClick: () => props.onAnchor(state.today) }, '回到今天'),
              h('button', { type: 'button', className: 'td-cal-navb', onClick: () => props.onAnchor(addDaysStr(from, 21)) }, '后移三周 ›')),
            h('strong', { className: 'td-cal-title td-gantt-range' }, `${from} → ${to}`),
            h('span', { className: 'td-viewbar-divider', 'aria-hidden': 'true' }),
            h('span', { className: 'td-sub' }, `${view.rows.length} 条时间线`),
            h('span', { className: 'td-gantt-instruction' }, '拖动条形平移日期，拖动两端调整范围'),
            h('span', { className: 'td-grow' }),
            view.undated.length > 0
              ? h('span', { className: 'td-chip' }, `${view.undated.length} 项无日期未显示`)
              : null),
          view.rows.length === 0
            ? h(EmptyState, { text: '这一时间段内没有可排期的任务（需要开始或截止日期）。' })
            : h('div', { className: 'td-gantt' },
              h('div', {
                className: 'td-gantt-l',
                ref: ganttLeftScrollRef,
                onScroll: (event) => syncGanttVertical(event, ganttRightScrollRef),
              },
                h('div', { className: 'td-gantt-th' }, '任务'),
                ...view.rows.map((row) => h('div', {
                  key: row.id,
                  className: `td-gantt-row${row.done ? ' done' : ''}`,
                  title: byId.get(row.id)?.title ?? '',
                  onClick: () => props.onOpen(row.id),
                },
                  h('span', { className: 'td-dot', style: { background: PRIORITY_COLORS[row.priority] === 'transparent' ? 'var(--td-line-2)' : PRIORITY_COLORS[row.priority] } }),
                  h('span', { className: 'td-gantt-t' }, byId.get(row.id)?.title ?? row.id)))),
              h('div', {
                className: 'td-gantt-r',
                ref: ganttRightScrollRef,
                onScroll: (event) => syncGanttVertical(event, ganttLeftScrollRef),
              },
                h('div', { style: { minWidth: total * DAY_WIDTH, position: 'relative' } },
                  todayOffset >= 0 && todayOffset < total
                    ? h('div', { className: 'td-gantt-now', style: { left: todayOffset * DAY_WIDTH + DAY_WIDTH / 2 - 1 } })
                    : null,
                  h('div', { className: 'td-gantt-hd', style: { gridTemplateColumns: columns, minWidth: total * DAY_WIDTH } },
                    ...months.map((month) => h('div', {
                      key: `m-${month.key}`,
                      className: 'td-gantt-month',
                      style: { gridColumn: `${month.start} / span ${month.span}` },
                    }, `${Number(month.key.slice(0, 4))} 年 ${Number(month.key.slice(5, 7))} 月`)),
                    ...days.map((date) => h('div', {
                      key: date,
                      className: `td-gantt-cell${isWeekend(date) ? ' we' : ''}`
                        + `${date === state.today ? ' today' : ''}`,
                      title: dayTitle(date),
                    },
                      h('div', null, date.slice(8, 10)),
                      h('small', null, `周${WEEKDAY_CN[new Date(`${date}T00:00:00`).getDay()]}`)))),
                  ...view.rows.map((row) => {
                    const task = byId.get(row.id)
                    const startColumn = offset(row.start)
                    const endColumn = offset(row.end)
                    const ticks = [...(tickMap.get(row.id) ?? [])].filter((d) => offset(d) >= 0 && offset(d) < total)
                    const active = drag?.id === row.id ? drag : null
                    let barStart = row.start
                    let barEnd = row.end
                    if (active !== null && active.mode === 'move') {
                      barStart = addDaysStr(barStart, active.delta)
                      barEnd = addDaysStr(barEnd, active.delta)
                    } else if (active !== null && active.mode === 'start') {
                      barStart = addDaysStr(barStart, active.delta)
                      if (dayIndexOf(barStart) > dayIndexOf(barEnd)) barStart = barEnd
                    } else if (active !== null && active.mode === 'end') {
                      barEnd = addDaysStr(barEnd, active.delta)
                      if (dayIndexOf(barEnd) < dayIndexOf(barStart)) barEnd = barStart
                    }
                    let rawStart = offset(barStart)
                    let rawEnd = offset(barEnd)
                    if (endColumn < 0 || startColumn >= total) {
                      if (active === null) return null
                    }
                    if (rawEnd < 0 || rawStart >= total) {
                      // During a long drag, keep the captured bar mounted at the
                      // nearest edge; on release the visible window follows it.
                      if (active === null) return null
                      const width = Math.min(total, Math.max(1, rawEnd - rawStart + 1))
                      if (rawEnd < 0) { rawStart = 0; rawEnd = width - 1 }
                      else { rawStart = total - width; rawEnd = total - 1 }
                    }
                    const startCol = Math.max(0, rawStart)
                    const endCol = Math.min(total - 1, rawEnd)
                    const taskTitle = task?.title ?? row.id
                    const rangeText = barStart === barEnd ? barStart : `${barStart} → ${barEnd}`
                    const handle = (mode) => h('button', {
                      type: 'button',
                      className: mode === 'start'
                        ? 'td-gantt-handle td-gantt-handle-start'
                        : 'td-gantt-handle td-gantt-handle-end',
                      title: `拖动调整「${taskTitle}」${mode === 'start' ? '开始' : '截止'}日期；也可用 ←/→ 微调`,
                      'aria-label': `调整${taskTitle}${mode === 'start' ? '开始' : '截止'}日期`,
                      'aria-keyshortcuts': 'ArrowLeft ArrowRight',
                      onPointerDown: (event) => beginDrag(row, mode, event),
                      onClick: (event) => {
                        event.stopPropagation?.()
                        if (didDragRef.current) { didDragRef.current = false; return }
                        props.onOpen(row.id)
                      },
                      onKeyDown: (event) => keyboardResize(row, mode, event),
                    })
                    return h('div', {
                      className: 'td-gantt-track',
                      key: row.id,
                      // The list colour lives on the TRACK so the bar and the
                      // recurrence ticks inside it share one hue.
                      style: { gridTemplateColumns: columns, minWidth: total * DAY_WIDTH, '--td-tint': props.listColor(row.id) },
                    },
                      ...days.map((date, i) => h('div', {
                        key: `bg-${date}`,
                        className: `td-gantt-bg${isWeekend(date) ? ' we' : ''}`
                          + `${date === state.today ? ' today' : ''}`,
                        style: { gridColumn: `${i + 1} / ${i + 2}` },
                      })),
                      h('div', {
                        className: 'td-gantt-bar'
                          + (barStart === barEnd ? ' ms' : '')
                          + (row.done ? ' done' : '') + (row.overdue ? ' late' : '')
                          + (active !== null && active.delta !== 0 ? ' dragging' : ''),
                        style: { gridColumn: `${startCol + 1} / ${endCol + 2}` },
                        title: `${taskTitle}\n${rangeText}`
                          + (row.recurrence ? `\n${row.recurrence}` : '')
                          + (row.overdue ? '\n已逾期' : '')
                          + '\n拖动条形平移日期；拖动两端调整范围',
                        onPointerDown: (event) => beginDrag(row, 'move', event),
                        onPointerMove: (event) => moveDrag(row, event),
                        onPointerUp: (event) => finishDrag(row, event),
                        onPointerCancel: () => cancelDrag(row),
                        onClick: (event) => {
                          if (didDragRef.current) {
                            didDragRef.current = false
                            event.stopPropagation?.()
                            return
                          }
                          props.onOpen(row.id)
                        },
                      }, handle('start'), handle('end')),
                      ...ticks.map((date) => h('div', {
                        key: `tick-${date}`,
                        title: `重复：${date}`,
                        style: {
                          gridRow: 1, gridColumn: `${offset(date) + 1} / ${offset(date) + 2}`,
                          alignSelf: 'end', justifySelf: 'center', width: 5, height: 5, marginBottom: 3,
                          borderRadius: '50%', background: 'var(--td-tint,var(--td-text-3))',
                          opacity: 0.75, pointerEvents: 'none',
                        },
                      })))
                  }))))
        )
      }

      // ---------------------------------------------------------------------
      // recurrence editor
      // ---------------------------------------------------------------------

      function RecurrenceEditor({ rule, onChange }) {
        const rec = rule ?? { freq: 'daily', interval: 1, weekdays: null, until: null, count: null }
        const setRule = (patch) => onChange({ ...rec, ...patch })
        const rows = []
        rows.push(h('div', { className: 'td-rowline', key: 'freq' },
          h('select', {
            className: 'td-in',
            value: rule === null ? '' : rec.freq,
            onChange: (event) => {
              const value = event.target.value
              if (value === '') return onChange(null)
              onChange({ ...rec, freq: value })
            },
          },
            h('option', { value: '' }, '不重复'),
            h('option', { value: 'daily' }, '每天'),
            h('option', { value: 'weekly' }, '每周'),
            h('option', { value: 'monthly' }, '每月')),
          rule === null ? null : h('span', { className: 'td-hint' }, '每'),
          rule === null ? null : h('input', {
            className: 'td-in', type: 'number', min: 1, max: 365, style: { width: 60 },
            value: String(rec.interval ?? 1),
            onChange: (event) => setRule({ interval: Math.max(1, Number(event.target.value) || 1) }),
          }),
          rule === null ? null : h('span', { className: 'td-hint' },
            rec.freq === 'daily' ? '天' : rec.freq === 'weekly' ? '周' : '个月')))

        if (rule !== null && rec.freq === 'weekly') {
          const selected = Array.isArray(rec.weekdays) ? rec.weekdays : []
          rows.push(h('div', { className: 'td-wd', key: 'wd' }, ...['一', '二', '三', '四', '五', '六', '日'].map((name, index) => {
            // The UI lists Monday first; the engine stores 0 = Sunday.
            const value = (index + 1) % 7
            const on = selected.includes(value)
            return h('button', {
              key: name,
              type: 'button',
              className: on ? 'on' : '',
              onClick: () => {
                const next = on ? selected.filter((w) => w !== value) : [...selected, value].sort((a, b) => a - b)
                setRule({ weekdays: next })
              },
            }, name)
          })))
        }

        if (rule !== null) {
          rows.push(h('div', { className: 'td-rowline', key: 'end' },
            h('select', {
              className: 'td-in',
              value: rec.until ? 'until' : rec.count ? 'count' : 'never',
              onChange: (event) => {
                const value = event.target.value
                if (value === 'never') setRule({ until: null, count: null })
                else if (value === 'until') setRule({ until: rec.until ?? todayStr(), count: null })
                else setRule({ count: rec.count ?? 10, until: null })
              },
            },
              h('option', { value: 'never' }, '一直重复'),
              h('option', { value: 'until' }, '重复到某天'),
              h('option', { value: 'count' }, '重复 N 次后结束')),
            rec.until
              ? h('input', {
                className: 'td-in', type: 'date', value: rec.until,
                onChange: (event) => setRule({ until: event.target.value || null }),
              })
              : null,
            rec.count
              ? h('input', {
                className: 'td-in', type: 'number', min: 1, style: { width: 70 }, value: String(rec.count),
                onChange: (event) => setRule({ count: Math.max(1, Number(event.target.value) || 1) }),
              })
              : null))
          rows.push(h('div', { className: 'td-hint', key: 'sum' }, recurrenceRuleText(rec)))
        }
        rows.push(h('div', { className: 'td-hint', key: 'tip' },
          '完成重复任务时会记一次完成，并把截止时间滚动到下一次；子任务随之重置。'))
        return h('div', null, ...rows)
      }

      // ---------------------------------------------------------------------
      // the task editor drawer
      // ---------------------------------------------------------------------

      function TaskEditor(props) {
        const { task, state, byId, childrenOf, lists } = props
        const [draftTitle, setDraftTitle] = useState(task.title)
        const [draftNote, setDraftNote] = useState(task.note)
        const [newSub, setNewSub] = useState('')
        const [tagDraft, setTagDraft] = useState('')
        const [moveOpen, setMoveOpen] = useState(false)
        // Re-seed the text drafts when the drawer switches to another task.
        useEffect(() => { setDraftTitle(task.title); setDraftNote(task.note); setNewSub('') }, [task.id])

        const parsed = parseDue(task.due)
        const parsedStart = parseDue(task.start)
        // `childrenOf` indexes parent id -> child IDs (the list view walks them by
        // id); the editor needs the tasks themselves.
        const kids = (childrenOf.get(task.id) ?? []).map((childId) => byId.get(childId)).filter((k) => k !== undefined)
        const parent = task.parentId === null ? null : byId.get(task.parentId)
        const completionRecords = Array.isArray(task.completionRecords) ? task.completionRecords : []
        const followUpSource = task.followUpOf === null || task.followUpOf === undefined
          ? null
          : byId.get(task.followUpOf) ?? null
        const relatedFollowUps = [...byId.values()].filter((candidate) => candidate.followUpOf === task.id)
        // The dialog wears its list colour on the top edge and as a dot beside the
        // eyebrow: it is the one fact about the task that is not visible anywhere in
        // the form below, and it is what keeps a card of pure white from reading as
        // a blank page.
        const list = lists.find((l) => l.id === task.listId) ?? null
        const tint = list !== null && typeof list.color === 'string' && list.color !== '' ? list.color : undefined

        const patch = (fields) => props.onPatch(task.id, fields)
        const commitTitle = () => {
          const next = draftTitle.trim()
          if (next === '' ) { setDraftTitle(task.title); return }
          if (next !== task.title) patch({ title: next })
        }
        const commitNote = () => { if (draftNote !== task.note) patch({ note: draftNote }) }

        const setDue = (date, time) => {
          if (date === null || date === '') return patch({ due: null })
          patch({ due: time ? `${date}T${time}` : date })
        }

        // A centred dialog rendered by the overlay seat, not beside the list: it
        // reads identically from the panel and from fullscreen, and it cannot be
        // trapped inside a column that creates a containing block.
        return h('div', {
          className: 'td-seat td-modal-layer',
          'data-todo-appearance': appearanceKey(state.data?.settings),
          role: 'presentation',
          // The backdrop closes; the card stops propagation.
          onClick: props.onClose,
        },
          h('div', {
            className: 'td-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': parent === null ? '任务详情' : '子任务详情',
            style: tint === undefined ? undefined : { '--td-tint': tint },
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-dot', style: { background: tint ?? 'var(--td-line-2)' } }),
              h('span', { className: 'td-modal-kind' }, parent === null ? '任务' : '子任务'),
              parent === null
                ? null
                : h('button', {
                  type: 'button', className: 'td-btn sm', title: '打开父任务',
                  onClick: () => props.onOpen(parent.id),
                }, `↖ ${parent.title.slice(0, 14)}`),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '关闭（Esc）',
                'aria-label': '关闭', onClick: props.onClose,
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b' },
              h('div', { className: 'td-hero' },
                h(Check, { done: task.done, priority: task.priority, onToggle: () => props.onToggle(task.id) }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('input', {
                    className: 'td-in',
                    'aria-label': '任务标题',
                    value: draftTitle,
                    placeholder: '任务标题',
                    onChange: (event) => setDraftTitle(event.target.value),
                    onBlur: commitTitle,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitTitle(); event.target.blur() }
                    },
                  }),
                  h('div', { className: 'td-hint', style: { padding: '5px 10px 0' } }, task.done
                    ? `已完成${task.completedAt ? ' · ' + task.completedAt.replace('T', ' ').slice(0, 16) : ''}`
                    : '未完成 · 回车保存标题'))),

              // The four "properties" read as one block of facts, so they share a
              // two-column grid; everything below is prose-ish and gets a section.
              h('div', { className: 'td-props' },
                h('div', { className: 'td-field' },
                  h('label', null, '清单'),
                  h('select', {
                    className: 'td-in',
                    value: task.listId,
                    onChange: (event) => patch({ listId: event.target.value }),
                  }, ...lists.map((l) => h('option', { key: l.id, value: l.id }, l.name)))),

                h('div', { className: 'td-field' },
                  h('label', null, '优先级'),
                  // Listed highest first, because "how urgent is this" is a question
                  // about degree and the eye reads the answer from the top down.
                  h('div', { className: 'td-opts' }, ...[3, 2, 1, 0].map((p) => h('button', {
                    key: p,
                    type: 'button',
                    className: `td-opt${task.priority === p ? ' on' : ''}`,
                    onClick: () => patch({ priority: p }),
                  },
                    h('span', { className: 'td-ind' }, h('svg', {
                      width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
                      stroke: 'currentColor', strokeWidth: 3.6, strokeLinecap: 'round',
                      strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
                    }, h('path', { d: 'M20 6L9 17l-5-5' }))),
                    p === 0
                      ? null
                      : h('span', { className: 'td-opt-dot', style: { background: PRIORITY_COLORS[p] } }),
                    h('span', null, PRIORITY_LABELS[p]))))),

                h('div', { className: 'td-field' },
                  h('label', null, '开始时间'),
                  h('div', { className: 'td-rowline' },
                    h('input', {
                      className: 'td-in', type: 'date', value: parsedStart?.date ?? '',
                      onChange: (event) => {
                        const value = event.target.value
                        if (value === '') patch({ start: null })
                        else patch({ start: parsedStart?.time ? `${value}T${parsedStart.time}` : value })
                      },
                    }),
                    parsedStart?.time
                      ? h('input', {
                        className: 'td-in', type: 'time', value: parsedStart.time,
                        onChange: (event) => patch({ start: `${parsedStart.date}T${event.target.value}` }),
                      })
                      : null,
                    parsedStart === null
                      ? null
                      : h('button', { type: 'button', className: 'td-btn sm', onClick: () => patch({ start: null }) }, '清除'))),

                h('div', { className: 'td-field' },
                  h('label', null, '截止时间'),
                  h('div', { className: 'td-rowline' },
                    h('input', {
                      className: 'td-in', type: 'date', value: parsed?.date ?? '',
                      onChange: (event) => setDue(event.target.value, parsed?.time ?? null),
                    }),
                    h('input', {
                      className: 'td-in', type: 'time', value: parsed?.time ?? '',
                      onChange: (event) => {
                        const value = event.target.value
                        if (value === '') patch({ due: parsed ? parsed.date : null })
                        else setDue(parsed?.date ?? state.today, value)
                      },
                    }),
                    h('button', {
                      type: 'button',
                      className: `td-btn sm${parsed?.time ? ' on' : ''}`,
                      title: '切换为定时/全天',
                      onClick: () => {
                        if (parsed === null) return
                        patch({ due: parsed.time ? parsed.date : `${parsed.date}T09:00` })
                      },
                    }, parsed?.time ? '定时' : '全天'),
                    parsed === null
                      ? null
                      : h('button', { type: 'button', className: 'td-btn sm', onClick: () => patch({ due: null }) }, '清除')))),

              task.recurrence !== null && parsed !== null
                ? h('div', { className: 'td-hint', style: { paddingTop: 8 } },
                  `重复系列锚点：${task.seriesAnchor ?? parsed.date}（改动截止时间会重新锚定系列）`)
                : null,

              h('div', { className: 'td-sect' },
                h('label', null, '重复'),
                h(RecurrenceEditor, { rule: task.recurrence, onChange: (rule) => patch({ recurrence: rule }) }),
                task.recurrence !== null
                  ? h('div', { className: 'td-rowline', style: { marginTop: 8 } },
                    h('span', { className: 'td-hint' }, `已完成 ${task.completedCount} 次`),
                    h('button', {
                      type: 'button', className: 'td-btn sm', title: '跳过本次，直接滚动到下一次',
                      onClick: () => props.onSkip(task.id),
                    }, '跳过本次'))
                  : null),

              h('div', { className: 'td-sect' },
                h('label', null, '备注'),
                h('textarea', {
                  className: 'td-in td-ta',
                  value: draftNote,
                  placeholder: '任何补充信息。任务和子任务都可以写备注。',
                  onChange: (event) => setDraftNote(event.target.value),
                  onBlur: commitNote,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commitNote()
                  },
                })),

              task.done || completionRecords.length > 0
                ? h('div', { className: 'td-sect' },
                  h('label', null, '完成记录'),
                  completionRecords.length === 0
                    ? h('div', { className: 'td-hint' }, '此任务没有完成情况记录（可能是旧数据，或通过未填写记录的方式完成）。')
                    : h('div', null, ...[...completionRecords].reverse().map((record, index) => {
                      const followUp = record.followUpTaskId === null
                        ? null
                        : byId.get(record.followUpTaskId) ?? null
                      return h('div', {
                        key: `completion-${index}`,
                        style: { padding: '8px 0', borderBottom: index === completionRecords.length - 1 ? 0 : '1px solid var(--td-line-2)' },
                      },
                        h('div', { className: 'td-rowline', style: { justifyContent: 'space-between' } },
                          h('span', { className: 'td-hint' },
                            String(record.at ?? '').replace('T', ' ').slice(0, 16) || '完成时间未知'),
                          followUp === null
                            ? null
                            : h('button', {
                              type: 'button', className: 'td-btn sm',
                              onClick: () => props.onOpen(followUp.id),
                            }, '打开跟进任务')),
                        h('div', {
                          className: 'td-hint',
                          style: { paddingTop: 5, whiteSpace: 'pre-wrap', color: 'var(--td-text-2)' },
                        }, String(record.summary ?? '').trim() || '未填写完成情况（已跳过）'))
                    })))
                : null,

              followUpSource !== null || relatedFollowUps.length > 0
                ? h('div', { className: 'td-sect' },
                  h('label', null, '关联跟进'),
                  followUpSource === null
                    ? null
                    : h('div', { className: 'td-rowline', style: { marginBottom: relatedFollowUps.length > 0 ? 8 : 0 } },
                      h('span', { className: 'td-hint' }, '来源任务'),
                      h('button', {
                        type: 'button', className: 'td-btn sm',
                        onClick: () => props.onOpen(followUpSource.id),
                      }, `↖ ${followUpSource.title}`)),
                  relatedFollowUps.length === 0
                    ? null
                    : h('div', null, ...relatedFollowUps.map((followUp) => h('div', {
                      key: followUp.id, className: `td-sub-row${followUp.done ? ' done' : ''}`,
                    },
                      h('span', {
                        className: 'td-t', title: '打开跟进任务', onClick: () => props.onOpen(followUp.id),
                      }, followUp.title),
                      h('span', { className: 'td-chip' }, followUp.done ? '已完成' : (fmtDue(followUp.due, state.today) || '未安排')),
                      h('button', {
                        type: 'button', className: 'td-btn sm',
                        onClick: () => props.onOpen(followUp.id),
                      }, '打开')))))
                : null,

              h('div', { className: 'td-sect' },
                h('label', null, `子任务 ${kids.length > 0 ? `(${kids.filter((k) => k.done).length}/${kids.length})` : ''}`),
                kids.length === 0
                  ? null
                  : h('div', null, ...kids.map((kid) => h('div', { className: `td-sub-row${kid.done ? ' done' : ''}`, key: kid.id },
                    h(Check, { done: kid.done, priority: kid.priority, onToggle: () => props.onToggle(kid.id) }),
                    h('span', { className: 'td-t', onClick: () => props.onOpen(kid.id), title: '点击编辑（含备注）' }, kid.title),
                    kid.note ? h('span', { className: 'td-chip', title: kid.note.slice(0, 200) }, h(Glyph, { name: 'note', size: 11 })) : null,
                    h('button', {
                      type: 'button', className: 'td-icon', title: '删除子任务',
                      onClick: () => props.askDelete(kid.id, kid.title),
                    }, h(Glyph, { name: 'close', size: 12 }))))),
                h('div', { className: 'td-rowline', style: { marginTop: 6 } },
                  h('input', {
                    className: 'td-in', style: { flex: 1 }, value: newSub,
                    placeholder: '添加子任务，回车确认',
                    onChange: (event) => setNewSub(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return
                      const value = newSub.trim()
                      if (!value) return
                      setNewSub('')
                      props.onAddSubtask(task.id, value)
                    },
                  }),
                  h('button', {
                    type: 'button', className: 'td-btn',
                    onClick: () => {
                      const value = newSub.trim()
                      if (!value) return
                      setNewSub('')
                      props.onAddSubtask(task.id, value)
                    },
                  }, '添加'))),

              h('div', { className: 'td-sect' },
                h('label', null, '标签'),
                h('div', { className: 'td-rowline' },
                  ...task.tags.map((tag) => h('span', { className: 'td-chip', key: tag },
                    `#${tag}`,
                    h('button', {
                      type: 'button', className: 'td-icon', style: { width: 18, height: 18, marginLeft: 2 },
                      title: `移除标签 ${tag}`,
                      onClick: () => patch({ tags: task.tags.filter((x) => x !== tag) }),
                    }, h(Glyph, { name: 'close', size: 10 })))),
                  h('input', {
                    className: 'td-in', style: { width: 110 }, value: tagDraft, placeholder: '输入后回车',
                    onChange: (event) => setTagDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return
                      const value = tagDraft.trim().replace(/^#/, '')
                      if (!value || task.tags.includes(value)) { setTagDraft(''); return }
                      setTagDraft('')
                      patch({ tags: [...task.tags, value] })
                    },
                  }))),

              h('div', { className: 'td-sect' },
                h('label', null, '挂到其他任务下（成为子任务）'),
                h('div', { className: 'td-rowline' },
                  h('button', {
                    type: 'button', className: 'td-btn sm', onClick: () => setMoveOpen(!moveOpen),
                  }, moveOpen ? '收起' : '选择父任务'),
                  task.parentId === null
                    ? null
                    : h('button', {
                      type: 'button', className: 'td-btn sm', onClick: () => patch({ parentId: null }),
                    }, '提升为顶层任务')),
                moveOpen
                  ? h('div', { className: 'td-pop', style: { position: 'relative', maxHeight: 200, overflow: 'auto', marginTop: 6 } },
                    ...byId.size === 0
                      ? [h('div', { className: 'td-hint', key: 'none' }, '没有其他任务')]
                      : [...byId.values()]
                        .filter((t) => t.id !== task.id && t.parentId === null)
                        .slice(0, 60)
                        .map((t) => h('button', {
                          key: t.id,
                          type: 'button',
                          onClick: () => { setMoveOpen(false); patch({ parentId: t.id }) },
                        }, t.title)))
                  : null),

              h('div', { className: 'td-hint', style: { paddingTop: 16 } },
                `创建于 ${task.createdAt.replace('T', ' ').slice(0, 16)} · 更新于 ${task.updatedAt.replace('T', ' ').slice(0, 16)}`)),

            h('div', { className: 'td-modal-f' },
              h('button', {
                type: 'button', className: 'td-btn danger',
                onClick: () => props.askDelete(task.id, task.title),
              }, '删除任务'),
              h('span', { className: 'td-grow' }),
              h('button', { type: 'button', className: 'td-btn primary', onClick: props.onClose }, '完成'))))
      }

      /** The optional completion note and linked follow-up task form. */
      function CompletionDialog({ task, state, onClose, onComplete }) {
        const draft = state.completionDraft ?? {
          summary: '', followUp: false, followUpTitle: '', followUpDue: '',
        }
        const followUp = draft.followUp === true
        const saving = state.completionSaving === true
        const list = (state.data?.lists ?? []).find((item) => item.id === task.listId) ?? null
        const tint = list?.color ?? 'var(--td-line-2)'
        const close = () => { if (!saving) onClose() }
        const submit = () => { if (!saving) onComplete(task.id, draft) }

        return h('div', {
          className: 'td-seat td-modal-layer',
          'data-todo-appearance': appearanceKey(state.data?.settings),
          role: 'presentation',
          onClick: close,
        },
          h('div', {
            className: 'td-modal td-narrow',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '完成任务',
            style: { '--td-tint': tint },
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-dot', style: { background: tint } }),
              h('span', { className: 'td-modal-kind' }, '完成任务'),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '取消（Esc）',
                'aria-label': '取消', disabled: saving, onClick: close,
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b' },
              h('div', { className: 'td-hero' },
                h('span', { style: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600 } }, task.title)),
              h('div', { className: 'td-sect' },
                h('label', null, '完成情况（选填）'),
                h('textarea', {
                  className: 'td-in td-ta',
                  'aria-label': '完成情况',
                  value: String(draft.summary ?? ''),
                  placeholder: '简要记录成果、提交物或处理结果；留空也可以完成。',
                  maxLength: 20000,
                  disabled: saving,
                  onChange: (event) => patchCompletionDraft({ summary: event.target.value }),
                }),
                h('div', { className: 'td-hint', style: { paddingTop: 6 } },
                  '记录会保存在任务详情中；跳过填写不会阻止完成。')),
              h('div', { className: 'td-sect' },
                h('label', null, '后续跟进'),
                h('div', { className: 'td-rowline' },
                  h('input', {
                    type: 'checkbox',
                    'aria-label': '还需要跟进',
                    checked: followUp,
                    disabled: saving,
                    onChange: (event) => patchCompletionDraft({ followUp: event.target.checked === true }),
                  }),
                  h('span', null, '还需要跟进')),
                followUp
                  ? h('div', { className: 'td-props', style: { marginTop: 12 } },
                    h('div', { className: 'td-field' },
                      h('label', null, '跟进任务标题'),
                      h('input', {
                        className: 'td-in',
                        'aria-label': '跟进任务标题',
                        value: String(draft.followUpTitle ?? ''),
                        disabled: saving,
                        onChange: (event) => patchCompletionDraft({ followUpTitle: event.target.value }),
                      })),
                    h('div', { className: 'td-field' },
                      h('label', null, '跟进截止日期'),
                      h('input', {
                        className: 'td-in', type: 'date',
                        'aria-label': '跟进任务截止日期',
                        value: String(draft.followUpDue ?? ''),
                        disabled: saving,
                        onChange: (event) => patchCompletionDraft({ followUpDue: event.target.value }),
                      })),
                    h('div', { className: 'td-hint', style: { gridColumn: '1 / -1' } },
                      '默认 30 天后，可按实际审批周期调整。跟进任务会保留在当前清单，并关联回本任务。'))
                  : null),
              state.completionError
                ? h('div', { className: 'td-sect', role: 'alert', style: { color: 'var(--td-danger)' } },
                  state.completionError)
                : null),
            h('div', { className: 'td-modal-f' },
              h('button', { type: 'button', className: 'td-btn', disabled: saving, onClick: close }, '取消'),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-btn primary', disabled: saving, onClick: submit,
              }, saving ? '正在保存…' : followUp ? '完成并创建跟进' : '标记完成'))))
      }

      // ---------------------------------------------------------------------
      // the app (shared by the panel host and the fullscreen host)
      // ---------------------------------------------------------------------

      /**
       * The in-page question, drawn by the overlay seat.
       *
       * Same reason as the task dialog: the overlay is frame-wide, so this appears
       * above whichever host asked, and the fullscreen host gets the identical
       * dialog. It is the replacement for window.confirm, which a host may block
       * outright and which can never say what exactly is about to be lost.
       */
      function ConfirmLayer() {
        const state = useApp()
        const request = state.confirm
        if (request === null || request === undefined) return null
        return h('div', {
          className: 'td-seat td-modal-layer',
          'data-todo-appearance': appearanceKey(state.data?.settings),
          role: 'presentation',
          onClick: () => settleConfirm(false),
        },
          h('div', {
            className: 'td-modal',
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-label': request.title,
            style: { width: 'min(420px,100%)' },
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-modal-kind' }, request.title),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '取消（Esc）',
                'aria-label': '取消', onClick: () => settleConfirm(false),
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b' },
              h('div', { className: 'td-hint', style: { fontSize: 12.5, lineHeight: 1.7 } }, request.body)),
            h('div', { className: 'td-modal-f' },
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-btn',
                onClick: () => settleConfirm(false),
              }, '取消'),
              h('button', {
                type: 'button',
                className: `td-btn${request.danger === true ? ' danger-solid' : ' primary'}`,
                onClick: () => settleConfirm(true),
              }, request.ok ?? '确定'))))
      }

      /**
       * The list settings dialog: rename, recolour, reorder, delete.
       *
       * It sits in the overlay seat for exactly the reason the task dialog does --
       * one dialog for both hosts, never trapped inside the rail column -- and it
       * replaces window.prompt, which a host may block outright. That block is why
       * "新建清单" once appeared to do nothing at all.
       *
       * Ordering is offered twice on purpose: the buttons here are precise and
       * keyboard-reachable, the drag in the rail is direct. Both call `moveListTo`.
       */
      function ListEditor({ list, lists, palette, byList, onClose, onDelete }) {
        const [name, setName] = useState(list.name)
        // A mutation replaces every list object, so the draft has to follow the
        // canonical value back or the field would show a stale name after a save.
        useEffect(() => { setName(list.name) }, [list.id, list.name])

        const index = Math.max(0, lists.findIndex((l) => l.id === list.id))
        const current = String(list.color).toLowerCase()
        const preset = Array.isArray(palette) ? palette.map((c) => String(c).toLowerCase()) : []
        // Colours are PICKED FROM THE PALETTE, never typed: a list colour is a
        // label, and a colour wheel turns "file a task" into a branding exercise.
        // A colour that is not in the palette (data from an older version) is
        // still shown first, so it can be kept rather than silently rewritten.
        const swatches = preset.includes(current) ? preset : [current, ...preset]
        const entry = (byList ?? []).find((b) => b.id === list.id)
        const open = Number(entry?.open ?? 0)
        const total = Number(entry?.total ?? 0)
        const isSystem = list.system === true

        const commitName = async () => {
          const value = name.trim()
          if (value === '' || value === list.name) { setName(list.name); return }
          const result = await mutate('updateList', { id: list.id, name: value })
          if (result === null || result === undefined) { setName(list.name); return }
          setName(result.list.name)
          toast(`清单已改名为「${result.list.name}」`)
        }

        const paint = async (color) => {
          if (String(color).toLowerCase() === current) return
          await mutate('updateList', { id: list.id, color })
        }

        const step = (delta) => { moveListTo(list.id, index + delta) }

        return h('div', {
          className: 'td-seat td-modal-layer',
          'data-todo-appearance': appearanceKey(),
          role: 'presentation',
          onClick: onClose,
        },
          h('div', {
            className: 'td-modal td-narrow',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': `清单设置：${list.name}`,
            style: { '--td-tint': list.color },
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-dot', style: { background: list.color } }),
              h('span', { className: 'td-modal-kind' }, '清单'),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '关闭（Esc）',
                'aria-label': '关闭清单设置', onClick: onClose,
              }, h(Glyph, { name: 'close', size: 13 }))),

            h('div', { className: 'td-modal-b' },
              // A section rather than a bare field: on the recessed body every block
              // is a card, and the name is the first of them.
              h('div', { className: 'td-sect' },
                h('label', null, '名称'),
                h('input', {
                  className: 'td-in',
                  autoFocus: true,
                  value: name,
                  'aria-label': '清单名称',
                  placeholder: '清单名称',
                  onChange: (event) => setName(event.target.value),
                  onBlur: commitName,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); event.target.blur() }
                  },
                })),

              h('div', { className: 'td-sect' },
                h('label', null, '颜色'),
                h('div', { className: 'td-swatches' },
                  ...swatches.map((color) => h('button', {
                    key: color,
                    type: 'button',
                    className: `td-swatch${String(color).toLowerCase() === current ? ' on' : ''}`,
                    style: { background: color },
                    title: color,
                    'aria-label': `颜色 ${color}`,
                    onClick: () => paint(color),
                  }))),
                h('div', { className: 'td-hint', style: { paddingTop: 7 } },
                  '点一下即生效。这个颜色出现在清单圆点、看板列顶边、日历胶囊和甘特条上。')),

              h('div', { className: 'td-sect' },
                h('label', null, '位置'),
                h('div', { className: 'td-posline' },
                  h('button', {
                    type: 'button', className: 'td-btn sm', disabled: index === 0,
                    title: '上移一位', onClick: () => step(-1),
                  }, h(Glyph, { name: 'up', size: 12 }), ' 上移'),
                  h('button', {
                    type: 'button', className: 'td-btn sm', disabled: index >= lists.length - 1,
                    title: '下移一位', onClick: () => step(1),
                  }, h(Glyph, { name: 'down', size: 12 }), ' 下移'),
                  h('span', { className: 'td-hint' }, `第 ${index + 1} / ${lists.length} 位`)),
                h('div', { className: 'td-hint', style: { paddingTop: 7 } },
                  '也可以直接在左侧栏拖动清单换位置；顺序同时决定看板里各列的先后。')),

              h('div', { className: 'td-sect' },
                h('label', null, '内容'),
                h('div', { className: 'td-posline' },
                  h('span', { className: 'td-preview' },
                    h('span', { className: 'td-dot', style: { background: list.color } }),
                    h('span', { className: 'td-side-l' }, list.name)),
                  h('span', { className: 'td-hint' }, `${open} 个未完成 · 共 ${total} 个任务`)),
                isSystem
                  ? h('div', { className: 'td-hint', style: { paddingTop: 7 } },
                    '「收集箱」是系统清单：可以改名、换色、挪位置，但不能删除 —— 删掉的清单里的任务都会落到这里。')
                  : null)),

            h('div', { className: 'td-modal-f' },
              isSystem
                ? null
                : h('button', {
                  type: 'button', className: 'td-btn danger',
                  onClick: () => onDelete(list),
                }, h(Glyph, { name: 'trash', size: 12 }), ' 删除清单'),
              h('span', { className: 'td-grow' }),
              h('button', { type: 'button', className: 'td-btn primary', onClick: onClose }, '完成'))))
      }

      /** The appearance picker is a true host-wide overlay so it stays usable in
       *  the panel, fullscreen and float seats without being clipped by any one. */
      function AppearanceDialog() {
        const state = useApp()
        const [busy, setBusy] = useState('')
        const [error, setError] = useState('')
        const current = appearanceKey(state.data?.settings)
        const close = () => setApp({ appearanceOpen: false })
        const choose = async (next) => {
          if (busy !== '') return
          if (next === current) { close(); return }
          setBusy(next)
          setError('')
          try {
            const form = await call('updateSettings', { appearance: next })
            const saved = appearanceKey(form?.values)
            const latest = app.data
            setBusy('')
            setApp({
              ...(latest === null ? {} : {
                data: { ...latest, settings: { ...(latest.settings ?? {}), appearance: saved } },
              }),
              appearanceOpen: false,
            })
            toast('界面风格已保存')
          } catch (e) {
            setError(String(e?.message ?? e))
            setBusy('')
          }
        }
        const miniClassByAppearance = {
          flat: 'td-style-mini-flat',
          editorial: 'td-style-mini-editorial',
          playful: 'td-style-mini-playful',
          c1: 'td-style-mini-c1',
          c2: 'td-style-mini-c2',
          c3: 'td-style-mini-c3',
          c4: 'td-style-mini-c4',
        }
        // Two kinds of choice, one saved value: the first three change the LAYOUT,
        // the four 方案 C palettes only repaint it (`换肤只换皮，不换骨`), so they are
        // listed apart instead of being read as three more layouts.
        const layouts = [
          {
            id: 'flat',
            title: '简洁扁平',
            description: '黑白打底，亮色点题；线条清晰、圆角克制。',
          },
          {
            id: 'editorial',
            title: '杂志编辑',
            description: '沉稳侧栏、衬线标题与细分隔线，保留编辑感。',
          },
          {
            id: 'playful',
            title: '活力闯关',
            description: '明亮绿、圆润卡片与立体按压，轻快但不添加虚构数据。',
          },
        ]
        const palettes = [
          {
            id: 'c1',
            title: '藕粉雾蓝',
            description: '雾紫主色配樱粉点缀，清爽可靠。',
          },
          {
            id: 'c2',
            title: '樱花奶油',
            description: '玫瑰粉配杏色，柔和不刺眼。',
          },
          {
            id: 'c3',
            title: '薄荷奶霜',
            description: '薄荷绿配暖杏，干净正规。',
          },
          {
            id: 'c4',
            title: '蜜桃乌龙',
            description: '蜜桃橘配雾紫，温暖有生活感。',
          },
        ]
        const choice = (option) => h('button', {
          key: option.id,
          type: 'button',
          className: `td-style-choice${current === option.id ? ' on' : ''}`,
          disabled: busy !== '',
          'aria-label': `选择${option.title}界面风格`,
          'aria-pressed': current === option.id ? 'true' : 'false',
          onClick: () => choose(option.id),
        },
          h('span', {
            className: `td-style-mini ${miniClassByAppearance[option.id] ?? miniClassByAppearance.flat}`,
            'aria-hidden': 'true',
          },
            h('span', { className: 'td-style-mini-rail' },
              h('i', null), h('i', null), h('i', null)),
            h('span', { className: 'td-style-mini-page' },
              h('b', null), h('i', null), h('i', null), h('em', null))),
          h('span', { className: 'td-style-copy' },
            h('strong', null, option.title),
            h('small', null, option.description)),
          h('span', { className: 'td-style-state' },
            busy === option.id ? '应用中…' : current === option.id ? '当前使用' : '切换'))
        return h('div', {
          className: 'td-seat td-modal-layer',
          'data-todo-appearance': current,
          role: 'presentation',
          onClick: close,
        },
          h('div', {
            className: 'td-modal td-style-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '界面风格',
            'aria-busy': busy !== '',
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('div', { className: 'td-style-title' },
                h('span', { className: 'td-style-kicker' }, '外观设置'),
                h('h2', { className: 'td-style-heading' }, '界面风格')),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '关闭（Esc）',
                'aria-label': '关闭界面风格设置', onClick: close,
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b td-style-body' },
              h('p', { className: 'td-style-intro' },
                '选择一种待办界面外观。前三种改变版式，后四种主题只换配色、不改结构与字号；点击后会自动保存到本机并立即应用。'),
              h('div', { className: 'td-style-options' }, ...layouts.map(choice)),
              h('p', { className: 'td-style-group' }, '主题配色 · 方案 C'),
              h('div', { className: 'td-style-palettes' }, ...palettes.map(choice)),
              error === '' ? null : h('div', { className: 'td-style-error', role: 'alert' }, error),
              h('p', { className: 'td-style-help' }, '也可在「设置 → 待办任务」中查看和编辑该偏好。')),
            h('div', { className: 'td-modal-f' },
              h('span', { className: 'td-hint' }, '设置保存在本机，不影响任务数据。'),
              h('span', { className: 'td-grow' }),
              h('button', { type: 'button', className: 'td-btn primary', onClick: close }, '完成'))))
      }

      /** One-shot monthly workbook export; the owner draft is never persisted. */
      function PlanExportDialog() {
        const [month, setMonth] = useState(monthOf(todayStr()))
        const [owner, setOwner] = useState('')
        const [modules, setModules] = useState([])
        const [moduleId, setModuleId] = useState('')
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')

        useEffect(() => {
          let live = true
          call('planSheetModules', {}).then((rows) => {
            if (!live) return
            const choices = Array.isArray(rows) ? rows : []
            setModules(choices)
            setModuleId(choices[0]?.id ?? '')
            if (choices.length === 0) setError('当前没有可用的月度计划模板。')
          }).catch((e) => {
            if (live) setError(`读取模板列表失败：${String(e?.message ?? e)}`)
          })
          return () => { live = false }
        }, [])

        const close = () => setApp({ planExportOpen: false })
        const submit = async () => {
          if (busy) return
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { setError('请选择有效月份。'); return }
          if (moduleId === '') { setError('请选择一个模板模块。'); return }
          setBusy(true)
          setError('')
          try {
            const filename = await downloadPlanWorkbook({ moduleId, month, owner })
            setApp({ planExportOpen: false })
            toast(`已下载 ${filename}`)
          } catch (e) {
            setError(String(e?.message ?? e))
          } finally {
            setBusy(false)
          }
        }

        return h('div', {
          className: 'td-seat td-modal-layer',
          'data-todo-appearance': appearanceKey(),
          role: 'presentation',
          onClick: close,
        },
          h('div', {
            className: 'td-modal td-narrow',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '导出月度计划表',
            'aria-busy': busy ? 'true' : 'false',
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-modal-kind' }, '数据导出'),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '关闭（Esc）',
                'aria-label': '关闭月度计划导出', onClick: close,
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b' },
              h('div', { className: 'td-props' },
                h('div', { className: 'td-field' },
                  h('label', null, '模板模块'),
                  h('select', {
                    className: 'td-in',
                    value: moduleId,
                    disabled: busy || modules.length === 0,
                    onChange: (event) => setModuleId(event.target.value),
                  }, ...modules.map((module) => h('option', { key: module.id, value: module.id }, module.label))),
                ),
                h('div', { className: 'td-field' },
                  h('label', null, '计划月份'),
                  h('input', {
                    className: 'td-in', type: 'month', value: month, autoFocus: true,
                    disabled: busy,
                    onChange: (event) => setMonth(event.target.value),
                  })),
                h('div', {
                  className: 'td-field',
                  style: { gridColumn: '1 / -1' },
                },
                  h('label', null, '填写人（可选）'),
                  h('input', {
                    className: 'td-in', type: 'text', value: owner, maxLength: 80,
                    placeholder: '仅用于本次导出，不会保存', disabled: busy,
                    onChange: (event) => setOwner(event.target.value),
                  }))),
              h('div', { className: 'td-sect' },
                h('div', { className: 'td-hint' },
                  '只从本机待办数据生成，不读取飞书。月度目标来自现有「月度目标」清单的顶层任务（最多 5 项）；重复任务历史和缺少完成时间的旧完成记录不会写入。')),
              error === '' ? null : h('div', { className: 'td-sect', role: 'alert' },
                h('div', { className: 'td-hint' }, error))),
            h('div', { className: 'td-modal-f' },
              h('span', { className: 'td-grow' }),
              h('button', { type: 'button', className: 'td-btn', disabled: busy, onClick: close }, '取消'),
              h('button', {
                type: 'button', className: 'td-btn primary', disabled: busy || modules.length === 0,
                onClick: submit,
              }, busy ? '生成中…' : '生成并下载'))))
      }

      function TodoApp({ mode, drag }) {
        const state = useApp()
        // The floating window is the same app: it only drops the rail (the view
        // switcher, the smart lists and the data block), because a small box is
        // there to show the list and nothing else. `drag` is the window's own
        // pointer plumbing, handed to the header, which doubles as its handle.
        const floating = mode === 'float'
        const data = state.data
        const appearance = appearanceKey(data?.settings)
        const [dragId, setDragId] = useState(null)
        const [dropTarget, setDropTarget] = useState(null)
        const [listDragId, setListDragId] = useState(null)
        const [listDropId, setListDropId] = useState(null)
        const [menu, setMenu] = useState(null)
        const [, setTaskActionRevision] = useState(0)
        const [newList, setNewList] = useState('')
        // The search box `/` jumps to, and the subtree the row-focus lookup runs
        // against. Both are per-instance: up to three seats can be mounted, and a
        // shared handle would always point at whichever mounted last.
        const searchRef = useRef(null)
        const myRoot = useRef(null)

        // First mount of any seat loads the shared data.
        useEffect(() => { if (app.data === null && app.loading === false) refresh({}, true) }, [])

        // Entering the task view starts a non-blocking three-way reconciliation.
        // The shared promise/cooldown deduplicates the panel and fullscreen seats;
        // reconnecting while the view is open retries the same safe merge.
        const feishuEnabled = data?.settings?.feishu?.enabled === true
        useEffect(() => {
          if (floating || !feishuEnabled) return undefined
          void requestFeishuEntrySync(false).catch(() => {})
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          const onOnline = () => { void requestFeishuEntrySync(true).catch(() => {}) }
          window.addEventListener('online', onOnline)
          return () => window.removeEventListener('online', onOnline)
        }, [floating, feishuEnabled])

        // Extensions can be installed before or after this client bundle. Subscribe
        // to registration changes so an open task menu updates without a page reload.
        useEffect(() => {
          if (todoTaskActionsApi === null) return undefined
          return todoTaskActionsApi.subscribe(() => setTaskActionRevision((revision) => revision + 1))
        }, [])

        // Composer availability and submit-lock changes do not change the task
        // action registry itself, so mirror those changes into an open menu.
        useEffect(() => {
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          const onComposerChange = () => setTaskActionRevision((revision) => revision + 1)
          window.addEventListener(TODO_COMPOSER_CHANGED_EVENT, onComposerChange)
          return () => window.removeEventListener(TODO_COMPOSER_CHANGED_EVENT, onComposerChange)
        }, [])

        // Opening a seat is the moment to put the caret in the add box: the
        // first thing anyone does with a task list is write something down, and
        // "click the sidebar, then click the box" was a click too many. The
        // request is consumed by CaptureBar, which owns the DOM node.
        useEffect(() => { setApp({ quickFocus: floating ? 'float' : 'panel' }) }, [])

        // Re-query the host whenever the view context changes.
        useEffect(() => {
          if (app.data === null) return
          refresh({}, true)
        }, [state.view, state.filter, state.listId, state.tag, state.includeDone, state.calMonth, state.ganttAnchor])

        // Esc is handled by the overlay seat, which is mounted whether this host is
        // visible or not -- registering it here as well would close the dialog AND
        // leave fullscreen on the same keypress.

        const tasks = data?.tasks ?? []
        const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [data])
        const childrenOf = useMemo(() => {
          const map = new Map()
          for (const t of tasks) {
            if (t.parentId === null) continue
            if (!map.has(t.parentId)) map.set(t.parentId, [])
            map.get(t.parentId).push(t.id)
          }
          return map
        }, [data])
        const listNames = useMemo(() => {
          const map = new Map()
          for (const l of data?.lists ?? []) map.set(l.id, l.name)
          return map
        }, [data])
        const listColors = useMemo(() => {
          const map = new Map()
          for (const l of data?.lists ?? []) map.set(l.id, l.color)
          return map
        }, [data])

        if (data === null) {
          return h('div', {
            className: `td-seat td-root${mode === 'fullscreen' ? ' td-overlay' : ''}${floating ? ' td-floatapp' : ''}`,
            'data-todo-appearance': appearance,
          },
            h('div', { className: 'td-empty' }, state.error === null ? '正在载入待办任务…' : `载入失败：${state.error}`))
        }

        const view = data.view ?? { kind: state.view }
        const groups = view.kind === 'list' ? (view.groups ?? []) : []
        const columns = view.kind === 'board' ? (view.columns ?? []) : []
        const openTask = state.openId === null ? null : byId.get(state.openId)
        const menuTask = menu === null ? null : (byId.get(menu.id) ?? null)
        const menuActions = menuTask === null || todoTaskActionsApi === null
          ? []
          : todoTaskActionsApi.forTask(menuTask).filter((action) => {
            if (action.id === TODO_COPY_TO_DSH_CHAT_ACTION_ID) return floating
            if (action.id === TODO_COPY_TASK_CONTENT_ACTION_ID) {
              return !floating && (view.kind === 'list' || view.kind === 'board')
            }
            return true
          })
        const counts = data.counts

        const common = {
          // The floating window shows the list as a checklist: the same rows, with
          // only the name and the checkbox left in them (see `.td-cmp`).
          compact: mode === 'float',
          // Two different things are called "view" in this app: the app store's
          // `view` is the selected kind ('list' | 'board' | ...), while the host's
          // `data.view` is that view's payload. Views read `props.view` for the
          // payload so the two can never be confused again.
          view,
          state: {
            ...state,
            today: data.today,
            settings: data.settings,
            counts,
            calMonth: state.calMonth,
            day: state.day,
          },
          byId,
          childrenOf,
          // Calendar chips have no column to carry the list, so the list colour is
          // what tells two tasks of the same day apart. Both helpers take a TASK id
          // because that is what every view already has in hand.
          listColor: (id) => {
            const task = byId.get(id)
            const color = task === undefined ? undefined : listColors.get(task.listId)
            return typeof color === 'string' && color !== '' ? color : 'var(--td-brand)'
          },
          listName: (id) => {
            const task = byId.get(id)
            const name = task === undefined ? undefined : listNames.get(task.listId)
            return typeof name === 'string' && name !== '' ? name : undefined
          },
        }

        // The same question the add box asks ("did my syntax land?") is answered by
        // the host, not by a second copy of the parser here: the preview IS what
        // `quickAdd` will do, because it is the same function. Typing is debounced
        // and the reply is dropped unless the text still matches, so a fast typist
        // never sees the parse of a prefix they have already changed.
        //
        // The draft is read from (and the answer written to) the app store rather
        // than this component's state, because the seat that is typing is not
        // always the seat that is mounted.
        useEffect(() => {
          const text = String(state.quick ?? '').trim()
          if (text === '') {
            if (app.qPreview !== null) setApp({ qPreview: null })
            return undefined
          }
          let live = true
          const timer = setTimeout(async () => {
            try {
              const result = await call('preview', { text })
              if (live && result !== null && result !== undefined) setApp({ qPreview: { text, result } })
            } catch { if (live) setApp({ qPreview: null }) }
          }, 180)
          return () => { live = false; clearTimeout(timer) }
        }, [state.quick])

        const inactiveCollection = state.filter === 'archive' || state.filter === 'trash'
        const onToggle = (id) => {
          if (inactiveCollection) return
          const task = byId.get(id)
          if (task === undefined) return
          if (task.done === true) return mutate('toggle', { id, done: false })
          openCompletion(id, task)
        }
        const onOpen = (id) => {
          if (inactiveCollection) { toast('请先恢复归档或回收站任务，再查看和编辑'); return }
          openTaskDetails(id)
        }
        const onDelete = (id) => askDelete(id, byId.get(id)?.title ?? '')
        const onPatch = (id, fields) => inactiveCollection ? null : mutate('update', { id, ...fields })
        const onSkip = (id) => inactiveCollection ? null : mutate('skip', { id })
        const onMoveMenu = (id, event) => {
          const rect = event?.currentTarget?.getBoundingClientRect?.()
          setMenu({
            id,
            top: rect ? rect.bottom + 4 : 120,
            left: rect ? Math.max(8, rect.left - 130) : 120,
          })
        }
        const toggleCollapsed = (id) => setApp({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })

        // Creating a list is an inline row, not window.prompt: the host may block
        // the native dialog outright -- which is exactly why the button appeared to
        // do nothing -- and the dot in the row previews the colour the new list
        // will actually get (the host decides it, this only reports it back).
        const submitList = async () => {
          const name = newList.trim()
          setNewList('')
          setApp({ creatingList: false })
          if (name === '') return
          const result = await mutate('createList', { name })
          if (result !== null && result !== undefined) {
            toast(`已创建清单「${result.list?.name ?? name}」`)
          }
        }

        const openView = (kind) => setApp({
          view: kind,
          ...(state.filter === 'archive' || state.filter === 'trash'
            ? { filter: 'all', listId: null, tag: '', includeDone: false }
            : {}),
          day: null,
          calMonth: state.calMonth ?? monthOf(data.today),
          ganttAnchor: state.ganttAnchor ?? data.today,
        })

        // The order the arrow keys walk: depth-first over the groups, skipping
        // collapsed subtrees -- exactly the order the eye reads on screen.
        const flatRows = []
        {
          const walk = (id) => {
            flatRows.push(id)
            if (state.collapsed[id] === true) return
            for (const child of (childrenOf.get(id) ?? [])) walk(child)
          }
          for (const group of groups) for (const id of group.ids) walk(id)
        }

        const focusRow = (id) => {          if (id === null || id === undefined) return
          setApp({ focusId: id })
          // The node exists already (every row is in the DOM); a row is
          // focusable at tabIndex -1, so this needs no wait for the re-render.
          const root = myRoot.current
          if (root === null || typeof root.querySelector !== 'function') return
          const node = root.querySelector(`[data-row-id="${id}"]`)
          if (node === null || typeof node.focus !== 'function') return
          try {
            node.focus({ preventScroll: true })
            if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
          } catch { /* a host without layout still navigates */ }
        }

        const stepRow = (delta) => {
          if (flatRows.length === 0) return
          const at = state.focusId === null ? -1 : flatRows.indexOf(state.focusId)
          const next = at < 0
            ? (delta > 0 ? 0 : flatRows.length - 1)
            : Math.min(flatRows.length - 1, Math.max(0, at + delta))
          focusRow(flatRows[next])
        }

        /**
         * The list's keyboard cursor.
         *
         * Two delivery paths reach this one function, and it has to stay a single
         * function because they can BOTH fire for the same key:
         *
         *  - the native document listener below. It is the path that actually runs
         *    in a real host: measured there, a keydown on a row (or on `.td-root`,
         *    or on any container in between) never invoked this component's
         *    onKeyDown prop, while a native listener attached to `.td-root` itself
         *    was called on every key. Since the event demonstrably arrives at the
         *    element, the handler never being called means the event stops
         *    propagating somewhere between this subtree and the React root
         *    container, where delegation dispatches from -- inside the host's own
         *    keydown handling. A capture-phase listener on `document` runs BEFORE
         *    any bubble-phase stopper, so it cannot be starved that way.
         *  - the React `onKeyDown` prop, kept because it is the declarative wiring
         *    and because the fake DOM gate can only exercise this shape ). If a host does deliver
         *    it, the marker below keeps the key from being handled twice.
         *
         * It reads the store (`app`) rather than the render's `state` snapshot: the
         * listener outlives any single render, and a captured snapshot would step
         * through the row list of whichever render registered it.
         */
        const onRootKey = (event) => {
          if (event.__tdListKey === true) return
          event.__tdListKey = true
          // A layer above owns the keyboard while it is open.
          if (app.cmdk === true || app.capture === true || app.appearanceOpen === true || app.feishuSyncOpen === true) return
          if (app.openId !== null || app.completionId !== null || app.confirm !== null || app.listEditor !== null) return
          const target = event.target ?? null
          // Keys aimed at a control belong to that control.
          if (target !== null && typeof target.closest === 'function'
            && target.closest('input,textarea,select,[contenteditable="true"],button') !== null) return
          const key = event.key
          if (key === 'n') {
            stopEvent(event)
            setApp({ quickFocus: floating ? 'float' : 'panel' })
            return
          }
          if (key === '/') {
            const node = searchRef.current
            if (node === null || typeof node.focus !== 'function') return
            stopEvent(event)
            try { node.focus({ preventScroll: true }) } catch { /* not focusable */ }
            return
          }
          if (app.view !== 'list') return
          if (key === 'ArrowDown' || key === 'j') { stopEvent(event); stepRow(1); return }
          if (key === 'ArrowUp' || key === 'k') { stopEvent(event); stepRow(-1); return }
          if (key === 'Home') { stopEvent(event); focusRow(flatRows[0] ?? null); return }
          if (key === 'End') { stopEvent(event); focusRow(flatRows[flatRows.length - 1] ?? null); return }
          const id = app.focusId
          if (id === null) return
          if (key === 'ArrowRight') { stopEvent(event); if (app.collapsed[id] === true) toggleCollapsed(id); return }
          if (key === 'ArrowLeft') { stopEvent(event); if (app.collapsed[id] !== true) toggleCollapsed(id); return }
          if (key === ' ' || key === 'Spacebar') { stopEvent(event); onToggle(id); return }
          if (key === 'Enter') { stopEvent(event); onOpen(id); return }
          if (key === 'x') { stopEvent(event); askDelete(id, byId.get(id)?.title ?? '') }
        }

        // The latest handler, reached through a ref so the listener below can stay
        // registered for the life of the seat while still seeing this render's rows.
        const rootKeyRef = useRef(onRootKey)
        useEffect(() => { rootKeyRef.current = onRootKey })

        // The delivery path that works in a real host (see onRootKey). Capture
        // phase, and filtered by containment: this is a focusable subtree, not a
        // global key grabber, so the host's own keys and the chat box never see it.
        useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onKey = (event) => {
            const root = myRoot.current
            if (root === null || typeof root.contains !== 'function') return
            const target = event.target ?? null
            if (target === null || !root.contains(target)) return
            const handler = rootKeyRef.current
            if (typeof handler === 'function') handler(event)
          }
          document.addEventListener('keydown', onKey, true)
          return () => document.removeEventListener('keydown', onKey, true)
        }, [])

        // The badge counts what the current view is actually showing, and the
        // muted line keeps the triage numbers; previously both said "未完成".
        const visible = view.kind === 'list'
          ? groups.reduce((sum, group) => sum + group.ids.length, 0)
          : view.kind === 'board'
            ? columns.reduce((sum, column) => sum + column.ids.length, 0)
            : view.kind === 'calendar'
              ? (view.days ?? []).reduce((sum, day) => sum + day.ids.length, 0)
              : (view.rows ?? []).length
        const headSummary = `今天 ${counts.dueToday} · 逾期 ${counts.overdue}`

        // The list the floating window's switcher shows a colour for.
        const currentList = (data.lists ?? []).find((l) => l.id === state.listId) ?? null

        // One source for the six smart lists, because two surfaces show them now:
        // the rail (full rows with a count pill) and the window's chips.
        const smartLists = [
          ['today', '今天', counts.dueToday + counts.overdue],
          ['week', '最近 7 天', counts.upcoming],
          ['overdue', '已逾期', counts.overdue],
          ['inbox', '未安排', counts.inbox],
          ['all', '全部任务', counts.open],
          ['done', '已完成', counts.done],
        ]

        const feishuInfo = state.feishuSync
        const feishuConflicts = Array.isArray(feishuInfo?.conflicts) ? feishuInfo.conflicts : []
        const feishuStatus = feishuInfo?.busy === true ? '检查中'
          : feishuInfo?.error ? '异常'
            : feishuConflicts.length > 0 ? `冲突 ${feishuConflicts.length}` : '飞书'
        const feishuStatusTitle = feishuInfo?.error
          ? `飞书检查未完成：${feishuInfo.error}`
          : feishuInfo?.busy === true
            ? '正在后台检查飞书'
            : feishuConflicts.length > 0
              ? `发现 ${feishuConflicts.length} 个待处理冲突；双方修改均已保留`
              : feishuInfo?.at ? '查看飞书同步状态' : '查看飞书同步状态或手动检查'
        const feishuStatusTone = feishuInfo?.error ? ' error'
          : feishuConflicts.length > 0 ? ' conflict' : ''
        const feishuSyncTrigger = data.settings?.feishu?.enabled !== true
          ? null
          : h('button', {
            type: 'button',
            className: `td-btn sm td-feishu-trigger${feishuStatusTone}`,
            title: feishuStatusTitle,
            'aria-label': feishuStatusTitle,
            'aria-haspopup': 'dialog',
            'aria-expanded': state.feishuSyncOpen === true ? 'true' : 'false',
            onClick: () => setApp({ feishuSyncOpen: state.feishuSyncOpen !== true }),
          },
            h('span', { className: 'td-feishu-sync-mark', 'aria-hidden': 'true' }),
            h('span', null, feishuStatus))

        // One state, two seats. The search box belongs in the rail -- it filters
        // what the selected view shows, and the rail is where that view is chosen
        // -- but the rail is dropped wholesale under the container query, and a
        // search that disappears on a narrow sidebar is worse than one in the
        // wrong corner. So the identical input is rendered twice and CSS shows
        // exactly one, the same trade the view switcher already makes.
        // The search box: a magnifier inside the field, and the tag filter as a
        // chip you can click off. The placeholder used to spell out the whole
        // syntax -- 28 CJK characters in a 214px field, so it was truncated at
        // exactly the point where it started being useful. The syntax now lives
        // in the tooltip and in the empty state, where there is room for it.
        const searchField = (extra, refTarget) => h('div', { className: `td-searchbox${extra}` },
          h('span', { className: 'td-search-ico', 'aria-hidden': 'true' }, h(Glyph, { name: 'search', size: 13 })),
          h('input', {
            className: 'td-in td-search',
            ref: refTarget ?? null,
            value: state.query,
            placeholder: '搜索…',
            'aria-label': '搜索任务 / 备注 / 标签',
            title: '搜索任务 / 备注 / 标签；输入 #标签 只看该标签',
            onChange: (event) => {
              const next = event.target.value
              // `#工作` is the one syntax the search box shares with the add box, and
              // it means the same thing in both: that tag, exactly.
              const asTag = /^#(\S+)$/.exec(next.trim())
              setApp({
                query: next,
                tag: asTag === null ? '' : asTag[1],
                ...(asTag === null ? {} : { filter: 'all', listId: null }),
              })
              reloadSoon()
            },
          }),
          // The tag filter is a mode of the search box, so it is shown IN the box
          // and removed from the box -- not as a row somewhere else that the user
          // has to find before they can undo what they typed.
          state.tag === ''
            ? null
            : h('button', {
              type: 'button',
              className: 'td-search-tag',
              title: `清除 #${state.tag} 筛选`,
              'aria-label': `清除 #${state.tag} 筛选`,
              onClick: () => setApp({ tag: '', query: '' }),
            }, `#${state.tag}`, h(Glyph, { name: 'close', size: 11 })))

        return h('div', {
          className: `td-seat td-root${mode === 'fullscreen' ? ' td-overlay' : ''}${floating ? ' td-floatapp' : ''}`,
          'data-todo-appearance': appearance,
          ref: myRoot,
          // The list's keyboard cursor lives here, not on `document`: see onRootKey.
          onKeyDown: onRootKey,
        },
          h('div', {
            // The header doubles as the floating window's drag handle; in the
            // panel and in fullscreen it stays an ordinary header.
            className: `td-head${floating ? ' td-dragh' : ''}`,
            onPointerDown: floating ? drag?.onPointerDown : undefined,
            onPointerMove: floating ? drag?.onPointerMove : undefined,
            onPointerUp: floating ? drag?.onPointerUp : undefined,
            onPointerCancel: floating ? drag?.onPointerUp : undefined,
          },
            // The one colour mark in the window: an origin for the eye, right
            // before the title. The panel does not need it -- the host already
            // names that seat -- so it is drawn only in the floating window.
            floating ? h('span', { className: 'td-flogo', 'aria-hidden': 'true' }) : null,
            h('h3', { className: 'td-h1' }, '待办任务'),
            h('span', { className: 'td-countbadge', title: '当前视图中的任务数' }, String(visible)),
            h('span', { className: 'td-sub' }, headSummary),
            h('span', { className: 'td-grow' }),
            h('div', { className: 'td-headtools' },
              // The floating window swaps the container controls for its own two:
              // 停靠 hands the app back to the sidebar panel, ✕ closes the window.
              // The list stays reachable either way, so nothing here is a loss.
              floating ? null : searchField(' td-headsearch'),
              feishuSyncTrigger,
              // The same switcher the rail carries, shown only when the rail has
              // been hidden by the container query -- so the view is reachable at
              // every width with exactly one control visible.
              floating ? null : h('div', { className: 'td-seg td-headviews' }, ...VIEW_KINDS.map(([kind, label]) => h('button', {
                key: kind,
                type: 'button',
                className: `${state.view === kind ? 'on' : ''}`,
                onClick: () => openView(kind),
              }, label))),
              floating ? null : h('button', {
                type: 'button',
                className: 'td-icon td-style-trigger',
                title: '界面风格设置',
                'aria-label': '界面风格设置',
                'aria-haspopup': 'dialog',
                'aria-expanded': state.appearanceOpen === true ? 'true' : 'false',
                onClick: () => setApp({ appearanceOpen: true }),
              }, h(Glyph, { name: 'tune', size: 15 })),
              floating ? null : h('button', {
                type: 'button',
                className: 'td-btn',
                title: state.fullscreen ? '退出全屏（Esc）' : '全屏显示',
                onClick: () => setApp({ fullscreen: !state.fullscreen }),
              }, state.fullscreen ? '⛶ 退出全屏' : '⛶ 全屏'),
              floating
                ? h('button', {
                  type: 'button', className: 'td-icon', title: '停靠回侧边栏面板',
                  'aria-label': '停靠回侧边栏面板',
                  onClick: () => { setFloat(false); selectTodoPanel('todo') },
                }, h(Glyph, { name: 'dock', size: 16 }))
                : h('button', {
                  type: 'button', className: 'td-btn', title: '浮动小窗口（可拖到页面任意位置）',
                  'aria-label': '打开浮动小窗口',
                  onClick: () => setFloat(true),
                }, h(Glyph, { name: 'popout', size: 14 }), '浮动'),
              floating
                ? h('button', {
                  type: 'button', className: 'td-icon', title: '关闭浮动窗口',
                  'aria-label': '关闭浮动窗口', onClick: () => setFloat(false),
                }, h(Glyph, { name: 'close', size: 14 }))
                : null)),

          // The window keeps the controls that answer "which tasks am I looking at",
          // in the order the questions come: triage, then which list, then what to
          // add. The view switcher, list management and the data block stay in the
          // panel, which is what keeps the box a list and nothing else.
          floating
            ? h('div', { className: 'td-float-bar' },
              h('div', { className: 'td-seg td-float-tabs' }, ...smartLists.map(([key, label, badge]) => h('button', {
                key,
                type: 'button',
                className: state.filter === key && state.listId === null ? 'on' : '',
                'data-smart-filter': key,
                onClick: () => setApp({ filter: key, listId: null, includeDone: key === 'done' }),
              }, badge > 0 ? `${label} ${badge}` : label))),
              // The search box that stood here is gone: it answered a question the
              // window cannot ask twice (the panel still has one), and the room is
              // worth more as the list switcher -- without it, the window could only
              // ever show whichever list the panel happened to have selected.
              h('div', { className: 'td-float-lists' },
                currentList === null
                  ? h('span', {
                    className: 'td-dot',
                    style: { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--td-line-2)' },
                  })
                  : h('span', { className: 'td-dot', style: { background: currentList.color } }),
                h('select', {
                  className: 'td-in td-float-sel',
                  'aria-label': '切换清单',
                  value: state.listId ?? '',
                  onChange: (event) => setApp({
                    listId: event.target.value === '' ? null : event.target.value,
                    filter: 'all',
                  }),
                },
                  h('option', { value: '' }, '全部清单'),
                  ...(data.lists ?? []).map((list) => h('option', {
                    key: list.id,
                    value: list.id,
                  }, `${list.name}（${(counts.byList ?? []).find((b) => b.id === list.id)?.open ?? 0}）`)))))
            : null,

          // The narrow tier's second header line. Below ~680px the rail is gone
          // entirely, which used to take the smart lists and the list switcher with
          // it: a narrow sidebar could not change which slice it was showing at all.
          // The row is hidden by CSS at every wider width, so nothing is paid for it
          // where the rail is right there, and the floating window keeps its own
          // copy (td-float-bar) instead of this one.
          floating ? null : h('div', { className: 'td-head2' },
            h('div', { className: 'td-head2-tabs' }, ...smartLists.map(([key, label, badge]) => h('button', {
              key,
              type: 'button',
              className: `td-head2-tab td-smart-filter${state.filter === key && state.listId === null ? ' on' : ''}`,
              'data-smart-filter': key,
              onClick: () => setApp({ filter: key, listId: null, tag: '', includeDone: key === 'done' }),
            }, badge > 0 ? `${label} ${badge}` : label))),
            h('select', {
              className: 'td-in td-head2-sel',
              'aria-label': '切换清单',
              value: state.listId ?? '',
              onChange: (event) => setApp({
                listId: event.target.value === '' ? null : event.target.value,
                filter: 'all',
                tag: '',
              }),
            },
              h('option', { value: '' }, '全部清单'),
              ...(data.lists ?? []).map((list) => h('option', {
                key: list.id,
                value: list.id,
              }, list.name)))),

          // One capture input for every seat. The preview slot travels with it
          // (see CaptureBar), which is what stopped the list from jumping down
          // when the first character was typed.
          h(CaptureBar, { mode: floating ? 'float' : 'panel' }),

          state.error !== null ? h('div', { style: { padding: '8px 14px 0' } }, h('div', { className: 'td-err' }, state.error)) : null,
          data.loadError !== null && data.loadError !== undefined
            ? h('div', { style: { padding: '8px 14px 0' } }, h('div', { className: 'td-warn' }, data.loadError))
            : null,

          h('div', { className: 'td-body' },
            // The floating window shows the list alone: no rail, which is where
            // the other views, the smart lists and the data block live.
            floating ? null : h('div', { className: 'td-rail' },
              // The rail is ordered by how often a thing is used, not by how
              // structural it is: what to show (smart lists, lists, tags) comes
              // first, how to show it (the view switcher) after, and the data
              // block -- read once, if ever -- last and folded away.
              h('div', { className: 'td-railsearch' }, searchField('', searchRef)),
              h('div', { className: 'td-rail-g td-smart-group' },
                h('div', { className: 'td-rail-t' }, '智能清单'),
                ...smartLists.map(([key, label, badge]) => h('button', {
                  key,
                  type: 'button',
                  className: `td-side td-smart-filter${state.filter === key && state.listId === null && state.tag === '' ? ' on' : ''}`,
                  'data-smart-filter': key,
                  onClick: () => setApp({ filter: key, listId: null, tag: '', includeDone: key === 'done' }),
                },
                  h('span', { className: 'td-side-l' }, label),
                  h('span', { className: 'td-side-n' }, String(badge))))),
              h('div', { className: 'td-rail-g' },
                h('div', { className: 'td-rail-t' }, '整理'),
                ...[
                  ['archive', '已归档', Number(counts.archived ?? 0)],
                  ['trash', '回收站', Number(counts.trash ?? 0)],
                ].map(([key, label, badge]) => h('button', {
                  key,
                  type: 'button',
                  className: `td-side td-collection-filter${state.filter === key ? ' on' : ''}`,
                  'data-collection-filter': key,
                  'aria-pressed': state.filter === key ? 'true' : 'false',
                  onClick: () => {
                    setMenu(null)
                    setApp({
                      filter: key,
                      view: 'list',
                      listId: null,
                      tag: '',
                      includeDone: true,
                      openId: null,
                    })
                  },
                },
                  h('span', { className: 'td-side-l' }, label),
                  h('span', { className: 'td-side-n' }, String(badge)))),
                state.filter === 'trash' && Number(counts.trash ?? 0) > 0
                  ? h('button', {
                    type: 'button',
                    className: 'td-rail-more',
                    onClick: emptyRecycleBin,
                  }, '清空回收站')
                  : null),
              h('div', { className: 'td-rail-g' },
                h('div', { className: 'td-rail-t' }, '清单'),
                // One row per list: the row selects, the trailing button opens the
                // settings dialog, and dragging the row reorders. The drag payload
                // is set because Firefox refuses to start a drag without one.
                ...(data.lists ?? []).map((list) => h('div', {
                  key: list.id,
                  className: `td-lrow${state.listId === list.id ? ' on' : ''}`
                    + `${listDragId === list.id ? ' dragging' : ''}${listDropId === list.id ? ' drop' : ''}`,
                  draggable: 'true',
                  onDragStart: (event) => {
                    setListDragId(list.id)
                    if (event.dataTransfer !== undefined && event.dataTransfer !== null) {
                      try { event.dataTransfer.setData('text/plain', list.id) } catch { /* not fatal */ }
                      event.dataTransfer.effectAllowed = 'move'
                    }
                  },
                  onDragEnd: () => { setListDragId(null); setListDropId(null) },
                  onDragOver: (event) => {
                    if (listDragId === null || listDragId === list.id) return
                    event.preventDefault()
                    setListDropId(list.id)
                  },
                  onDragLeave: () => { if (listDropId === list.id) setListDropId(null) },
                  onDrop: (event) => {
                    event.preventDefault()
                    // The state is the primary source; the payload is the fallback,
                    // the same pair the board uses for a task drop.
                    const dragged = listDragId ?? (() => {
                      try { return event.dataTransfer.getData('text/plain') } catch { return null }
                    })()
                    setListDragId(null)
                    setListDropId(null)
                    if (dragged === null || dragged === list.id) return
                    const wanted = (data.lists ?? []).findIndex((l) => l.id === list.id)
                    moveListTo(dragged, wanted)
                  },
                },
                  h('button', {
                    type: 'button',
                    className: `td-side${state.listId === list.id ? ' on' : ''}`,
                    onClick: () => setApp({ listId: state.listId === list.id ? null : list.id, filter: 'all', tag: '' }),
                  },
                    h('span', { className: 'td-dot', style: { background: list.color } }),
                    h('span', { className: 'td-side-l' }, list.name),
                    h('span', { className: 'td-side-n' },
                      String((counts.byList ?? []).find((b) => b.id === list.id)?.open ?? 0))),
                  h('button', {
                    type: 'button',
                    className: 'td-icon td-lcfg',
                    title: `清单设置：${list.name}`,
                    'aria-label': `清单设置 ${list.name}`,
                    onClick: () => setApp({ listEditor: list.id }),
                  }, h(Glyph, { name: 'more', size: 14 })))),
                // Creating a list is an inline row, not window.prompt: the host may
                // block the native dialog outright -- which is exactly why the
                // button appeared to do nothing -- and the dot in front previews
                // the colour this list will actually be created with.
                state.creatingList
                  ? h('div', { className: 'td-create' },
                    h('span', { className: 'td-dot', style: { background: data.nextListColor } }),
                    h('input', {
                      className: 'td-in',
                      autoFocus: true,
                      value: newList,
                      placeholder: '清单名称，回车创建',
                      onChange: (event) => setNewList(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') { event.preventDefault(); submitList() }
                        if (event.key === 'Escape') { setNewList(''); setApp({ creatingList: false }) }
                      },
                      onBlur: () => { setNewList(''); setApp({ creatingList: false }) },
                    }))
                  : h('button', {
                    type: 'button',
                    className: 'td-side',
                    onClick: () => setApp({ creatingList: true }),
                  },
                    h('span', { className: 'td-glyph' }, h(Glyph, { name: 'plus', size: 13 })),
                    h('span', { className: 'td-side-l' }, '新建清单'))),

              // Tags, which until now existed only inside tasks: nothing could list
              // them, so a typo was permanent and "what do I actually tag things
              // with" had no answer. The row filters exactly (`tag`), which is a
              // different question from typing the tag into the search box.
              (data.tags ?? []).length > 0
                ? h('div', { className: 'td-rail-g' },
                  h('div', { className: 'td-rail-t' }, '标签'),
                  // Eight rows, then a fold. A rail that grows with every tag
                  // pushes the view switcher and the lists off the screen, and
                  // the tenth tag is not what anyone is looking for.
                  ...(data.tags ?? []).slice(0, state.tagExpanded === true ? undefined : 8).map((row) => h('button', {
                    key: row.tag,
                    type: 'button',
                    className: `td-side${state.tag !== '' && state.tag.toLowerCase() === row.tag.toLowerCase() ? ' on' : ''}`,
                    title: `只看 #${row.tag}`,
                    onClick: () => setApp({
                      tag: state.tag !== '' && state.tag.toLowerCase() === row.tag.toLowerCase() ? '' : row.tag,
                      filter: 'all',
                      listId: null,
                      includeDone: false,
                    }),
                  },
                    h('span', { className: 'td-side-l' }, `#${row.tag}`),
                    h('span', { className: 'td-side-n' }, String(row.open)))),
                  (data.tags ?? []).length > 8
                    ? h('button', {
                      type: 'button',
                      className: 'td-rail-more',
                      onClick: () => setApp({ tagExpanded: state.tagExpanded !== true }),
                    }, state.tagExpanded === true
                      ? '收起'
                      : `更多 (${(data.tags ?? []).length - 8})`)
                    : null)
                : null,

              // How the tasks are shown. It sits below what they are: a view is
              // a lens on a selection, and the selection is what people change.
              h('div', { className: 'td-rail-g' },
                h('div', { className: 'td-rail-t' }, '视图'),
                ...VIEW_KINDS.map(([kind, label, glyph]) => h('button', {
                  key: kind,
                  type: 'button',
                  className: `td-side${state.view === kind ? ' on' : ''}`,
                  onClick: () => openView(kind),
                },
                  h('span', { className: 'td-glyph' }, h(Glyph, { name: glyph, size: 13 })),
                  h('span', { className: 'td-side-l' }, label)))),

              // Where the data lives, and how to keep a copy -- answered here rather
              // than only in the README, because this is where a user looks. Folded
              // to one line by default: it is read once and then never again, and
              // unfolded it was 96px of a 680px rail.
              h('div', { className: 'td-rail-g' },
                h('button', {
                  type: 'button',
                  className: 'td-rail-t td-rail-toggle',
                  'aria-expanded': state.dataOpen === true ? 'true' : 'false',
                  onClick: () => setApp({ dataOpen: state.dataOpen !== true }),
                },
                  h('span', { className: `td-caret${state.dataOpen === true ? ' open' : ''}` }, '▸'),
                  h('span', null, '数据')),
                state.dataOpen === true
                  ? h('div', { className: 'td-rail-data' },
                    // The file name IS the copy button: the same discoverability
                    // the three buttons offered, without a row of them.
                    h('button', {
                      type: 'button', className: 'td-rail-file', title: `复制路径：${data.dataFile}`,
                      onClick: () => { copyText(data.dataFile) },
                    }, fileNameOf(data.dataFile)),
                    h('div', { className: 'td-rail-note' }, '任务都存在本机这个文件里，复制它就是一份备份。'),
                    h('div', { className: 'td-rail-acts' },
                      h('button', {
                        type: 'button', className: 'td-btn sm primary', title: '按月生成并下载计划表',
                        onClick: () => setApp({ planExportOpen: true }),
                      }, '导出月度计划'),
                      h('button', {
                        type: 'button', className: 'td-btn sm', title: '下载一份 JSON 备份',
                        onClick: () => { exportBackup() },
                      }, '导出备份'),
                      h('label', {
                        className: 'td-btn sm', title: '从 JSON 备份恢复（会覆盖当前数据）',
                        style: { cursor: 'pointer' },
                      },
                        '导入',
                        h('input', {
                          type: 'file',
                          accept: '.json,application/json',
                          style: { display: 'none' },
                          onChange: (event) => {
                            const file = event.target.files?.[0]
                            event.target.value = ''
                            if (file) importBackup(file)
                          },
                        })),
                      h('button', {
                        type: 'button', className: 'td-btn sm', title: data.dataFile,
                        onClick: () => { copyText(data.dataFile) },
                      }, '复制路径')))
                  : null)),

            h('div', { className: 'td-main' },
              view.kind === 'board'
                ? h(BoardView, {
                  ...common,
                  columns,
                  dragId,
                  dropTarget,
                  onOpen,
                  onToggle,
                  onDragStart: setDragId,
                  onDragEnd: () => { setDragId(null); setDropTarget(null) },
                  onDragOver: setDropTarget,
                  // The column's own box: the card lands in THAT column, and the
                  // caret never leaves it (it used to prefill the global line).
                  newColumn: state.colNew,
                  onAddHere: (id) => setApp({ colNew: id }),
                  onDrop: async (id, listId) => {
                    setDragId(null)
                    setDropTarget(null)
                    await mutate('move', { id, listId, index: 0 })
                  },
                  onMoveMenu,
                })
                : view.kind === 'calendar'
                  ? h(CalendarView, {
                    ...common,
                    onOpen,
                    onToggle,
                    onDelete,
                    onAddSubtask: (parentId, title) => mutate('addSubtask', { parentId, title }),
                    askDelete,
                    toggleCollapsed,
                    onMonth: (month) => setApp({ calMonth: month, day: null }),
                    onSelectDay: (date) => setApp({ day: date }),
                    onAddOnDay: (date) => {
                      setApp({ day: date, quickFocus: floating ? 'float' : 'panel' })
                      seedQuick(`${date} `)
                    },
                  })
                  : view.kind === 'gantt'
                    ? h('div', { className: 'td-scroll' }, h(GanttView, {
                      ...common,
                      onOpen,
                      onPatch: (id, fields) => mutate('update', { id, ...fields }),
                      onAnchor: (date) => setApp({ ganttAnchor: date }),
                    }))
                    : h('div', { className: 'td-scroll' },
                      h(ListView, {
                        ...common,
                        groups,
                        onOpen,
                        onToggle,
                        onDelete,
                        inactive: state.filter === 'archive' || state.filter === 'trash',
                        trashMode: state.filter === 'trash',
                        onAddSubtask: async (parentId) => {
                          const result = await mutate('addSubtask', { parentId, title: '新子任务' })
                          if (result !== null && result.created) setApp({ openId: result.created.id })
                        },
                        onMoveMenu,
                        askDelete,
                        showList: state.listId === null,
                        toggleCollapsed,
                        // The row whose dialog is open wears the same selected
                        // language a rail row does -- otherwise the only way to
                        // tell which card the centred dialog belongs to is to read
                        // the title twice.
                        openId: state.openId,
                        // Keyboard navigation state, and the group's own "+".
                        focusId: state.focusId,
                        onFocusRow: (id) => setApp({ focusId: id }),
                        newGroup: state.grpNew,
                        onAddHere: (key) => setApp({ grpNew: key }),
                      }))),
          ),

          menu === null ? null : h('div', { className: 'td-pop', style: { position: 'fixed', top: menu.top, left: menu.left } },
            inactiveCollection
              ? h('div', { className: 'td-hint', style: { padding: '4px 8px' } }, state.filter === 'trash' ? '回收站操作' : '归档操作')
              : h('div', { className: 'td-hint', style: { padding: '4px 8px' } }, '移动到清单'),
            ...(inactiveCollection ? [] : (data.lists ?? []).map((list) => h('button', {
              key: list.id,
              type: 'button',
              onClick: async () => { setMenu(null); await mutate('move', { id: menu.id, listId: list.id, index: 0 }) },
            }, list.name))),
            ...menuActions.map((action) => h('button', {
              key: `task-action:${action.id}`,
              type: 'button',
              className: 'td-task-action',
              disabled: action.enabled !== true,
              title: action.disabledReason || undefined,
              'aria-disabled': action.enabled !== true,
              onClick: async () => {
                if (action.enabled !== true) return
                const task = byId.get(menu.id)
                setMenu(null)
                if (task === undefined) {
                  toast('该任务已不存在，请刷新后重试')
                  await refresh({}, true)
                  return
                }
                try {
                  const result = await action.run(copyTaskSnapshot(task), taskActionApiFor(task))
                  if (typeof result === 'string' && result.trim() !== '') toast(result.trim().slice(0, 180))
                } catch (error) {
                  toast(`${action.label}失败：${String(error?.message ?? error)}`.slice(0, 180))
                }
              },
            }, action.enabled !== true && action.disabledReason !== ''
              ? `${action.label}（${action.disabledReason}）`
              : action.label)),
            state.filter === 'archive'
              ? h('button', {
                type: 'button',
                onClick: () => { const id = menu.id; setMenu(null); restoreTask(id, 'archive') },
              }, '恢复到待办')
              : null,
            state.filter === 'trash'
              ? h('button', {
                type: 'button',
                onClick: () => { const id = menu.id; setMenu(null); restoreTask(id, 'trash') },
              }, '恢复任务')
              : null,
            !inactiveCollection && menuTask?.done === true
              ? h('button', {
                type: 'button',
                onClick: () => { const id = menu.id; setMenu(null); archiveTask(id) },
              }, '归档任务')
              : null,
            h('button', {
              type: 'button',
              onClick: () => { const id = menu.id; const title = byId.get(id)?.title ?? ''; setMenu(null); askDelete(id, title) },
            }, state.filter === 'trash' ? '永久删除' : '移入回收站'),
            h('button', { type: 'button', onClick: () => setMenu(null) }, '取消')),

          // The task dialog is NOT rendered here: it belongs to the overlay seat, so
          // that the panel host and the fullscreen host show exactly one dialog and
          // it is never confined to this column.
          state.toast === null ? null : h('div', { className: 'td-toast' }, state.toast))
      }

      /** Feishu status and field-by-field decisions, opened only on request. */
      function FeishuSyncDialog({ state }) {
        // The bulk action is destructive on one side either way, so it asks once
        // more, inline: a stray click must not overwrite a dozen local edits or
        // delete local tasks in one go.
        const [bulkAsk, setBulkAsk] = useState(null)
        if (state.feishuSyncOpen !== true || state.data?.settings?.feishu?.enabled !== true) return null
        const info = state.feishuSync ?? {}
        const conflicts = Array.isArray(info.conflicts) ? info.conflicts : []
        const error = typeof info.error === 'string' && info.error !== '' ? info.error : null
        const statusTone = error !== null ? ' error' : conflicts.length > 0 ? ' conflict' : ''
        const statusText = info.busy === true
          ? '正在后台检查飞书…'
          : error !== null
            ? `飞书检查未完成：${error}`
            : conflicts.length > 0
              ? `发现 ${conflicts.length} 个待处理冲突；双方修改均已保留，可逐项选择，也可一次处理全部。`
              : info.at
                ? `检查完成 · 新增 ${info.imported ?? 0} · 更新 ${info.remoteUpdated ?? 0} · 推送 ${(info.pushed?.created ?? 0) + (info.pushed?.updated ?? 0)}`
                : '尚未检查飞书最新状态。'
        const close = () => setApp({ feishuSyncOpen: false })
        const shortValue = (value) => {
          const text = String(value ?? '').replace(/\s+/g, ' ').trim()
          return text === '' ? '（空）' : text.length > 140 ? `${text.slice(0, 139)}…` : text
        }
        const fieldConflictRow = (conflict, change) => {
          const requestKey = `${conflict.key}:${change.field}`
          const resolving = info.resolving === requestKey || info.busy === true
          const detail = change.remoteCanApply !== true && change.remoteReason
            ? change.remoteReason
            : change.reason === 'both'
              ? '双方都修改了此字段'
              : change.reason === 'unknown'
                ? '没有共同基准，需明确选择'
                : '远端改动与本地值不同'
          return h('div', { className: 'td-seat td-feishu-field-conflict', key: `${conflict.key}:${change.field}` },
            h('div', { className: 'td-feishu-field-copy' },
              h('strong', null, change.field),
              h('span', null, `本地：${shortValue(change.local)}`),
              h('span', null, `飞书：${shortValue(change.remote)}`),
              h('small', null, detail)),
            h('div', { className: 'td-feishu-choice' },
              h('button', {
                type: 'button', className: 'td-btn sm', disabled: resolving,
                onClick: () => { void chooseFeishuConflict(conflict, change, 'local') },
              }, '保留本地'),
              h('button', {
                type: 'button', className: 'td-btn sm', disabled: resolving || change.remoteCanApply !== true,
                title: change.remoteCanApply === true
                  ? '采用飞书此字段'
                  : (change.remoteReason || change.reason || '该字段不能安全还原到本地'),
                onClick: () => { void chooseFeishuConflict(conflict, change, 'remote') },
              }, '采用飞书')))
        }
        const taskConflictCard = (conflict) => {
          const operation = conflict.operation
          const taskLevel = operation === 'delete' || operation === 'remote-delete'
          const requestKey = `${conflict.key}:__delete__`
          const resolving = info.resolving === requestKey || info.busy === true
          return h('div', { className: 'td-seat td-feishu-conflict', key: conflict.key },
            h('div', { className: 'td-feishu-conflict-head' },
              h('strong', null, conflict.title || conflict.key),
              h('code', null, conflict.key)),
            ...(conflict.changes ?? []).map((change) => taskLevel
              ? h('div', { className: 'td-feishu-delete-change', key: `${conflict.key}:${change.field}` },
                `${change.field}：本地「${shortValue(change.local)}」 · 飞书「${shortValue(change.remote)}」`)
              : fieldConflictRow(conflict, change)),
            taskLevel
              ? h('div', { className: 'td-feishu-choice' },
                h('button', {
                  type: 'button', className: 'td-btn sm', disabled: resolving,
                  onClick: () => { void chooseFeishuConflict(conflict, null, 'local') },
                }, operation === 'delete' ? '按本地删除飞书行' : '保留本地并重建飞书行'),
                h('button', {
                  type: 'button', className: 'td-btn sm', disabled: resolving,
                  onClick: () => { void chooseFeishuConflict(conflict, null, 'remote') },
                }, operation === 'delete' ? '恢复飞书任务到本地' : '按飞书删除本地任务'))
              : null)
        }
        // 「全部采用飞书 / 全部保留本地」: one direction for every conflict shown
        // above. The count is what the host will actually act on -- a task-level
        // conflict is one item, a field conflict is one item per field -- so the
        // confirmation can say exactly how much is about to move.
        const bulkCount = conflicts.reduce((total, conflict) => {
          const operation = conflict.operation ?? 'field'
          if (operation !== 'field') return total + 1
          return total + Math.max(1, (conflict.changes ?? []).length)
        }, 0)
        // Task-level conflicts move whole tasks, so the confirmation names that
        // cost instead of burying it in "涉及的任务": accepting Feishu's deletion
        // removes a local task, and the local direction deletes a Feishu row.
        const countOperation = (operation) => conflicts.filter((conflict) =>
          (conflict.operation ?? 'field') === operation).length
        const deleteMoves = countOperation('delete')
        const remoteDeleteMoves = countOperation('remote-delete')
        const taskNote = (direction) => {
          const parts = []
          if (direction === 'remote') {
            if (remoteDeleteMoves > 0) parts.push(`按飞书删除 ${remoteDeleteMoves} 个本地任务`)
            if (deleteMoves > 0) parts.push(`从飞书恢复 ${deleteMoves} 个本地已删任务`)
          } else {
            if (deleteMoves > 0) parts.push(`删除 ${deleteMoves} 行飞书任务`)
            if (remoteDeleteMoves > 0) parts.push(`重建 ${remoteDeleteMoves} 行飞书任务`)
          }
          return parts.length === 0 ? '' : `；同时${parts.join('、')}`
        }
        const bulkBusy = info.busy === true || info.resolving === '__all__'
        const bulkBar = conflicts.length === 0 ? null : h('div', { className: 'td-feishu-bulk' },
          h('span', { className: 'td-hint' }, bulkAsk === null
            ? `对全部 ${bulkCount} 项冲突一次性处理：`
            : bulkAsk === 'remote'
              ? `确认全部采用飞书？${bulkCount} 项本地值将被飞书值覆盖${taskNote('remote')}。`
              : `确认全部保留本地？${bulkCount} 项本地值将写入飞书表格${taskNote('local')}。`),
          h('span', { className: 'td-grow' }),
          bulkAsk === null
            ? [
              h('button', {
                type: 'button', className: 'td-btn sm', disabled: bulkBusy,
                onClick: () => setBulkAsk('local'),
              }, '全部保留本地'),
              h('button', {
                type: 'button', className: 'td-btn sm', disabled: bulkBusy,
                onClick: () => setBulkAsk('remote'),
              }, '全部采用飞书'),
            ]
            : [
              h('button', {
                type: 'button', className: 'td-btn sm', disabled: bulkBusy,
                onClick: () => setBulkAsk(null),
              }, '取消'),
              h('button', {
                type: 'button',
                className: `td-btn sm${bulkAsk === 'remote' ? ' danger-solid' : ' primary'}`,
                disabled: bulkBusy,
                onClick: () => {
                  const direction = bulkAsk
                  setBulkAsk(null)
                  void chooseAllFeishuConflicts(direction)
                },
              }, bulkAsk === 'remote' ? '确认采用飞书' : '确认保留本地'),
            ])

        return h('div', {
          className: 'td-seat td-modal-layer td-feishu-sync-layer',
          'data-todo-appearance': appearanceKey(state.data?.settings),
          role: 'presentation',
          onClick: close,
        },
          h('section', {
            className: 'td-modal td-feishu-sync-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '飞书同步状态和冲突',
            onClick: (event) => { if (typeof event.stopPropagation === 'function') event.stopPropagation() },
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: `td-feishu-sync-mark${statusTone}`, 'aria-hidden': 'true' }),
              h('span', { className: 'td-modal-kind' }, '飞书同步'),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '关闭（Esc）',
                'aria-label': '关闭', onClick: close,
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b td-feishu-sync-body' },
              h('div', { className: `td-feishu-sync-status${statusTone}` },
                h('span', { className: `td-feishu-sync-mark${statusTone}`, 'aria-hidden': 'true' }),
                h('span', null, statusText)),
              bulkBar,
              conflicts.length > 0
                ? h('div', { className: 'td-feishu-conflicts' }, ...conflicts.map(taskConflictCard))
                : h('div', { className: 'td-empty td-feishu-sync-empty' },
                  info.busy === true ? '正在与飞书核对最新状态…'
                    : error !== null ? '检查未完成。可以重新检查；本地任务没有被覆盖。'
                      : '目前没有待处理的冲突。')),
            h('div', { className: 'td-modal-f td-feishu-sync-footer' },
              h('span', { className: 'td-hint' }, '未选择的冲突值会保留在原端，不会静默覆盖。'),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-btn sm', disabled: info.busy === true,
                onClick: () => { void requestFeishuEntrySync(true).catch(() => {}) },
              }, '重新检查'),
              h('button', { type: 'button', className: 'td-btn sm primary', onClick: close }, '关闭'))))
      }

      /**
       * The floating window: the app in a box the user drags around the page.
       *
       * The box is a SIBLING of the dialogs, not their ancestor, so the centred
       * task dialog is never clipped by it. Dragging is pointer-based rather than
       * HTML5 drag-and-drop (which a host can veto), the header is the handle, and
       * the grab skips anything inside a control so the buttons stay clickable.
       * Dragging moves the box; grabbing the corner resizes it.
       */
      function FloatTodo() {
        const state = useApp()
        const appearance = appearanceKey(state.data?.settings)
        const [box, setBox] = useState(() => loadFloatBox() ?? floatBoxDefault())
        const [grabbing, setGrabbing] = useState(null)
        const boxRef = useRef(box)
        const origin = useRef(null)

        // The ref is the truth, not the state: the pointerup handler saves the box
        // and a batched state update may not have landed in the render yet.
        const apply = (next) => { boxRef.current = next; setBox(next) }

        useEffect(() => {
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          const onResize = () => apply(floatClamp(boxRef.current))
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [])

        const start = (kind) => (event) => {
          if (event.button !== undefined && event.button !== 0) return
          const target = event.target
          if (kind === 'move' && target !== null && target !== undefined
            && typeof target.closest === 'function'
            && target.closest('button,input,select,label,a') !== null) return
          origin.current = { kind, id: event.pointerId, x: event.clientX, y: event.clientY, base: boxRef.current }
          setGrabbing(kind)
          const node = event.currentTarget
          if (node !== null && node !== undefined && typeof node.setPointerCapture === 'function') {
            // Capture is what keeps the box following a fast pointer that has left
            // the header; a host without it still drags, just less smoothly.
            try { node.setPointerCapture(event.pointerId) } catch { /* not fatal */ }
          }
          if (typeof event.preventDefault === 'function') event.preventDefault()
        }

        const move = (event) => {
          const current = origin.current
          if (current === null || event.pointerId !== current.id) return
          const dx = event.clientX - current.x
          const dy = event.clientY - current.y
          apply(floatClamp(current.kind === 'move'
            ? { ...current.base, left: current.base.left + dx, top: current.base.top + dy }
            : { ...current.base, width: current.base.width + dx, height: current.base.height + dy }))
        }

        const end = () => {
          if (origin.current === null) return
          origin.current = null
          setGrabbing(null)
          saveFloatBox(boxRef.current)
        }

        const handle = {
          onPointerDown: start('move'),
          onPointerMove: move,
          onPointerUp: end,
          onPointerCancel: end,
        }

        return h('div', {
          className: `td-seat td-float${grabbing === null ? '' : ' dragging'}`,
          'data-todo-appearance': appearance,
          style: {
            left: `${box.left}px`, top: `${box.top}px`,
            width: `${box.width}px`, height: `${box.height}px`,
          },
          role: 'dialog',
          'aria-label': '待办任务浮动窗口',
        },
          h(TodoApp, { mode: 'float', drag: handle }),
          h('div', {
            className: 'td-float-grip',
            title: '拖动调整窗口大小',
            onPointerDown: start('size'),
            onPointerMove: move,
            onPointerUp: end,
            onPointerCancel: end,
          }))
      }

      /**
       * The global capture layer: the capture bar, reachable from anywhere.
       *
       * It reuses CaptureBar rather than mounting a second copy of the input, so
       * the draft, the preview and the parser are the same ones the panel uses --
       * a shortcut that opened a different box would be a second implementation
       * of the same feature.
       */
      function CaptureLayer() {
        return h('div', {
          className: 'td-seat td-cap-layer',
          'data-todo-appearance': appearanceKey(),
          onClick: () => closeCapture(),
        },
          h('div', {
            className: 'td-cap',
            role: 'dialog',
            'aria-label': '快速记录',
            onClick: (event) => { if (typeof event.stopPropagation === 'function') event.stopPropagation() },
          },
            h('div', { className: 'td-cap-h' }, 'Esc 丢弃 · 回车添加 · 语法见输入框提示'),
            h(CaptureBar, { mode: 'overlay' })))
      }

      /** Everything the command palette can do, derived from the current state. */
      function buildCommands(state) {
        const data = state.data
        const counts = data?.counts ?? {}
        const items = [
          { id: 'act:capture', label: '快速记录（唤起捕获）', hint: 'Ctrl+Shift+K', run: () => openCapture() },
          ...VIEW_KINDS.map(([kind, label]) => ({
            id: `view:${kind}`,
            label: `视图：${label}`,
            run: () => setApp({ view: kind, day: null }),
          })),
          ...[
            ['today', '今天', counts.dueToday + counts.overdue],
            ['week', '最近 7 天', counts.upcoming],
            ['overdue', '已逾期', counts.overdue],
            ['inbox', '未安排', counts.inbox],
            ['all', '全部任务', counts.open],
            ['done', '已完成', counts.done],
          ].map(([key, label, badge]) => ({
            id: `filter:${key}`,
            label: `智能清单：${label}`,
            hint: String(badge ?? ''),
            run: () => setApp({ filter: key, listId: null, tag: '', includeDone: key === 'done' }),
          })),
          ...(data?.lists ?? []).map((list) => ({
            id: `list:${list.id}`,
            label: `清单：${list.name}`,
            hint: String((counts.byList ?? []).find((b) => b.id === list.id)?.open ?? 0),
            run: () => setApp({ listId: list.id, filter: 'all', tag: '' }),
          })),
          ...(data?.tags ?? []).map((row) => ({
            id: `tag:${row.tag}`,
            label: `只看 #${row.tag}`,
            hint: String(row.open),
            run: () => setApp({ tag: row.tag, filter: 'all', listId: null }),
          })),
          { id: 'act:fullscreen', label: state.fullscreen ? '退出全屏' : '全屏显示', run: () => setApp({ fullscreen: !state.fullscreen }) },
          { id: 'act:appearance', label: '切换界面风格', run: () => setApp({ appearanceOpen: true }) },
          { id: 'act:float', label: state.float ? '停靠回面板' : '浮动窗口', run: () => setFloat(!state.float) },
          { id: 'act:reload', label: '重新载入', run: () => refresh({}, true) },
          { id: 'act:export', label: '导出备份', run: () => { exportBackup() } },
          { id: 'act:newlist', label: '新建清单', run: () => setApp({ creatingList: true }) },
          { id: 'help:syntax', label: '快速添加语法', hint: '?', run: () => setApp({ toast: '明天 15:00 交报告 !高 #工作 @紧要 · 每周一三五 晨跑 · 每月5日 交房租' }) },
        ]
        return items
      }

      /** Substring beats subsequence; ties keep the source order. */
      function rankCommands(items, query) {
        const needle = String(query ?? '').trim().toLowerCase()
        if (needle === '') return items
        const scored = []
        items.forEach((item, index) => {
          const label = item.label.toLowerCase()
          const at = label.indexOf(needle)
          if (at >= 0) { scored.push({ item, score: 0, at, index }); return }
          let cursor = 0
          let gaps = 0
          for (const ch of needle) {
            const found = label.indexOf(ch, cursor)
            if (found < 0) return
            gaps += found - cursor
            cursor = found + 1
          }
          scored.push({ item, score: 1, at: gaps, index })
        })
        scored.sort((a, b) => a.score - b.score || a.at - b.at || a.index - b.index)
        return scored.map((s) => s.item)
      }

      /**
       * The command palette: every action, view, list and tag as one searchable
       * line.
       *
       * It is built from the same data the rail renders, so a list that exists is
       * a command that exists -- nothing here is a hand-written menu that can fall
       * out of step with the app.
       */
      function CommandPalette() {
        const state = useApp()
        const [query, setQuery] = useState('')
        const [index, setIndex] = useState(0)
        const items = useMemo(() => buildCommands(state), [state.data, state.view, state.filter, state.float, state.fullscreen])
        const shown = rankCommands(items, query)
        const active = shown.length === 0 ? 0 : Math.min(index, shown.length - 1)

        const run = (item) => {
          if (item === undefined) return
          setApp({ cmdk: false })
          item.run()
          restoreFocus()
        }

        const onPaletteKey = (event) => {
          if (event.key === 'ArrowDown' || (event.ctrlKey === true && String(event.key).toLowerCase() === 'n')) {
            stopEvent(event)
            setIndex(shown.length === 0 ? 0 : (active + 1) % shown.length)
            return
          }
          if (event.key === 'ArrowUp' || (event.ctrlKey === true && String(event.key).toLowerCase() === 'p')) {
            stopEvent(event)
            setIndex(shown.length === 0 ? 0 : (active - 1 + shown.length) % shown.length)
            return
          }
          if (event.key === 'Home') { stopEvent(event); setIndex(0); return }
          if (event.key === 'End') { stopEvent(event); setIndex(Math.max(0, shown.length - 1)); return }
          if (event.key === 'Enter') { stopEvent(event); run(shown[active]); return }
          if (event.key === 'Escape') {
            stopEvent(event)
            // Same discipline as the capture box: throw away what was typed
            // before closing the thing that holds it.
            if (query !== '') { setQuery(''); setIndex(0); return }
            closeCommandPalette()
          }
        }

        return h('div', {
          className: 'td-seat td-cmdk-layer',
          'data-todo-appearance': appearanceKey(state.data?.settings),
          onClick: () => closeCommandPalette(),
        },
          h('div', {
            className: 'td-cmdk',
            role: 'dialog',
            'aria-label': '命令面板',
            onClick: (event) => { if (typeof event.stopPropagation === 'function') event.stopPropagation() },
          },
            h('input', {
              className: 'td-in td-cmdk-in',
              autoFocus: true,
              value: query,
              placeholder: '输入命令、视图、清单或标签…',
              'aria-label': '命令面板',
              onChange: (event) => { setQuery(event.target.value); setIndex(0) },
              onKeyDown: onPaletteKey,
            }),
            h('div', { className: 'td-cmdk-list', role: 'listbox' },
              ...(shown.length === 0
                ? [h('div', { key: 'none', className: 'td-cmdk-hint' }, '没有匹配的命令。')]
                : shown.map((item, i) => h('button', {
                  key: item.id,
                  type: 'button',
                  role: 'option',
                  'aria-selected': i === active ? 'true' : 'false',
                  'data-cmd': item.id,
                  className: `td-cmdk-item${i === active ? ' on' : ''}`,
                  onMouseEnter: () => setIndex(i),
                  onClick: () => run(item),
                },
                  h('span', { className: 'td-cmdk-lab' }, item.label),
                  item.hint === undefined || item.hint === ''
                    ? null
                    : h('span', { className: 'td-cmdk-hint' }, item.hint))))),
            h('div', { className: 'td-cmdk-foot' },
              h('span', null, '↑↓ 选择 · Enter 执行 · Esc 关闭'),
              h('span', { className: 'td-kbd' }, 'Ctrl+K'))))
      }

      /** The central page. Renders nothing visible while fullscreen owns the app.
       *  The placeholder is a seat too: it paints the canvas, so without the marker
       *  it would have no --td-canvas and no --td-text at all and the panel slot
       *  would flash a transparent page with the host's ink. */
      function TodoMain() {        const state = useApp()
        if (state.fullscreen) {
          return h('div', {
            className: 'td-seat td-root',
            'data-todo-appearance': appearanceKey(state.data?.settings),
          },
            h('div', { className: 'td-empty' }, '待办任务正在全屏显示。按 Esc 退出全屏。'))
        }
        return h(TodoApp, { mode: 'panel' })
      }

      /**
       * The overlay seat owns two frame-wide things: the fullscreen host and the
       * centred task dialog.
       *
       * The dialog lives here rather than inside the panel so that it looks and
       * behaves identically in both hosts, and so it is never confined to a column
       * that creates a containing block for fixed positioning.
       */
      function TodoOverlay() {
        const state = useApp()

        // The one keyboard entry point for the whole overlay seat: the global
        // shortcuts, then the Escape chain. Registered on `document` because it
        // must work when nothing of ours has focus -- and this seat is mounted
        // whether or not the panel is, which is what makes "record a task from
        // anywhere" possible at all.
        useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const settings = app.data?.settings ?? {}
          const captureKey = settings.hotkey?.capture ?? 'Ctrl+Shift+K'
          const paletteKey = settings.hotkey?.palette ?? 'Ctrl+K'
          const onKey = (event) => {
            // Someone closer to the event has already dealt with it. Without this
            // the capture box's Escape also unwound the layer beneath it.
            if (event.defaultPrevented === true) return
            // Mid-composition the key belongs to the IME: Ctrl+Shift+K while
            // picking characters must not open anything. The completion form
            // owns all keys except Escape until the user saves or cancels it.
            if (isComposingEvent(event)) return
            if (app.completionId !== null && event.key !== 'Escape') return
            if (hotkeyMatches(event, captureKey) || hotkeyMatches(event, paletteKey)) {
              const target = event.target ?? null
              // A key aimed at something the user is typing into is theirs --
              // unless it is inside our own subtree, where the shortcut is the
              // documented way to jump between our own boxes. `.td-root` is asked
              // of the DOM rather than remembered in a ref, because up to three
              // seats are mounted at once and a single ref would only know the
              // last one to mount.
              const inside = target !== null && typeof target.closest === 'function'
                && target.closest('.td-root') !== null
              if (isEditableTarget(target) && !inside) return
              stopEvent(event)
              if (hotkeyMatches(event, captureKey)) openCapture()
              else if (app.cmdk === true) closeCommandPalette()
              else openCommandPalette()
              return
            }
            if (event.key !== 'Escape') return
            // One keypress, one layer -- outermost first, and only the layer that
            // actually handled it stops the event.
            if (app.cmdk === true) { stopEvent(event); closeCommandPalette(); return }
            if (app.capture === true) {
              stopEvent(event)
              // Level 2 is "the layer is open but the caret is not in its box"
              // (the box handles its own Escape at level 0), so this one both
              // throws the draft away and closes: Escape on a layer nobody is
              // typing into means "get rid of it".
              setApp({ quick: '', qPreview: null })
              closeCapture()
              return
            }
            if (app.feishuSyncOpen === true) { stopEvent(event); setApp({ feishuSyncOpen: false }); return }
            if (app.planExportOpen === true) { stopEvent(event); setApp({ planExportOpen: false }); return }
            if (app.appearanceOpen === true) { stopEvent(event); setApp({ appearanceOpen: false }); return }
            if (app.confirm !== null) { stopEvent(event); settleConfirm(false); return }
            if (app.completionId !== null) {
              stopEvent(event)
              setApp({ completionId: null, completionDraft: null, completionError: null, completionSaving: false })
              return
            }
            if (app.listEditor !== null) { stopEvent(event); setApp({ listEditor: null }); return }
            if (app.openId !== null) { stopEvent(event); setApp({ openId: null }); return }
            if (app.float) { stopEvent(event); setFloat(false); return }
            if (app.fullscreen) { stopEvent(event); setApp({ fullscreen: false }) }
          }
          // The same chain, one phase earlier -- and deliberately one task later.
          //
          // Measured on the real host: at `--only 09-confirm` (modal:2, confirm:1,
          // fullscreen:1) three Escape presses changed nothing, because the event
          // arrives at `document` already `prevented:true, stopped:true` -- the host
          // stops it in the bubble path between our layers and `document`, so the
          // listener above never ran at all (its first guard is `defaultPrevented`).
          // A capture-phase listener on `document` runs BEFORE any bubble-phase
          // stopper, so it cannot be starved that way.
          //
          // It must not jump the queue, though: the capture box, the inline add boxes
          // and the rail's new-list box handle Escape themselves and call
          // `preventDefault` when they do (see the comment in the capture box -- one
          // keypress must not unwind two layers). So this pass does not ACT during
          // the capture phase; it defers one task and then acts only if nobody
          // consumed the key. `defaultPrevented` is the same signal the chain's own
          // first guard uses, which is what makes the two passes idempotent: in a
          // host without a stopper the bubble pass handles the key, and this one
          // wakes up, sees the flag and does nothing.
          //
          // With none of OUR layers open, the chain's Escape branches all fail and
          // the event is left alone -- the host keeps every key that belongs to it.
          const mayOwn = (event) => event.key === 'Escape'
            || hotkeyMatches(event, captureKey) || hotkeyMatches(event, paletteKey)
          // Which events the bubble pass saw. A WeakSet rather than a flag, and the
          // reason is not tidiness: `defaultPrevented` is not enough on its own,
          // because an event can arrive with no `preventDefault` to call (a stand-in
          // in a test document), and then the two passes would each close a layer.
          const reachedDocument = new WeakSet()
          const onKeyBubble = (event) => {
            if (event !== null && typeof event === 'object') reachedDocument.add(event)
            onKey(event)
          }
          const onKeyCapture = (event) => {
            if (!mayOwn(event)) return
            setTimeout(() => {
              if (reachedDocument.has(event)) return
              if (event.defaultPrevented === true) return
              onKey(event)
            }, 0)
          }
          document.addEventListener('keydown', onKeyBubble)
          document.addEventListener('keydown', onKeyCapture, true)
          return () => {
            document.removeEventListener('keydown', onKeyBubble)
            document.removeEventListener('keydown', onKeyCapture, true)
          }
        }, [])

        const data = state.data
        const tasks = data?.tasks ?? []
        const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [data])
        const childrenOf = useMemo(() => {
          const map = new Map()
          for (const t of tasks) {
            if (t.parentId === null) continue
            if (!map.has(t.parentId)) map.set(t.parentId, [])
            map.get(t.parentId).push(t.id)
          }
          return map
        }, [data])

        const stack = []
        if (state.fullscreen) stack.push(h(TodoApp, { key: 'fullscreen', mode: 'fullscreen' }))
        // The window outranks the fullscreen host (its z-index is higher) and
        // yields to the dialogs, which are pushed last for exactly that reason.
        if (state.float) stack.push(h(FloatTodo, { key: 'float' }))

        const openTask = state.openId === null ? null : byId.get(state.openId)
        if (openTask !== undefined && openTask !== null) {
          stack.push(h(TaskEditor, {
            key: 'dialog',
            task: openTask,
            state: { ...state, today: data?.today },
            byId,
            childrenOf,
            lists: data?.lists ?? [],
            onClose: () => setApp({ openId: null }),
            onOpen: openTaskDetails,
            onToggle: (id) => {
              const task = byId.get(id)
              if (task === undefined) return
              if (task.done === true) return mutate('toggle', { id, done: false })
              openCompletion(id, task)
            },
            onPatch: (id, fields) => mutate('update', { id, ...fields }),
            onSkip: (id) => mutate('skip', { id }),
            onDelete: (id) => mutate('remove', { id }),
            onAddSubtask: (parentId, title) => mutate('addSubtask', { parentId, title }),
            askDelete,
          }))
        }
        const completionTask = state.completionId === null ? null : byId.get(state.completionId)
        if (completionTask !== undefined && completionTask !== null) {
          stack.push(h(CompletionDialog, {
            key: 'completion',
            task: completionTask,
            state,
            onClose: () => setApp({
              completionId: null, completionDraft: null, completionError: null, completionSaving: false,
            }),
            onComplete: completeTask,
          }))
        }
        // The question is pushed LAST, because these layers all share one z-index
        // and fixed positioning: the document order is the paint order, so the
        // entry pushed last is the one the user can actually see and click. It can
        // be asked from the dialog, from a row, or from the rail.
        const editingList = state.listEditor === null
          ? null
          : (data?.lists ?? []).find((l) => l.id === state.listEditor) ?? null
        if (editingList !== null) {
          stack.push(h(ListEditor, {
            key: 'list-editor',
            list: editingList,
            lists: data?.lists ?? [],
            palette: data?.palette ?? [],
            byList: data?.counts?.byList ?? [],
            onClose: () => setApp({ listEditor: null }),
            onDelete: askDeleteList,
          }))
        }
        if (state.confirm !== null) stack.push(h(ConfirmLayer, { key: 'confirm' }))
        if (state.appearanceOpen === true) stack.push(h(AppearanceDialog, { key: 'appearance' }))
        if (state.planExportOpen === true) stack.push(h(PlanExportDialog, { key: 'plan-export' }))
        if (state.feishuSyncOpen === true && state.data?.settings?.feishu?.enabled === true) {
          stack.push(h(FeishuSyncDialog, { key: 'feishu-sync', state }))
        }
        // The capture layer and the palette are pushed last: they are the two
        // surfaces that must be reachable from anywhere, so nothing else may end
        // up painted over them.
        if (state.capture) stack.push(h(CaptureLayer, { key: 'capture' }))
        if (state.cmdk) stack.push(h(CommandPalette, { key: 'cmdk' }))
        if (stack.length === 0) return null
        // An array return keeps both entries as direct children of the overlay
        // layer, so neither one is wrapped in a box that could trap it.
        return stack
      }

      // ---------------------------------------------------------------------
      // sidebar seats
      // ---------------------------------------------------------------------

      /** Select the todo panel, or pass null to return to the Conversation. */
      function selectTodoPanel(panelId = 'todo') {
        const layout = ctx.get('layout')
        if (layout === undefined || typeof layout.selectPanel !== 'function') return
        try { layout.selectPanel(panelId) } catch (e) { console.warn('[todo] cannot select the panel:', e) }
      }

      /** Today's badge count, honouring the user's chosen measure. */
      function badgeCount(state) {
        const counts = state.data?.counts
        if (counts === undefined || counts === null) return 0
        const mode = state.data?.settings?.badgeCount ?? 'today'
        return mode === 'overdue' ? counts.overdue : mode === 'open' ? counts.open : counts.dueToday + counts.overdue
      }

      /**
       * The sidebar's global panel row: the shell owns the row, the label and the
       * click. Three things are ours:
       *   - the glyph and the count badge,
       *   - the SECOND click, which hides the panel again (the shell only ever
       *     selects, so re-clicking an open panel would otherwise be a no-op).
       *
       * The toggle is intercepted in the capture phase on `document`, because the
       * click has to be stopped before the shell's own handler turns it into a
       * selection. It stays inert while the panel is closed, so opening the panel
       * remains the shell's job.
       */
      function PanelIcon({ size, active }) {
        const state = useApp()
        const nodeRef = useRef(null)
        const activeRef = useRef(active)
        activeRef.current = active

        // This glyph is present in the sidebar from the first paint, before the
        // panel is ever opened, so it also warms the shared data.
        useEffect(() => { if (app.data === null && app.loading === false) refresh({}, true) }, [])

        useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onCapture = (event) => {
            if (activeRef.current !== true) return
            const node = nodeRef.current
            if (node === null || node === undefined) return
            const target = event.target
            if (target === null || typeof target.closest !== 'function') return
            const row = target.closest('button')
            // Only our own row: the button that contains this glyph.
            if (row === null || typeof row.contains !== 'function' || !row.contains(node)) return
            event.preventDefault()
            event.stopPropagation()
            setApp({ fullscreen: false })
            selectTodoPanel(null)
          }
          document.addEventListener('click', onCapture, true)
          return () => document.removeEventListener('click', onCapture, true)
        }, [])

        const edge = Number(size) || 18
        const badge = badgeCount(state)
        return h('span', {
          ref: nodeRef,
          className: 'td-seat td-glyphwrap',
          'data-todo-appearance': appearanceKey(state.data?.settings),
          style: { position: 'relative', display: 'inline-flex' },
        },
          h('svg', {
            width: edge, height: edge, viewBox: '0 0 20 20', fill: 'none',
            stroke: active ? 'var(--td-brand)' : 'currentColor',
            strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
            h('path', { d: 'M3 5.5h1.6M3 10h1.6M3 14.5h1.6' }),
            h('path', { d: 'M7.5 5.5H17M7.5 10H17M7.5 14.5H13.5' })),
          badge <= 0
            ? null
            : h('span', {
              className: 'td-glyphbadge',
              title: '待办任务',
            }, badge > 99 ? '99+' : String(badge)))
      }

      // ---------------------------------------------------------------------
      // the settings page (settings.section)
      //
      // The plugin owns this page. DSH's Plugins page only hosts tabs that a
      // feature package registers, and the settings service on this DSH line has
      // no scope API to register a schema with -- so before this page existed,
      // the plugin's `feishu` block had nowhere to be filled in. The form is
      // generated from the schema the host sends (`/todo/api/settings`), so a
      // field added there shows up here without touching this file.
      // ---------------------------------------------------------------------

      /** Read a dotted path (`feishu.appId`) out of the draft. */
      function getPath(source, dotted) {
        return dotted.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), source)
      }

      /** Copy-on-write a dotted path, so React sees a new object. */
      function setPath(source, dotted, value) {
        const keys = dotted.split('.')
        const out = { ...source }
        let node = out
        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i]
          node[key] = node[key] !== null && typeof node[key] === 'object' ? { ...node[key] } : {}
          node = node[key]
        }
        node[keys[keys.length - 1]] = value
        return out
      }

      /** A `select` option's user-facing text, where the stored value is an id. */
      function optionLabel(value) {
        if (value === 'flat') return '简洁扁平'
        if (value === 'editorial') return '杂志编辑'
        if (value === 'playful') return '活力闯关'
        if (value === 'c1') return '藕粉雾蓝'
        if (value === 'c2') return '樱花奶油'
        if (value === 'c3') return '薄荷奶霜'
        if (value === 'c4') return '蜜桃乌龙'
        if (value === 'today') return '今天到期 + 逾期'
        if (value === 'overdue') return '仅逾期'
        if (value === 'open') return '全部未完成'
        return value
      }

      /** Lines describing one sync summary (or a dry-run plan). */
      // (defined at factory scope, above the returned plugin object -- see
      //  `reportLines` there -- so `__internals` and this component share ONE
      //  implementation of the wording the user reads.)
      const syncLines = reportLines.sync
      const probeLines = reportLines.probe
      const fieldLines = reportLines.fields
      const reconcileLines = reportLines.reconcile
      const pullLines = reportLines.pull
      const resolveAllLines = reportLines.resolveAll

      /**
       * One input, chosen by the type the host's schema sent.
       *
       * `appSecret` is treated specially: it is stored but never sent back, so a
       * blank field means "keep what is stored" and the placeholder says so.
       */
      function settingsInput(field, value, onChange, secretSet) {
        if (field.type === 'boolean') {
          return h('label', { className: 'td-set-checkline' },
            h('input', {
              className: 'td-set-check',
              type: 'checkbox',
              checked: value === true,
              'aria-label': field.title,
              onChange: (event) => onChange(event.target.checked),
            }),
            h('span', { className: 'td-set-state' }, value === true ? '已开启' : '已关闭'))
        }
        if (Array.isArray(field.options)) {
          return h('select', {
            className: 'td-set-input',
            value: String(value ?? ''),
            'aria-label': field.title,
            onChange: (event) => onChange(field.type === 'number' ? Number(event.target.value) : event.target.value),
          }, field.options.map((option) => h('option', { key: String(option), value: String(option) },
            field.type === 'number' ? (String(option) === '1' ? '周一' : '周日') : optionLabel(String(option)))))
        }
        const secret = field.path === 'feishu.appSecret'
        const numeric = field.type === 'number'
        const state = secret && secretSet === true ? '已保存；留空表示不修改' : ''
        return h('input', {
          className: field.path.endsWith('Token') || field.path.endsWith('tableId') ? 'td-set-input mono' : 'td-set-input',
          type: secret ? 'password' : numeric ? 'number' : 'text',
          ...(numeric && Number.isFinite(field.minimum) ? { min: field.minimum } : {}),
          ...(numeric && Number.isFinite(field.maximum) ? { max: field.maximum } : {}),
          ...(numeric ? { step: 1 } : {}),
          value: value === undefined || value === null ? '' : String(value),
          placeholder: state,
          autoComplete: 'off',
          spellCheck: 'false',
          'aria-label': field.title,
          onChange: (event) => onChange(numeric
            ? (event.target.value === '' ? 0 : Number(event.target.value))
            : event.target.value),
        })
      }

      /**
       * The settings page registered as a `settings.section`, so it appears in
       * DSH's settings beside the other plugin pages.
       *
       * It also carries the sync buttons: configuring Feishu and then verifying it
       * is one task, and the alternative -- configure here, then ask the agent to
       * run a tool -- is exactly the round trip this page exists to remove. The
       * preview button runs the real planner with `dryRun`, so "will this change
       * anything" is answered without touching the table.
       */
      function TodoSettingsSection() {
        const [view, setView] = useState(null)
        const [draft, setDraft] = useState(null)
        const [busy, setBusy] = useState('')
        const [message, setMessage] = useState(null)
        const [report, setReport] = useState(null)
        const [decision, setDecision] = useState(null)
        const [syncPreviewToken, setSyncPreviewToken] = useState('')
        const [remotePreviewToken, setRemotePreviewToken] = useState('')
        // What the last reverse-import answer contained: how much can be applied
        // as-is, and how much needs a direction decision. The decision row reads
        // this, so a preview with only conflicts still offers the bulk answers.
        const [remoteAsk, setRemoteAsk] = useState({ planned: 0, conflicts: 0, shown: [] })

        /** The conflicts exactly as the report shows them, for a bulk decision. */
        const shownConflicts = (items) => (Array.isArray(items) ? items : []).map((item) => ({
          key: item.key,
          operation: 'field',
          title: item.title ?? '',
          changes: (item.changes ?? []).map((change) => ({
            field: change.field,
            local: String(change.local ?? ''),
            remote: String(change.remote ?? ''),
          })),
        }))

        const load = useCallback(async () => {
          setBusy('loading')
          try {
            const data = await call('settings')
            setView(data)
            setDraft(data.values)
            setMessage(null)
          } catch (e) {
            setMessage({ kind: 'error', text: String(e?.message ?? e) })
          } finally {
            setBusy('')
          }
        }, [])

        useEffect(() => { load() }, [load])

        const save = async () => {
          setBusy('saving')
          try {
            // The patch is the whole draft: the host merges it over what is
            // stored, so a field this page does not render keeps its value.
            const data = await call('updateSettings', draft)
            setView(data)
            setDraft(data.values)
            setMessage({ kind: 'ok', text: '设置已保存' })
            toast('设置已保存')
            refresh({}, true)
          } catch (e) {
            setMessage({ kind: 'error', text: String(e?.message ?? e) })
          } finally {
            setBusy('')
          }
        }

        /**
         * Save the draft, then run one Feishu action.
         *
         * Everything that talks to Feishu saves first: the user has just typed
         * the credentials, and acting on the previous ones reads as a bug. The
         * read-only actions (test / fields / reconcile) are run straight from the
         * saved settings on the host, so they work before the sync switch is on.
         */
        const run = async (kind) => {
          setBusy(kind)
          try {
            const feishuActions = new Set([
              'sync', 'syncDry', 'syncPush', 'syncSkip', 'pull', 'pullDry',
              'applyRemoteDry', 'applyRemoteConfirm',
              'resolveAllLocal', 'resolveAllRemote',
            ])
            if (feishuActions.has(kind)) {
              const data = await call('updateSettings', draft)
              setView(data)
              setDraft(data.values)
            }
            if (kind === 'test') {
              const probe = await call('feishuTest')
              setReport({ title: '测试连接', lines: probeLines(probe), ok: probe.ok === true })
              setDecision(null)
              setMessage(probe.ok === true ? { kind: 'ok', text: '连接正常' } : null)
            } else if (kind === 'fields') {
              const result = await call('feishuFields', {})
              setReport({ title: '补全字段', lines: fieldLines(result), ok: result.failed.length === 0 })
              setDecision(null)
            } else if (kind === 'reconcile') {
              const summary = await call('feishuReconcile', {})
              setReport({ title: '完整对账', lines: reconcileLines(summary), ok: true })
              setDecision(null)
            } else if (kind === 'pull' || kind === 'pullDry') {
              const summary = await call('feishuPull', kind === 'pullDry' ? { dryRun: true } : {})
              setReport({ title: kind === 'pullDry' ? '从飞书补洞（预览）' : '从飞书补洞', lines: pullLines(summary), ok: true })
              setDecision(null)
              if (kind === 'pull') refresh({}, true)
            } else if (kind === 'applyRemoteDry') {
              // The preview is the same three-way merge the entry check runs, so
              // the report distinguishes what will be applied from the fields
              // whose direction only the user can decide.
              const result = await call('feishuApplyRemote', { dryRun: true })
              const conflictItems = Array.isArray(result.conflicts) ? result.conflicts : []
              const conflictCount = conflictItems.reduce((total, item) => total + (item.changes ?? []).length, 0)
              setRemotePreviewToken(result.previewToken ?? '')
              // The displayed items ride along with a bulk decision, so a stale
              // preview is refused instead of applied.
              setRemoteAsk({
                planned: Number(result.planned) || 0,
                conflicts: conflictCount,
                shown: shownConflicts(conflictItems),
              })
              setReport({ title: '从飞书更新本地（预览）', lines: reportLines.applyRemote(result), ok: true })
              setDecision(result.planned > 0 || conflictCount > 0 ? 'applyRemote' : null)
              // The detailed report sits below a long settings form and can land
              // outside the viewport. Keep a persistent, top-of-page response so
              // a completed preview never looks like the button only flashed.
              setMessage({
                kind: 'ok',
                text: result.planned > 0
                  ? `飞书预览已完成：匹配 ${result.matched} 项，发现 ${result.differing} 个字段差异，可更新 ${result.planned} 项。请查看下方报告。`
                  : conflictCount > 0
                    ? `飞书预览已完成：匹配 ${result.matched} 项，没有可自动应用的差异；${conflictCount} 个字段需要选择方向（见下方报告）。`
                    : `飞书预览已完成：匹配 ${result.matched} 项，没有可应用的差异。`,
              })
            } else if (kind === 'applyRemoteConfirm') {
              const result = await call('feishuApplyRemote', { previewToken: remotePreviewToken })
              const conflictItems = Array.isArray(result.conflicts) ? result.conflicts : []
              const conflictCount = conflictItems.reduce((total, item) => total + (item.changes ?? []).length, 0)
              setReport({
                title: result.stale === true ? '预览已过期' : '从飞书更新本地',
                lines: reportLines.applyRemote(result),
                ok: result.stale !== true && result.skipped.length === 0,
              })
              setRemoteAsk({ planned: 0, conflicts: conflictCount, shown: shownConflicts(conflictItems) })
              setDecision(conflictCount > 0 ? 'applyRemote' : null)
              setRemotePreviewToken('')
              setMessage(result.stale === true
                ? { kind: 'error', text: '预览已过期，没有更新本地任务；请重新预览。' }
                : { kind: 'ok', text: `飞书数据处理完成：已更新 ${result.updated} 项（${result.updatedFields} 个字段）`
                  + (conflictCount > 0 ? `；另有 ${conflictCount} 个字段需要选择方向。` : '。') })
              if (result.updated > 0) refresh({}, true)
            } else if (kind === 'resolveAllLocal' || kind === 'resolveAllRemote') {
              // 「全部保留本地」/「全部采用飞书」: the SAME decision the conflict
              // dialog in the task view applies, so the two surfaces can never
              // disagree about what "keep local" or "adopt Feishu" means.
              const direction = kind === 'resolveAllRemote' ? 'remote' : 'local'
              const result = await call('feishuResolveAllConflicts', {
                direction,
                ...(remoteAsk.shown.length > 0 ? { conflicts: remoteAsk.shown } : {}),
              })
              const label = direction === 'remote' ? '全部采用飞书' : '全部保留本地'
              setReport({
                title: result.stale === true ? `${label}（预览已过期）` : label,
                lines: resolveAllLines(result),
                ok: result.stale !== true && (result.failed ?? []).length === 0,
              })
              setDecision(null)
              setRemotePreviewToken('')
              setRemoteAsk({ planned: 0, conflicts: Number(result.remaining) || 0, shown: [] })
              setMessage(result.stale === true
                ? { kind: 'error', text: `${label}没有写入：预览已过期，请重新预览后再处理。` }
                : { kind: 'ok', text: `${label}：已处理 ${result.resolved ?? 0} 项`
                  + ((result.failed ?? []).length > 0 ? `，${result.failed.length} 项仍需逐项选择。` : '。') })
              refresh({}, true)
            } else if (kind === 'syncDry') {
              const summary = await call('syncFeishu', { dryRun: true })
              setSyncPreviewToken(summary.previewToken ?? '')
              setReport({ title: '预览同步', lines: syncLines(summary), ok: summary.blocked !== true })
              setDecision(summary.blocked === true ? 'sync' : null)
            } else if (kind === 'sync') {
              // A write click first runs the exact dry-run planner. If remote-side
              // edits exist, the report offers explicit choices before any write.
              const preview = await call('syncFeishu', { dryRun: true })
              setSyncPreviewToken(preview.previewToken ?? '')
              if (preview.blocked === true) {
                setReport({ title: '同步前需要处理差异', lines: syncLines(preview), ok: false })
                setDecision('sync')
              } else {
                const summary = await call('syncFeishu', { expectedToken: preview.previewToken })
                setReport({
                  title: summary.stale === true ? '预览已过期' : summary.blocked ? '同步前需要处理差异' : '立即同步',
                  lines: syncLines(summary),
                  ok: summary.blocked !== true,
                })
                setDecision(summary.blocked === true && summary.stale !== true ? 'sync' : null)
                if (summary.blocked !== true) refresh({}, true)
              }
            } else if (kind === 'syncPush' || kind === 'syncSkip') {
              const summary = await call('syncFeishu', {
                conflictPolicy: kind === 'syncPush' ? 'push' : 'skip',
                expectedToken: syncPreviewToken,
              })
              setReport({
                title: summary.stale === true ? '预览已过期' : kind === 'syncPush' ? '按本地覆盖飞书' : '跳过冲突后同步',
                lines: syncLines(summary),
                ok: summary.blocked !== true,
              })
              setDecision(summary.blocked === true && summary.stale !== true ? 'sync' : null)
              if (summary.blocked !== true) refresh({}, true)
            }
          } catch (e) {
            setReport(null)
            setDecision(null)
            setMessage({ kind: 'error', text: String(e?.message ?? e) })
          } finally {
            setBusy('')
          }
        }


        if (view === null || draft === null) {
          return h('div', {
            className: 'td-seat td-set',
            'data-todo-appearance': appearanceKey(),
          },
            h('div', { className: 'td-set-head' },
              h('h2', { className: 'td-set-title' }, '待办任务'),
              h('p', { className: 'td-set-sub' }, busy === 'loading' ? '正在读取设置…' : '正在准备…')),
            message === null ? null : h('div', { className: 'td-set-banner error' }, message.text))
        }

        const groups = Array.isArray(view.groups) ? view.groups : []
        const button = (label, kind, extra) => h('button', {
          className: extra === true ? 'td-set-btn primary' : 'td-set-btn',
          type: 'button',
          disabled: busy !== '',
          onClick: () => run(kind),
        }, busy === kind ? `${label}…` : label)
        return h('div', {
          className: 'td-seat td-set',
          'data-todo-appearance': appearanceKey(draft),
        },
          h('div', { className: 'td-set-head' },
            h('h2', { className: 'td-set-title' }, groups[0]?.title ?? '待办任务'),
            h('p', { className: 'td-set-sub' }, `设置文件：${view.file}`)),
          view.error === null || view.error === undefined
            ? null
            : h('div', { className: 'td-set-banner error' }, view.error),
          message === null
            ? null
            : h('div', {
              className: message.kind === 'error' ? 'td-set-banner error' : 'td-set-banner ok',
            }, message.text),
          groups.map((group) => h('section', { className: 'td-set-group', key: group.key || 'top' },
            h('div', { className: 'td-set-grouphead' },
              h('div', { className: 'td-set-grouptitle' }, group.title),
              group.description === '' ? null : h('div', { className: 'td-set-groupdesc' }, group.description)),
            group.fields.map((field, index) => h('div', {
              className: index === 0 ? 'td-set-row first' : 'td-set-row',
              key: field.path,
            },
            h('div', { className: 'td-set-name' }, field.title),
            settingsInput(field, getPath(draft, field.path), (value) => setDraft((current) => setPath(current, field.path, value)), view.secretSet),
            field.description === undefined ? null : h('div', { className: 'td-set-desc' }, field.description))))),
          // The footer is two tiers, not one eleven-button row. Tier 1 is the FORM
          // (save / reload) and stays on its own line; tier 2 is the Feishu
          // toolbox, grouped by the direction of the work: check, push, pull.
          // A flat row made the destructive write buttons sit next to 保存 and
          // two visually unrelated "飞书 → 本地" actions look interchangeable.
          h('div', { className: 'td-set-footer' },
            h('div', { className: 'td-set-actions td-set-footerhead' },
              h('button', {
                className: 'td-set-btn primary', type: 'button', disabled: busy !== '', onClick: save,
              }, busy === 'saving' ? '保存中…' : '保存'),
              h('button', {
                className: 'td-set-btn', type: 'button', disabled: busy !== '', onClick: load,
              }, '重新载入'),
              h('span', { className: 'td-set-hint' }, '下面的飞书操作会先保存当前填写，再执行。')),
            h('div', { className: 'td-set-sync' },
              h('div', { className: 'td-set-syncgroup' },
                h('div', { className: 'td-set-synctitle' }, '连接与检查'),
                h('div', { className: 'td-set-actions' },
                  button('测试连接', 'test'),
                  button('补全字段', 'fields'),
                  button('完整对账', 'reconcile'))),
              h('div', { className: 'td-set-syncgroup' },
                h('div', { className: 'td-set-synctitle' }, '本地 → 飞书'),
                h('div', { className: 'td-set-actions' },
                  button('预览同步', 'syncDry'),
                  button('立即同步', 'sync'))),
              h('div', { className: 'td-set-syncgroup' },
                h('div', { className: 'td-set-synctitle' }, '飞书 → 本地'),
                h('div', { className: 'td-set-actions' },
                  button('从飞书更新本地（预览）', 'applyRemoteDry'),
                  h('button', {
                    className: 'td-set-btn',
                    type: 'button',
                    disabled: busy !== '',
                    onClick: () => run('pullDry'),
                  }, busy === 'pullDry' ? '从飞书补洞（预览）…' : '从飞书补洞（预览）'),
                  button('从飞书补洞', 'pull'))))),
          report === null
            ? null
            : h('div', { className: 'td-set-report' },
              h('div', { className: 'td-set-reporttitle' }, report.title + (report.ok === true ? '' : '（未通过）')),
              report.lines.map((line, index) => h('div', { className: 'td-set-reportline', key: `${index}:${line}` }, line)),
              decision === 'sync'
                ? h('div', { className: 'td-set-actions td-set-decisions' },
                  button('按本地覆盖飞书', 'syncPush', true),
                  button('按飞书更新本地（先预览）', 'applyRemoteDry'),
                  button('跳过冲突并同步安全项', 'syncSkip'),
                  h('button', { className: 'td-set-btn', type: 'button', disabled: busy !== '', onClick: () => setDecision(null) }, '暂不处理'))
                : decision === 'applyRemote'
                  ? h('div', { className: 'td-set-actions td-set-decisions' },
                    remoteAsk.planned > 0 ? button('确认应用以上预览', 'applyRemoteConfirm', true) : null,
                    // The same two bulk answers the conflict dialog offers in
                    // the task view: one call decides every ambiguous field.
                    remoteAsk.conflicts > 0 ? button('全部采用飞书', 'resolveAllRemote') : null,
                    remoteAsk.conflicts > 0 ? button('全部保留本地', 'resolveAllLocal') : null,
                    h('button', { className: 'td-set-btn', type: 'button', disabled: busy !== '', onClick: () => setDecision(null) }, '取消'))
                  : null))
      }

      // ---------------------------------------------------------------------
      // registration
      // ---------------------------------------------------------------------

      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const tagId = 'dsh-task-todo/todo.css'
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-task-todo'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      })

      // This action copies plain task text to the system clipboard for reuse in
      // any app. It is intentionally shown in the main list/board menus; the
      // floating window has its separate DSH-composer action below.
      ctx.effect(() => {
        if (todoTaskActionsApi === null) return undefined
        return todoTaskActionsApi.register({
          id: TODO_COPY_TASK_CONTENT_ACTION_ID,
          label: '复制任务内容和备注信息',
          order: 80,
          run: async (task) => {
            const title = typeof task?.title === 'string' ? task.title : ''
            const note = typeof task?.note === 'string' ? task.note : ''
            const content = title === '' ? note : note === '' ? title : `${title}\n\n${note}`
            if (content === '') return '该任务没有可复制的内容'
            const copied = await writeClipboard(content)
            return copied ? '已复制任务内容和备注信息' : '复制失败，请检查剪贴板权限后重试'
          },
        })
      }, 'todo: copy task content and note')

      // This action uses only ui-conversation's public session input face. It
      // inserts at the composer's saved caret, keeps any existing draft, and
      // never invokes the submit action.
      ctx.effect(() => {
        if (todoTaskActionsApi === null) return undefined
        return todoTaskActionsApi.register({
          id: TODO_COPY_TO_DSH_CHAT_ACTION_ID,
          label: '复制到dsh对话',
          order: 90,
          enabled: () => todoComposerStatus().enabled,
          disabledReason: () => todoComposerStatus().reason,
          run: (task) => {
            const status = todoComposerStatus()
            if (!status.enabled) {
              return status.reason || '请先打开或切回一个 DSH 对话，再从浮动待办窗口操作'
            }
            const title = typeof task?.title === 'string' ? task.title : ''
            const note = typeof task?.note === 'string' ? task.note : ''
            const content = title === '' ? note : note === '' ? title : `${title}\n\n${note}`
            if (content === '') return '该任务没有可复制的内容'

            const { target, state } = status
            let span
            try { span = target.inputActions.captureInsertion() } catch {
              return '无法读取当前 DSH 对话光标位置，请重试'
            }
            if (span?.draftRev !== state.draftRev) return '对话输入内容刚刚变化，请重新打开任务菜单后重试'

            // A blank composer receives exactly the task text; a non-empty draft
            // keeps its content and gets the task as a clearly separated block.
            const hasDraft = typeof state.draft === 'string' && state.draft !== ''
            const insertedText = hasDraft ? `\n\n${content}\n\n` : content
            let inserted = false
            try { inserted = target.inputActions.insertText(insertedText, span) } catch { /* report below */ }
            if (!inserted) return '当前 DSH 对话输入框已变化或不可编辑，未填入；请重试'
            try { target.sessionInput.focus?.() } catch { /* text is already inserted; focus is best-effort */ }
            return '已填入当前 DSH 对话输入框（未发送）'
          },
        })
      }, 'todo: copy task to DSH conversation')

      // The hidden bridge lives in a strict Session slot, where ui-conversation
      // supplies `inputActions`. Resolve that exact retained Session's public
      // SessionInput only for state/focus; never reach into the editor DOM.
      try {
        ctx.effect(() => slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'todo-copy-to-dsh-chat-bridge',
          order: -100,
          inject: (sessionId) => {
            let sessionInput = null
            try {
              const binding = sessions?.binding?.(sessionId)
              if (binding !== undefined && typeof conversation?.input?.for === 'function') {
                sessionInput = conversation.input.for(binding.ctx)
              }
            } catch (error) {
              console.warn('[todo] could not resolve the current DSH input:', error)
            }
            return { sessionInput }
          },
        }, TodoComposerBridge)))
      } catch (error) {
        console.warn('[todo] DSH composer bridge registration failed:', error)
      }

      // Every seat goes through `ctx.effect`, so its registration is disposed
      // with the plugin fiber instead of surviving a reload: a client half can be
      // hot-reloaded, and a leaked registration would stack a second
      // sidebar row / settings entry on every reload. This is the shape
      // `dsh-style-gallery` uses for the same slot.
      try {
        ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'todo', order: 30, label: '待办任务' },
          PanelIcon,
        )))
      } catch (e) {
        console.error('[todo] sidebar.panellist registration failed:', e)
      }

      try {
        ctx.effect(() => slots.inject('main', () => slots.register(
          { name: 'main', key: 'todo' },
          TodoMain,
        )))
      } catch (e) {
        console.error('[todo] main panel registration failed:', e)
      }

      try {
        ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'todo-overlay', order: 60 },
          TodoOverlay,
        )))
      } catch (e) {
        console.error('[todo] overlay registration failed:', e)
      }

      // The plugin's own settings page, as its own entry in DSH's settings nav
      // (the same route `dsh-style-gallery`, `dsh-plugin-aitm` and `dshmarket`
      // use). Without it the plugin's settings have no UI at all: DSH's Plugins
      // page only hosts tabs a feature package contributes, and the `settings`
      // service on this DSH line has no scope/`register` API to publish a schema
      // through -- which is why a user could not find the Feishu form.
      try {
        ctx.effect(() => slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'todo', order: 55, label: () => '待办任务' },
          TodoSettingsSection,
        )))
      } catch (e) {
        console.error('[todo] settings section registration failed:', e)
      }
    },

    /**
     * Pure display helpers exposed for the render/assert test harness. The browser
     * never reads this: it exists so the calendar arithmetic can be asserted
     * directly, against the very functions the UI calls.
     */
    __internals: {
      parseDue,
      dayIndexOf,
      dateFromIndex,
      addDaysStr,
      monthOf,
      addMonthsStr,
      monthGrid,
      weekdayHeaders,
      fmtDue,
      fmtDateFull,
      recurrenceRuleText,
      todayStr,
      // The settings page's report builders. Exposed for the same reason as the
      // calendar arithmetic above: the shapes they consume come from the host,
      // and a wrong assumption there renders as "undefined 行" instead of failing
      // anything -- so the gate asserts the rendered text directly.
      syncLines: reportLines.sync,
      probeLines: reportLines.probe,
      fieldLines: reportLines.fields,
      reconcileLines: reportLines.reconcile,
      pullLines: reportLines.pull,
      applyRemoteLines: reportLines.applyRemote,
      resolveAllLines: reportLines.resolveAll,
    },
    }
  },
})
