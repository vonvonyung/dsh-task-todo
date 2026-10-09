// The plugin's own settings.
//
// This gate exists because settings were once wired to an API that does not
// exist on this DSH line (`ctx.settings.register(scope, schema)`, swallowed by a
// try/catch), which made every setting silently inert -- a user could not
// enable Feishu at all and had no page to fill the credentials on. The checks
// below are the ones that would have caught it:
//
//   * the settings document is read, layered and written by the plugin itself;
//   * the settings page's payload is derived from the schema (so a field added
//     to `SETTINGS_SCHEMA` cannot go missing from the form);
//   * `appSecret` is stored but never echoed back;
//   * a partial save cannot blank a field it did not send.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

import { TodoService } from '../lib/index.js'
import {
  defaultSettingsFile, readSettingsFile, writeSettingsFile,
} from '../lib/settings.js'

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

const dir = fs.mkdtempSync(path.join(import.meta.dirname, '..', '.tmp-settings-'))
const quiet = () => {}

// ---------------------------------------------------------------------------
// the document itself
// ---------------------------------------------------------------------------

console.log('--- where the document lives ---')
const home = process.env.DSH_HOME
delete process.env.DSH_HOME
eq('without DSH_HOME the file sits under ~/.dsh', defaultSettingsFile(), path.join(os.homedir(), '.dsh', 'todo', 'settings.json'))
if (home === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = home
process.env.DSH_HOME = dir
eq('DSH_HOME moves the file', defaultSettingsFile(), path.join(dir, 'todo', 'settings.json'))

console.log('--- reading a document ---')
const missing = path.join(dir, 'nope.json')
eq('a missing file is empty, not an error', readSettingsFile(missing), { values: {}, error: null })
const corrupt = path.join(dir, 'corrupt.json')
fs.writeFileSync(corrupt, '{ this is not json', 'utf8')
ok('a corrupt file reports an error', readSettingsFile(corrupt).error !== null)
eq('a corrupt file yields no values', readSettingsFile(corrupt).values, {})
const arrayFile = path.join(dir, 'array.json')
fs.writeFileSync(arrayFile, '[1,2,3]', 'utf8')
ok('an array is refused with an error', readSettingsFile(arrayFile).error !== null)
const roundTrip = path.join(dir, 'round', 'settings.json')
writeSettingsFile(roundTrip, { a: 1, feishu: { appId: 'x' } })
eq('a write round-trips', readSettingsFile(roundTrip).values, { a: 1, feishu: { appId: 'x' } })
ok('a write creates the directory', fs.existsSync(roundTrip))
ok('a write leaves no temp file behind', !fs.existsSync(`${roundTrip}.tmp`))
ok('a write ends with a newline', fs.readFileSync(roundTrip, 'utf8').endsWith('\n'))
fs.writeFileSync(corrupt, 'null', 'utf8')
ok('a JSON null is refused, not accepted as empty values', readSettingsFile(corrupt).error !== null)

// ---------------------------------------------------------------------------
// the service: layering and the form payload
// ---------------------------------------------------------------------------

console.log('--- layering: defaults, then the entry config, then the file ---')
const fileOf = (name) => path.join(dir, name)
const fresh = (opts = {}) => new TodoService(null, quiet, { settingsFile: fileOf('svc.json'), ...opts })

const plain = fresh()
eq('with no file, the schema defaults win', plain.settings.feishu.enabled, false)
eq('the default key field is 任务ID', plain.settings.feishu.keyField, '任务ID')

const seeded = fresh({ hostConfig: { weekStart: 0, badgeCount: 'overdue', feishu: { appId: 'from-patch' } } })
eq('the entry config seeds a scalar', seeded.settings.weekStart, 0)
eq('the entry config seeds the badge measure', seeded.settings.badgeCount, 'overdue')
eq('the entry config seeds the Feishu block', seeded.settings.feishu.appId, 'from-patch')
eq('seeding one Feishu field keeps the rest of the block', seeded.settings.feishu.keyField, '任务ID')
eq('seeding Feishu does not enable it', seeded.settings.feishu.enabled, false)

const layeredFile = fileOf('layered.json')
writeSettingsFile(layeredFile, { badgeCount: 'open', feishu: { appId: 'from-file' } })
const layered = new TodoService(null, quiet, {
  settingsFile: layeredFile,
  hostConfig: { weekStart: 0, badgeCount: 'overdue', feishu: { appId: 'from-patch', tableId: 'tbl-from-patch' } },
})
eq('the file wins over the seeded scalar', layered.settings.badgeCount, 'open')
eq('the file wins over the seeded Feishu field', layered.settings.feishu.appId, 'from-file')
eq('a field only the entry config sets survives', layered.settings.feishu.tableId, 'tbl-from-patch')

console.log('--- the form payload is derived from the schema ---')
const form = plain.settingsForForm()
eq('the payload names the settings file', form.file, fileOf('svc.json'))
eq('there is no error on a clean read', form.error, null)
eq('the groups are the schema groups', form.groups.map((g) => g.key), ['', 'hotkey', 'feishu'])
const paths = form.groups.flatMap((g) => g.fields.map((f) => f.path))
for (const expected of ['enabled', 'dataFile', 'weekStart', 'defaultList', 'badgeCount',
  'hotkey.capture', 'hotkey.palette', 'feishu.enabled', 'feishu.appId', 'feishu.appSecret',
  'feishu.appToken', 'feishu.tableId', 'feishu.baseUrl', 'feishu.autoSync', 'feishu.syncSubtasks',
  'feishu.includeDone', 'feishu.deleteRemoved', 'feishu.keyField']) {
  ok(`the form carries ${expected}`, paths.includes(expected))
}
const fields = form.groups.flatMap((g) => g.fields)
eq('every field carries a title', fields.every((f) => typeof f.title === 'string' && f.title !== ''), true)
eq('every field carries a type', fields.every((f) => ['string', 'boolean', 'number'].includes(f.type)), true)
eq('the badge measure renders as a select', fields.find((f) => f.path === 'badgeCount').options, ['today', 'overdue', 'open'])
eq('the week start renders as a select', fields.find((f) => f.path === 'weekStart').options, [1, 0])
eq('a boolean field is typed as one', fields.find((f) => f.path === 'feishu.enabled').type, 'boolean')
gate('the settings payload is lossless JSON', form)
gate('the state payload is lossless JSON', plain.state())

console.log('--- the secret is write-only ---')
const saved = plain.updateSettings({ feishu: { enabled: true, appId: 'cli_1', appSecret: 'super-secret', appToken: 'tok', tableId: 'tbl' } })
eq('the secret is recorded as set', saved.secretSet, true)
eq('the secret is not echoed back', saved.values.feishu.appSecret, '')
ok('the secret really is on disk', fs.readFileSync(fileOf('svc.json'), 'utf8').includes('super-secret'))
gate('the payload after a save is lossless JSON', saved)
eq('the saved values are live', plain.settings.feishu.enabled, true)
eq('the sync is now considered configured', plain.feishuStatus().configured, true)

const blank = plain.updateSettings({ feishu: { appSecret: '' } })
eq('a blank secret keeps the stored one', plain.settings.feishu.appSecret, 'super-secret')
eq('and the form still reports it as set', blank.secretSet, true)
eq('and the other Feishu fields survive', plain.settings.feishu.tableId, 'tbl')

console.log('--- a partial save cannot blank the rest ---')
const before = JSON.stringify(plain.settings.hotkey)
plain.updateSettings({ badgeCount: 'today' })
eq('an untouched block is untouched', JSON.stringify(plain.settings.hotkey), before)
eq('the patched field changed', plain.settings.badgeCount, 'today')
eq('a sibling in the same block survives', plain.settings.feishu.appId, 'cli_1')
plain.updateSettings({ feishu: { autoSync: true } })
eq('a nested patch applies', plain.settings.feishu.autoSync, true)
eq('a nested patch keeps its siblings', plain.settings.feishu.appToken, 'tok')

console.log('--- what a patch may not do ---')
let rejected = null
try { plain.updateSettings('nope') } catch (e) { rejected = e }
ok('a non-object patch is refused', rejected !== null, rejected?.message)
rejected = null
try { plain.updateSettings(null) } catch (e) { rejected = e }
ok('a null patch is refused', rejected !== null)
rejected = null
try { plain.updateSettings([1, 2]) } catch (e) { rejected = e }
ok('an array patch is refused', rejected !== null)
const untouched = JSON.stringify(plain.settings)
plain.updateSettings({ nope: 1, feishu: { nonsense: 2 } })
eq('an undeclared key changes nothing', JSON.stringify(plain.settings), untouched)
eq('an undeclared nested key changes nothing', plain.settings.feishu.nonsense, undefined)

console.log('--- a restart reads it back ---')
const reloaded = new TodoService(null, quiet, { settingsFile: fileOf('svc.json') })
eq('the values survive a restart', reloaded.settings.feishu.appId, 'cli_1')
eq('the secret survives a restart', reloaded.settings.feishu.appSecret, 'super-secret')
eq('the badge measure survives a restart', reloaded.settings.badgeCount, 'today')

console.log('--- a broken file must not break the plugin ---')
const brokenFile = fileOf('broken.json')
fs.writeFileSync(brokenFile, '{oops', 'utf8')
const broken = new TodoService(null, quiet, { settingsFile: brokenFile })
eq('the plugin still starts', broken.settings.feishu.enabled, false)
ok('and the problem is surfaced on the form', typeof broken.settingsForForm().error === 'string')
gate('a payload carrying an error is still lossless JSON', broken.settingsForForm())

console.log('--- dataFile takes effect on the next open ---')
const moved = fresh()
const movedFile = fileOf('moved.json')
moved.applySettings({ dataFile: movedFile })
eq('the store follows the setting', moved.dataFile(), movedFile)
moved.require().create({ title: '写在移动后的文件里' })
ok('the task landed in the configured file', fs.existsSync(movedFile))

console.log('--- disabling the plugin is a real gate ---')
const off = fresh()
off.updateSettings({ enabled: false })
let disabled = null
try { off.require() } catch (e) { disabled = e }
ok('a disabled plugin refuses its store', disabled !== null, disabled?.message)
eq('but the settings page still reads', off.settingsForForm().values.enabled, false)

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n' + (fail ? `FAILING: ${fail} of ${pass + fail}` : `SETTINGS GATE: ALL PASS (${pass})`))
process.exit(fail ? 1 : 0)
