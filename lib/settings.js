/**
 * dsh-task-todo -- where the plugin's own settings live.
 *
 * This module exists because of a recorded incident. The plugin used to hand
 * its settings to DSH's settings service:
 *
 *     const scope = ctx.settings.register('todo', SETTINGS_SCHEMA)
 *     svc.applySettings(scope?.get?.() ?? DEFAULTS)
 *     ctx.effect(() => scope?.watch?.((v) => svc.applySettings(v)) ?? (() => {}))
 *
 * On the DSH line this plugin runs on (`@deepseek-ai/dsh` 0.2.0-rc.2) that API
 * does not exist. The `settings` service is `@deepseek-ai/dsh-settings`'s
 * `SettingsForms` (`configure` / `describe` / `update` / `schema` /
 * `invalidate` / `prepareDocument`); the file-backed service that used to offer
 * `register(scope, schema)` is no longer in the composition at all. So the call
 * threw `TypeError: ctx.settings.register is not a function`, the surrounding
 * `try/catch` swallowed it into one log line, and `applySettings` was never
 * called with anything but DEFAULTS -- meaning every setting was inert, not
 * just the Feishu block that a user would notice first.
 *
 * The plugin therefore owns its settings outright: one small JSON document next
 * to the task file, written atomically, read and written through the same HTTP
 * API the rest of the UI uses, and edited on a page the plugin registers itself
 * (`settings.section`). Nothing here depends on a host settings API, and the
 * behaviour is identical on `dsh web` and DSH desktop.
 *
 * The document is a plain JSON object keyed like `DEFAULTS` in `index.js`. It
 * is deliberately separate from `tasks.json`: settings are configuration, not
 * user content, and a user who deletes their task file must not lose the
 * Feishu credentials with it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where the plugin keeps its data, honouring DSH_HOME like the rest of DSH. */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * The settings document: `<DSH_HOME>/todo/settings.json`.
 *
 * `DSH_HOME` is shared by the web and desktop profiles, so a value typed in
 * one is the value the other reads -- the same rule `tasks.json` follows.
 */
export function defaultSettingsFile() {
  return path.join(dshHome(), 'todo', 'settings.json')
}

/**
 * Read the settings document.
 *
 * Never throws: a missing file is the normal first run, and a corrupt one must
 * not stop the plugin from booting. The caller decides how loudly to say so;
 * `error` is returned rather than logged so the settings page can show it.
 *
 * @param {string} file - absolute path of the settings document.
 * @returns {{ values: object, error: string | null }} parsed values (possibly
 *   empty) plus a human-readable problem, if any.
 */
export function readSettingsFile(file) {
  try {
    if (!fs.existsSync(file)) return { values: {}, error: null }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { values: {}, error: `${file} 不是一个 JSON 对象，已按默认设置处理` }
    }
    return { values: parsed, error: null }
  } catch (e) {
    return { values: {}, error: `读取设置失败：${String(e?.message ?? e)}` }
  }
}

/**
 * Write the document atomically: a temp file plus a rename.
 *
 * A half-written settings file is worse than a missing one -- it would parse as
 * valid JSON with settings missing -- and rename is the one step that cannot
 * leave a partial document behind.
 */
export function writeSettingsFile(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}
