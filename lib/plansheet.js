/**
 * Monthly plan workbook export.
 *
 * The renderer is deliberately one-way and local-only: it takes the already
 * loaded TodoStore document and the checked-in, metadata-scrubbed workbook
 * template, then returns an XLSX byte buffer. It never reads Feishu, task paths,
 * or any other user file. Repeating-task `history` is intentionally ignored;
 * completed rows use only a task's explicit `completedAt` date.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'

const TEMPLATE_PATH = fileURLToPath(new URL('../assets/plan_engine/template_2026-10-prototype.xlsx', import.meta.url))
const DAY_MS = 86400000
const XLSX_EPOCH = Date.UTC(1899, 11, 31)
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const PLAN_SHEET_MODULES = Object.freeze([
  Object.freeze({
    id: 'plan_engine/template_2026-10-prototype.xlsx',
    label: '月度计划表（10 月原型）',
    template: TEMPLATE_PATH,
  }),
])

/** Public, JSON-safe module list for the client. */
export function planSheetModules() {
  return PLAN_SHEET_MODULES.map(({ id, label }) => ({ id, label }))
}

function resolveModule(id) {
  const wanted = String(id ?? PLAN_SHEET_MODULES[0].id)
  const found = PLAN_SHEET_MODULES.find((entry) => entry.id === wanted)
  if (found === undefined) throw new Error('所选月度计划模板不存在，请重新选择')
  return found
}

function parseMonth(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value ?? ''))
  if (match === null) throw new Error('月份格式无效，请选择 YYYY-MM 格式的月份')
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 1900 || year > 9999) throw new Error('月份须在 1900 至 9999 年之间')
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { key: `${match[1]}-${match[2]}`, year, month, days }
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function addDateDays(date, amount) {
  const [year, month, day] = date.split('-').map(Number)
  const result = new Date(Date.UTC(year, month - 1, day + amount))
  return formatDate(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate())
}

function weekday(date) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function monthOf(date) {
  return typeof date === 'string' ? date.slice(0, 7) : ''
}

/** Strict local calendar date from a stored date/datetime; never guesses. */
function taskDate(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}

function firstMonday(month) {
  const first = formatDate(month.year, month.month, 1)
  return addDateDays(first, -((weekday(first) + 6) % 7))
}

function monthDayLabel(date) {
  const [, month, day] = date.split('-').map(Number)
  return `${month}月${day}`
}

function weekHeading(month, monday, friday, index) {
  const span = `${monthDayLabel(monday)}-${monthDayLabel(friday)}日`
  return ` ${month.month} 月工作计划表（${span}/第 ${index + 1} 周）`
}

function taskTitle(task) {
  return String(task?.title ?? '').replace(/\s+/g, ' ').trim()
}

function compareOrder(a, b) {
  const orderDiff = (Number(a?.order) || 0) - (Number(b?.order) || 0)
  if (orderDiff !== 0) return orderDiff
  return String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? ''))
}

function comparePlanned(a, b) {
  const ad = taskDate(a?.due) ?? '9999-99-99'
  const bd = taskDate(b?.due) ?? '9999-99-99'
  if (ad !== bd) return ad < bd ? -1 : 1
  const priorityDiff = (Number(b?.priority) || 0) - (Number(a?.priority) || 0)
  return priorityDiff || compareOrder(a, b)
}

function compareCompleted(a, b) {
  const at = String(a?.completedAt ?? '')
  const bt = String(b?.completedAt ?? '')
  return at.localeCompare(bt) || compareOrder(a, b)
}

