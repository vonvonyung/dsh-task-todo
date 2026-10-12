/** Monthly-plan aggregation and XLSX structure gate. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildPlanData, planSheetModules, renderMonthlyPlanExport } from '../lib/plansheet.js'
import { unzipSync } from 'fflate'

let pass = 0
function ok(name, fn) {
  fn()
  pass++
  console.log(`  PASS ${name}`)
}

const module = planSheetModules()[0]
const templateEntries = unzipSync(fs.readFileSync(new URL('../assets/plan_engine/template_2026-10-prototype.xlsx', import.meta.url)))
ok('the bundled runtime template is blank of prototype examples and private file metadata', () => {
  const shared = new TextDecoder().decode(templateEntries['xl/sharedStrings.xml'])
  assert.match(shared, /uniqueCount="19"/)
  assert.doesNotMatch(shared, /示例|待从飞书|国庆假期/)
  for (const [name, bytes] of Object.entries(templateEntries)) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
    const xml = new TextDecoder().decode(bytes)
    assert.doesNotMatch(xml, /示例|待从飞书|国庆假期/)
    assert.doesNotMatch(xml, /C:\\Users\\|file:\/\/\/C:\//i)
    assert.doesNotMatch(xml, /lastModifiedBy|<dc:creator>/i)
  }
})
const document = {
  lists: [
    { id: 'l_system_month', name: '月度目标', system: true },
    { id: 'l_month', name: '月度目标', system: false },
    { id: 'l_work', name: '工作', system: false },
  ],
  tasks: [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `goal-${index + 1}`,
      title: `月目标 ${index + 1}`,
      listId: 'l_month',
      parentId: null,
      order: index,
      due: index === 0 ? '2026-10-31' : null,
      done: index === 0,
      completedAt: null,
    })),
    { id: 'system-goal', title: '系统清单目标不导出', listId: 'l_system_month', parentId: null, order: 0, done: false },
    { id: 'goal-child', title: '子目标不导出', listId: 'l_month', parentId: 'goal-1', order: 0, done: false },
    { id: 'first-week-plan', title: '跨月首周计划', listId: 'l_work', parentId: null, order: 0, priority: 1, due: '2026-09-28', done: false },
    { id: 'weekly-plan', title: '本周计划', listId: 'l_work', parentId: null, order: 1, priority: 2, due: '2026-10-05', done: false },
    {
      id: 'repeat-current', title: '重复任务当前项', listId: 'l_work', parentId: null,
      order: 2, due: '2026-10-05', done: false, recurrence: { freq: 'daily' },
      history: [{ due: '2026-10-06', at: '2026-10-06T09:00:00' }],
    },
    { id: 'weekend-plan', title: '周末计划不放进工作计划栏', listId: 'l_work', parentId: null, order: 3, due: '2026-10-10', done: false },
    { id: 'dated-completion', title: '明确完成日期', listId: 'l_work', parentId: null, order: 4, done: true, completedAt: '2026-10-06T13:30:00' },
    { id: 'legacy-completion', title: '没有完成时间的旧任务', listId: 'l_work', parentId: null, order: 5, done: true, completedAt: null },
    { id: 'next-month-completion', title: '下月完成', listId: 'l_work', parentId: null, order: 6, done: true, completedAt: '2026-11-01T10:00:00' },
  ],
}

const model = buildPlanData(document, { month: '2026-10', owner: '  测试填写人  ' })
ok('current module is the sanitized October prototype', () => {
  assert.equal(module.id, 'plan_engine/template_2026-10-prototype.xlsx')
  assert.equal(module.label, '月度计划表（10 月原型）')
})
ok('monthly goals use the existing user-created list, top-level only, and at most five', () => {
  assert.deepEqual(model.goals.map((goal) => goal.title), [
    '月目标 1', '月目标 2', '月目标 3', '月目标 4', '月目标 5',
  ])
  assert.ok(model.goals.every((goal) => goal.owner === '测试填写人'))
  assert.equal(model.goals[0].progress, '已完成')
  assert.equal(model.goals[0].due, '2026-10-31')
})
ok('no monthly list means no synthetic list or goal', () => {
  const empty = buildPlanData({ lists: [{ id: 'l_inbox', name: '收集箱', system: true }], tasks: document.tasks }, { month: '2026-10' })
  assert.deepEqual(empty.goals, [])
})
ok('October 2026 yields five Monday-start sheets and clips the final weekday at month end', () => {
  assert.equal(model.weeks.length, 5)
  assert.equal(model.weeks[0].monday, '2026-09-28')
  assert.equal(model.weeks[0].friday, '2026-10-02')
  assert.equal(model.weeks[0].heading, ' 10 月工作计划表（9月28-10月2日/第 1 周）')
  assert.equal(model.weeks[1].heading, ' 10 月工作计划表（10月5-10月9日/第 2 周）')
  assert.equal(model.weeks[4].friday, '2026-10-30')
})
ok('six-week months are supported without adding or removing template sheets by hand', () => {
  const data = buildPlanData({ lists: [], tasks: [] }, { month: '2026-08' })
  assert.equal(data.weeks.length, 6)
  assert.equal(data.weeks[0].monday, '2026-07-27')
  assert.equal(data.weeks[5].monday, '2026-08-31')
})
ok('weekly plans include due open tasks, but never child, completed, or weekend plans', () => {
  const first = model.weeks[0].plannedByDay.get('2026-09-28')
  const monday = model.weeks[1].plannedByDay.get('2026-10-05')
  assert.deepEqual(first.map((task) => task.title), ['跨月首周计划'])
  assert.deepEqual(monday.map((task) => task.title), ['本周计划', '重复任务当前项'])
  assert.equal(model.weeks[1].plannedByDay.has('2026-10-10'), false)
})
ok('completion rows use explicit completedAt only and ignore repeat history', () => {
  assert.deepEqual(model.weeks[1].completedByDay.get('2026-10-06').map((task) => task.title), ['明确完成日期'])
  assert.deepEqual(model.weeks[1].completedByDay.get('2026-10-05'), [])
  assert.deepEqual(model.weeks[4].completedByDay.get('2026-11-01'), undefined)
})
ok('owner is one-export-only input, whitespace is normalized, and no task document is mutated', () => {
  assert.equal(model.owner, '测试填写人')
  assert.equal(document.tasks.find((task) => task.id === 'goal-1').title, '月目标 1')
  assert.ok(!JSON.stringify(document).includes('测试填写人'))
})

let invalidMonth = false
try { buildPlanData(document, { month: '2026-13' }) } catch (error) { invalidMonth = /月份/.test(error.message) }
ok('invalid months are rejected at the aggregation boundary', () => assert.equal(invalidMonth, true))
let invalidModule = false
try { renderMonthlyPlanExport({ document, month: '2026-10', moduleId: '../../anything' }) } catch (error) { invalidModule = /模板/.test(error.message) }
ok('template ids are allow-listed and cannot become filesystem paths', () => assert.equal(invalidModule, true))

const output = renderMonthlyPlanExport({
  document,
  month: '2026-10',
  owner: '测试填写人',
  moduleId: module.id,
})
const entries = unzipSync(output.bytes)
const text = (name) => new TextDecoder().decode(entries[name])
const sheetNames = Object.keys(entries).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
const getCell = (xml, ref) => {
  const opening = [...xml.matchAll(/<c\b[^>]*>/g)].find((match) => /\br="([^"]+)"/.exec(match[0])?.[1] === ref)
  assert.ok(opening, `cell ${ref} exists`)
  const open = opening[0]
  if (open.endsWith('/>')) return ''
  const end = xml.indexOf('</c>', opening.index + open.length)
  const cellXml = xml.slice(opening.index, end + '</c>'.length)
  const inline = /<t(?: [^>]*)?>([\s\S]*?)<\/t>/.exec(cellXml)
  if (inline !== null) return inline[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  return /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? ''
}

ok('export is a five-sheet XLSX with workbook links and a browser filename', () => {
  assert.equal(output.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.match(output.filename, /^月度计划表-测试填写人-2026-10\.xlsx$/)
  assert.equal(sheetNames.length, 5)
  assert.match(text('xl/workbook.xml'), /第5周/)
  assert.equal((text('xl/_rels/workbook.xml.rels').match(/\/worksheet"/g) ?? []).length, 5)
  assert.equal((text('[Content_Types].xml').match(/\/xl\/worksheets\/sheet\d+\.xml/g) ?? []).length, 5)
})
ok('workbook uses dynamic owner, goals, work plans, dates and explicit completion facts', () => {
  const first = text('xl/worksheets/sheet1.xml')
  const second = text('xl/worksheets/sheet2.xml')
  assert.equal(getCell(first, 'B2'), '测试填写人')
  assert.equal(getCell(second, 'B6'), '月目标 1')
  assert.equal(getCell(second, 'E6'), '测试填写人')
  assert.equal(getCell(second, 'F6'), '10月31')
  assert.equal(getCell(second, 'G6'), '已完成')
  assert.equal(getCell(second, 'B14'), '46300')
  assert.equal(getCell(second, 'C14'), '1. 本周计划\n2. 重复任务当前项')
  assert.equal(getCell(second, 'I15'), '1. 明确完成日期')
  assert.equal(getCell(second, 'I14'), '')
})
ok('prototype examples and unused private metadata are absent from the generated workbook', () => {
  const shared = text('xl/sharedStrings.xml')
  assert.doesNotMatch(shared, /示例|飞书多维表同步/)
  assert.match(shared, /uniqueCount="19"/)
  for (const name of Object.keys(entries)) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
    const xml = text(name)
    assert.doesNotMatch(xml, /C:\\Users\\|file:\/\/\/C:\//i)
    assert.doesNotMatch(xml, /lastModifiedBy|<dc:creator>/i)
  }
})
ok('generated workbook is self-contained and a six-week month has six sheets', () => {
  const sixWeek = renderMonthlyPlanExport({ document: { lists: [], tasks: [] }, month: '2026-08' })
  const sixEntries = unzipSync(sixWeek.bytes)
  assert.equal(Object.keys(sixEntries).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 6)
  assert.equal((new TextDecoder().decode(sixEntries['xl/_rels/workbook.xml.rels']).match(/\/worksheet"/g) ?? []).length, 6)
})

console.log(`monthly-plan export: ${pass} assertions passed; ${output.bytes.length} bytes`)