function limitedNumberedText(tasks) {
  const lines = []
  let size = 0
  for (const task of tasks) {
    const title = taskTitle(task)
    if (title === '') continue
    const line = `${lines.length + 1}. ${title}`
    // Excel caps a cell at 32,767 characters. Leave room for a clear truncation
    // marker rather than silently emitting an invalid or partially written cell.
    if (size + line.length + 1 > 32000) {
      lines.push('…其余任务因单元格长度限制未列出')
      break
    }
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

/**
 * Build the data-only export model. Export rules live here so the XLSX renderer
 * and its tests share exactly the same interpretation.
 */
export function buildPlanData(document, { month: monthValue, owner: ownerValue = '' } = {}) {
  const month = parseMonth(monthValue)
  const owner = String(ownerValue ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  const lists = Array.isArray(document?.lists) ? document.lists : []
  const tasks = Array.isArray(document?.tasks) ? document.tasks : []
  const monthlyList = lists.find((list) => list?.name === '月度目标' && list.system !== true) ?? null
  const topLevel = tasks.filter((task) => task !== null && typeof task === 'object' && (task.parentId === null || task.parentId === undefined || task.parentId === ''))

  // Preserve the user's manual order within their existing monthly-goals list.
  // No system list is created, and no task from another list is promoted here.
  const goals = monthlyList === null
    ? []
    : topLevel
      .filter((task) => task.listId === monthlyList.id)
      .sort(compareOrder)
      .slice(0, 5)
      .map((task) => ({
        title: taskTitle(task),
        due: taskDate(task.due),
        owner,
        progress: task.done === true ? '已完成' : '',
      }))
      .filter((goal) => goal.title !== '')

  const first = firstMonday(month)
  const last = formatDate(month.year, month.month, month.days)
  const doneTasks = topLevel
    .filter((task) => task.done === true && taskDate(task.completedAt) !== null)
    .sort(compareCompleted)
  const weeks = []
  for (let monday = first, index = 0; monday <= last; monday = addDateDays(monday, 7), index++) {
    const weekFriday = addDateDays(monday, 4)
    const planThrough = weekFriday < last ? weekFriday : last
    const dates = Array.from({ length: 7 }, (_, day) => addDateDays(monday, day))
    const plannedByDay = new Map()
    const completedByDay = new Map()

    // A weekly sheet covers the full Monday-Friday workweek. The first week may
    // start in the preceding month; the final week is clipped at month-end.
    for (const date of dates) {
      if (date <= planThrough && weekday(date) >= 1 && weekday(date) <= 5) {
        plannedByDay.set(date, topLevel
          .filter((task) => task.done !== true && taskDate(task.due) === date)
          .sort(comparePlanned))
      }
      // Completion rows are monthly facts. Rows outside the selected month stay
      // blank, even when the sheet's calendar week straddles a month boundary.
      if (monthOf(date) === month.key) {
        completedByDay.set(date, doneTasks.filter((task) => taskDate(task.completedAt) === date))
      }
    }

    weeks.push({
      index,
      monday,
      friday: planThrough,
      heading: weekHeading(month, monday, planThrough, index),
      dates,
      plannedByDay,
      completedByDay,
    })
  }

  return { month, owner, goals, weeks }
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()
const textOf = (bytes) => decoder.decode(bytes)
const bytesOf = (text) => encoder.encode(text)

let cachedTemplate = null
function templateEntries() {
  if (cachedTemplate !== null) return cachedTemplate
  if (!fs.existsSync(TEMPLATE_PATH)) throw new Error('月度计划模板文件缺失')
  const input = new Uint8Array(fs.readFileSync(TEMPLATE_PATH))
  const entries = unzipSync(input)
  for (const needed of [
    '[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/sharedStrings.xml', 'xl/worksheets/sheet2.xml',
    'xl/worksheets/_rels/sheet2.xml.rels',
  ]) {
    if (entries[needed] === undefined) throw new Error(`月度计划模板缺少部件：${needed}`)
  }
  cachedTemplate = entries
  return cachedTemplate
}

function xmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[char])
}

function replaceCell(xml, ref, value, kind = 'string') {
  const openings = [...xml.matchAll(/<c\b[^>]*>/g)]
  const matches = openings.filter((match) => /\br="([^"]+)"/.exec(match[0])?.[1] === ref)
  if (matches.length !== 1) throw new Error(`模板单元格 ${ref} 应恰好出现一次，实际 ${matches.length} 次`)

  const match = matches[0]
  const start = match.index
  const open = match[0]
  let end = start + open.length
  if (!open.endsWith('/>')) {
    const closing = xml.indexOf('</c>', end)
    if (closing < 0) throw new Error(`模板单元格 ${ref} 缺少结束标签`)
    end = closing + '</c>'.length
  }
  const attrs = open.slice(2, -1)
    .replace(/\s+t="[^"]*"/g, '')
    .replace(/\s*\/$/, '')
  const replacement = kind === 'number'
    ? `<c${attrs}><v>${String(value)}</v></c>`
    : String(value ?? '') === ''
      ? `<c${attrs}/>`
      : `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
  return xml.slice(0, start) + replacement + xml.slice(end)
}

function excelSerial(date) {
  const [year, month, day] = date.split('-').map(Number)
  const utc = Date.UTC(year, month - 1, day)
  const days = Math.floor((utc - XLSX_EPOCH) / DAY_MS)
  // Excel pretends 1900-02-29 existed. Add its compatibility day from March 1.
  return String(days + (date >= '1900-03-01' ? 1 : 0))
}

function renderWeek(baseSheet, week, data) {
  let xml = baseSheet
  xml = replaceCell(xml, 'A1', week.heading)
  // Both are written inline so the example string table can be removed entirely.
  xml = replaceCell(xml, 'A2', '填写人：')
  xml = replaceCell(xml, 'B2', data.owner)

  for (let index = 0; index < 5; index++) {
    const row = 6 + index
    const goal = data.goals[index]
    xml = replaceCell(xml, `B${row}`, goal?.title ?? '')
    xml = replaceCell(xml, `E${row}`, goal?.owner ?? '')
    xml = replaceCell(xml, `F${row}`, goal?.due ? monthDayLabel(goal.due) : '')
    xml = replaceCell(xml, `G${row}`, goal?.progress ?? '')
  }

  for (let index = 0; index < 7; index++) {
    const row = 14 + index
    const date = week.dates[index]
    xml = replaceCell(xml, `B${row}`, excelSerial(date), 'number')
    const plans = week.plannedByDay.get(date) ?? []
    const done = week.completedByDay.get(date) ?? []
    xml = replaceCell(xml, `C${row}`, limitedNumberedText(plans))
    xml = replaceCell(xml, `I${row}`, limitedNumberedText(done))
  }
  return xml
}

function countSharedStringRefs(sheets) {
  let count = 0
  for (const xml of sheets) count += (xml.match(/<c\b[^>]*\bt="s"/g) ?? []).length
  return count
}

function removeSampleStrings(sharedStringsXml, count) {
  const rootStart = sharedStringsXml.indexOf('<sst')
  const rootOpenEnd = sharedStringsXml.indexOf('>', rootStart)
  const rootCloseStart = sharedStringsXml.lastIndexOf('</sst>')
  if (rootStart < 0 || rootOpenEnd < 0 || rootCloseStart < rootOpenEnd) {
    throw new Error('月度计划模板的 sharedStrings.xml 格式无效')
  }
  const prefix = sharedStringsXml.slice(0, rootStart)
  const root = sharedStringsXml.slice(rootStart, rootOpenEnd + 1)
  const body = sharedStringsXml.slice(rootOpenEnd + 1, rootCloseStart)
  const suffix = sharedStringsXml.slice(rootCloseStart)
  const items = body.match(/<si\b[\s\S]*?<\/si>/g) ?? []
  // Entries 0..18 are instructions, headers and weekday labels. Every prototype
  // title / example after them is replaced with inline text before this cleanup.
  const safe = items.slice(0, 19)
  if (safe.length !== 19) throw new Error('月度计划模板的安全共享字符串数量异常')
  const updatedRoot = root
    .replace(/\bcount="\d+"/, `count="${count}"`)
    .replace(/\buniqueCount="\d+"/, 'uniqueCount="19"')
  return `${prefix}${updatedRoot}${safe.join('')}${suffix}`
}

function rebuildWorkbookXml(workbookXml, weeks) {
  const sheets = weeks.map((week, index) =>
    `<sheet name="第${index + 1}周" sheetId="${index + 1}" r:id="rId${index + 4}"/>`).join('')
  const replaced = workbookXml.replace(/<sheets>[\s\S]*?<\/sheets>/, `<sheets>${sheets}</sheets>`)
  if (replaced === workbookXml) throw new Error('月度计划模板的工作表区域无法更新')
  return replaced
}

function workbookRelationships(sheetCount) {
  const relations = [
    `<Relationship Id="rId1" Type="${NS_DOC_REL}/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="rId2" Type="${NS_DOC_REL}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId3" Type="${NS_DOC_REL}/sharedStrings" Target="sharedStrings.xml"/>`,
  ]
  for (let index = 0; index < sheetCount; index++) {
    relations.push(`<Relationship Id="rId${index + 4}" Type="${NS_DOC_REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_REL}">${relations.join('')}</Relationships>`
}

function contentTypes(original, sheetCount) {
  let xml = original.replace(/<Override\b(?=[^>]*\bPartName="\/xl\/worksheets\/sheet\d+\.xml")[^>]*\/>/g, '')
  const overrides = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  xml = xml.replace('</Types>', `${overrides}</Types>`)
  return xml
}

function buildWorkbook(data, module) {
  const original = templateEntries()
  const baseSheet = textOf(original['xl/worksheets/sheet2.xml'])
  const baseRels = original['xl/worksheets/_rels/sheet2.xml.rels']
  const rendered = data.weeks.map((week) => renderWeek(baseSheet, week, data))
  const entries = Object.fromEntries(Object.entries(original))

  for (const name of Object.keys(entries)) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)
      || /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name)) delete entries[name]
  }
  // All pages share the prototype's (same-layout) print settings. Discard the
  // now-unreferenced copies from the five-sheet source template.
  for (const name of Object.keys(entries)) {
    if (/^xl\/printerSettings\/printerSettings\d+\.bin$/.test(name) && name !== 'xl/printerSettings/printerSettings2.bin') delete entries[name]
  }
  for (let index = 0; index < rendered.length; index++) {
    entries[`xl/worksheets/sheet${index + 1}.xml`] = bytesOf(rendered[index])
    entries[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = baseRels
  }

  entries['xl/workbook.xml'] = bytesOf(rebuildWorkbookXml(textOf(original['xl/workbook.xml']), data.weeks))
  entries['xl/_rels/workbook.xml.rels'] = bytesOf(workbookRelationships(data.weeks.length))
  entries['[Content_Types].xml'] = bytesOf(contentTypes(textOf(original['[Content_Types].xml']), data.weeks.length))
  entries['xl/sharedStrings.xml'] = bytesOf(removeSampleStrings(
    textOf(original['xl/sharedStrings.xml']), countSharedStringRefs(rendered)))

  if (module.template !== TEMPLATE_PATH) throw new Error('所选模板与月度计划渲染器不匹配')
  return zipSync(entries, { level: 6 })
}

function safeOwnerForFilename(owner) {
  return owner
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/**
 * Render an XLSX and its safe browser-download name from a local task document.
 * `moduleId` must match a registered template; paths from the request are never
 * used as filesystem paths.
 */
export function renderMonthlyPlanExport({ document, month: monthValue, owner: ownerValue = '', moduleId } = {}) {
  const module = resolveModule(moduleId)
  const data = buildPlanData(document, { month: monthValue, owner: ownerValue })
  const bytes = buildWorkbook(data, module)
  const monthLabel = `${data.month.year}-${String(data.month.month).padStart(2, '0')}`
  const owner = safeOwnerForFilename(data.owner)
  const filename = `月度计划表-${owner ? `${owner}-` : ''}${monthLabel}.xlsx`
  const summary = {
    month: data.month.key,
    module: module.id,
    weeks: data.weeks.length,
    monthlyGoals: data.goals.length,
    plannedTasks: [...data.weeks].reduce((n, week) => n + [...week.plannedByDay.values()].reduce((m, day) => m + day.length, 0), 0),
    completedTasks: [...data.weeks].reduce((n, week) => n + [...week.completedByDay.values()].reduce((m, day) => m + day.length, 0), 0),
  }
  return { bytes, filename, mimeType: XLSX_MIME, summary }
}
