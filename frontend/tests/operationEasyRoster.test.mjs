// 쉬운 화면 추천 근무표: 결과 글자·표 모양과 말로 고치기 반영(서버가 검사한 값만, 바뀐 줄 표시).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
const model = await server.ssrLoadModule('/src/features/operation/easy/easyRosterModel.ts')
const { rosterDigest, optionsFromStored } = await server.ssrLoadModule('/src/features/operation/roster/rosterTypes.ts')
const chat = await server.ssrLoadModule('/src/features/operation/easy/easyRosterChat.ts')
const restore = await server.ssrLoadModule('/src/features/operation/easy/easyRosterRestore.ts')
const warm = await server.ssrLoadModule('/src/features/operation/easy/rosterWarm.ts')
after(async () => {
  await server.close()
})

const shift = (start, end, owner = false, breaks = []) => ({ worker_key: owner ? 'OWNER' : 'S', is_owner: owner, kind: owner ? 'OWNER' : 'SHORT', start_time: start, end_time: end, breaks, span_hours: 0, break_minutes: 0 })
const option = (key, extra) => ({
  key,
  title: key,
  extra_by_day: { MON: extra, TUE: extra },
  days: {
    MON: { shifts: [shift('07:00', '15:00', true), shift('11:00', '14:00'), shift('14:00', '19:00', false, [{ start_time: '16:00', end_time: '16:30' }])] },
    TUE: { shifts: [shift('11:00', '14:00')] },
  },
  weekly: {
    assignments: [
      // 서버와 같게 그날 직원 근무조를 1부터 센다(MON-1 = 월요일 첫 근무조). 예전 결과처럼 breaks는 없음
      { slot_id: 'MON-1', day: 'MON', worker_key: 'A', name: '직원 A', start_time: '11:00', end_time: '14:00', work_hours: 3 },
      { slot_id: 'MON-2', day: 'MON', worker_key: 'B', name: '직원 B', start_time: '14:00', end_time: '19:00', work_hours: 4.5 },
      { slot_id: 'TUE-1', day: 'TUE', worker_key: 'A', name: '직원 A', start_time: '11:00', end_time: '14:00', work_hours: 3 },
    ],
    unfilled: [],
    workers: [
      { worker_key: 'A', name: '직원 A', days: ['MON', 'TUE'], weekly_work_hours: 6 },
      { worker_key: 'B', name: '직원 B', days: ['MON'], weekly_work_hours: 4.5 },
      { worker_key: 'C', name: '직원 C', days: [], weekly_work_hours: 0 },
    ],
    people_used: 2,
  },
  shortfall: { unfilled_hours: 0, more_people_under_15h: 0 },
  peak_wait_sec: { MON: 170, TUE: 130 },
  plan_cost_krw: 100000,
})
const data = {
  min_gain_sec: 30,
  days: {
    MON: { windows: [{ start_time: '12:00', end_time: '13:00' }], ladder: [{ extra: 0, peak_wait_sec: 420 }, { extra: 1, peak_wait_sec: 170 }, { extra: 2, peak_wait_sec: 150 }], picks: { SAVE: 0, RECOMMENDED: 1, ROOMY: 2 } },
    TUE: { windows: [], ladder: [{ extra: 0, peak_wait_sec: 300 }], picks: { SAVE: 0, RECOMMENDED: 0, ROOMY: 0 } },
  },
  options: [option('SAVE', 0), option('RECOMMENDED', 1), option('ROOMY', 2)],
}

test('대기 글자: 분·초 / 초 반올림과 올림 / 없음', () => {
  assert.equal(model.waitText(0), '0초')
  assert.equal(model.waitText(40), '40초')
  assert.equal(model.waitText(59.6), '1분')
  assert.equal(model.waitText(170), '2분 50초')
  assert.equal(model.waitText(179.6), '3분')
  assert.equal(model.waitText(3.83 * 60), '3분 50초')
  assert.equal(model.waitText(3.74 * 60), '3분 44초')
  assert.equal(model.waitText(3.68 * 60), '3분 41초')
  assert.equal(model.waitText(null), '—')
  assert.equal(model.waitText(undefined), '—')
  assert.equal(model.waitText(NaN), '—')
  assert.equal(model.waitText(-1), '—')
})

test('추천 한 줄: 새로 뽑을 직원 먼저, 모든 요일 같은 수면 "N명씩", 아니면 요일, 0이면 충분', () => {
  const days = model.shownDays(data)
  assert.deepEqual(days, ['MON', 'TUE'])
  assert.equal(model.headline(data.options[1], days), '바쁜 시간에 1명씩 더 배치하면 돼요 · 새로 뽑지 않고 지금 직원으로 채워요')
  assert.equal(model.headline(data.options[0], days), '지금 직원으로 충분해요')
  // 새로 뽑을 직원이 있으면 그걸 먼저(표의 노란 줄과 맞게)
  assert.equal(model.headline({ ...data.options[0], shortfall: { more_people_under_15h: 2 } }, days), '직원 2명을 더 뽑으면 돼요')
  assert.equal(model.headline({ ...data.options[1], shortfall: { more_people_under_15h: 1 } }, days), '직원 1명을 더 뽑고, 바쁜 시간에 1명씩 더 배치하면 돼요')
  const mixed = { ...data.options[1], extra_by_day: { MON: 1, TUE: 0 } }
  assert.equal(model.headline(mixed, days), '월요일 바쁜 시간에 사람을 더 배치하면 돼요 · 새로 뽑지 않고 지금 직원으로 채워요')
  const uneven = { ...data.options[1], extra_by_day: { MON: 1, TUE: 2 } }
  assert.equal(model.headline(uneven, days), '바쁜 시간에 요일마다 1~2명 더 배치하면 돼요 · 새로 뽑지 않고 지금 직원으로 채워요')
})

test('가장 바쁜 요일과 막대: 추천 표시, 가장 긴 대기를 1로', () => {
  assert.equal(model.busiestDay(data, ['MON', 'TUE']), 'MON')
  const bars = model.ladderBars(data, 'MON')
  assert.deepEqual(bars.map((b) => b.label), ['꼭 필요한 인원', '+1명', '+2명'])
  assert.equal(bars[1].pick, 'RECOMMENDED')
  assert.equal(bars[0].ratio, 1)
})

test('일주일 표: 사장님 줄 + 일한 직원만, 휴게는 그날 직원 근무조 순서로 찾는다', () => {
  const rows = model.weekRows(data.options[1], ['MON', 'TUE'])
  assert.deepEqual(rows.map((r) => r.name), ['사장님', '직원 A', '직원 B'])
  assert.equal(rows[0].cells[0].start, '07:00')
  assert.equal(rows[0].cells[1], null)
  assert.deepEqual(rows[2].cells[0].breaks, ['16:00~16:30'], '표 칸 시간은 늘 시:분')
  assert.deepEqual(rows[1].cells[0].breaks, [])
  assert.equal(model.unfilledCells(data.options[1], ['MON', 'TUE']), null)
})

test('근무 시간 글자: 정시면 짧게', () => {
  assert.equal(model.rangeText('07:00', '16:00'), '7~16시')
  assert.equal(model.rangeText('10:30', '14:00'), '10:30~14:00')
})

test('표 칸 시간은 정시도 시:분으로(칸끼리 표기가 섞이지 않게)', () => {
  assert.equal(model.shiftText('12:00', '16:00'), '12:00~16:00')
  assert.equal(model.shiftText('07:00', '10:30'), '7:00~10:30')
})

test('새로 뽑을 알바: 서버가 나눈 그대로 줄로, 빈 자리 줄은 안 나옴', () => {
  const base = data.options[1]
  const option = {
    ...base,
    weekly: { ...base.weekly, unfilled: [{ slot_id: 'TUE-2', day: 'TUE', start_time: '07:00', end_time: '12:00', work_hours: 4.5 }] },
    new_hires: [{ worker_key: 'NEW_1', name: '새 직원 1', weekly_work_hours: 4.5, base_wage_krw: 46_440, assignments: [{ slot_id: 'TUE-2', day: 'TUE', start_time: '07:00', end_time: '12:00', work_hours: 4.5, breaks: [{ start_time: '09:30', end_time: '10:00' }] }] }],
  }
  const rows = model.weekRows(option, ['MON', 'TUE'])
  const hire = rows.at(-1)
  assert.equal(hire.name, '새 직원 1')
  assert.equal(hire.hire, true)
  assert.equal(hire.pay, 46_440, '주 예상 급여는 서버 값 그대로')
  assert.equal(hire.cells[0], null)
  assert.equal(hire.cells[1].start, '07:00')
  assert.deepEqual(hire.cells[1].breaks, ['9:30~10:00'], '서버가 실어 준 휴게를 그대로')
  assert.equal(model.unfilledCells(option, ['MON', 'TUE']), null)
  // 예전 결과(new_hires 없음)는 빈 자리 줄로
  const { new_hires: _, ...old } = option
  assert.deepEqual(model.unfilledCells(old, ['MON', 'TUE']), ['', '7:00~12:00'])
})

test('세 안 이름은 한 곳에서: 저장한 계획 목록도 같은 이름', async () => {
  const names = await server.ssrLoadModule('/src/features/operation/easy/rosterNames.ts')
  const recent = await server.ssrLoadModule('/src/features/easy/recentFormat.ts')
  assert.equal(names.OPTION_NAME.SAVE, '인건비 절약 근무표')
  assert.equal(recent.CHOICE.RECOMMENDED, '균형 근무표')
  assert.equal(model.OPTION_NAME.ROOMY, recent.CHOICE.ROOMY)
})

test('줄 서는 모습의 일하는 사람: 이름 없이 사장님·직원 수', () => {
  assert.equal(model.staffText(['OWNER', 'STAFF_1', 'STAFF_2']), '사장님 · 직원 2명')
  assert.equal(model.staffText(['STAFF_3']), '직원 1명')
  assert.equal(model.staffText([]), '없음')
})

test('시각 글자', () => {
  assert.equal(model.clock('07:00'), '7시')
  assert.equal(model.clock('13:30'), '13시 30분')
  assert.equal(model.clock('12:00'), '12시')
})

const team = {
  people: [
    { id: 1, name: '직원 A', wage: '10320', minor: false, days: ['MON'], start: '07:00', end: '12:00', maxHours: '14' },
    { id: 2, name: '직원 B', wage: '10320', minor: false, days: ['TUE'], start: '12:00', end: '19:00', maxHours: '14' },
  ],
  ownerDays: ['MON', 'TUE'],
  ownerStart: '07:00',
  ownerEnd: '15:00',
}
const cond = { targetWaitSec: 300, espresso: 1, blenders: 1, owner: true, wage: '10320', team }

test('말로 고치기: 검사된 값만 반영하고 바뀐 줄을 알려 준다', () => {
  const reply = { source: 'LLM', intent: 'EDIT', changes: [{ key: 'target_wait_min', value: 3 }, { key: 'owner_days', value: ['MON'] }, { key: 'unknown', value: 1 }], worker_changes: [], reply: '' }
  const { next, rows, changed } = chat.applyReply(cond, reply, { open: '07:00', close: '19:00' })
  assert.equal(changed, true)
  assert.equal(next.targetWaitSec, 180)
  assert.deepEqual(next.team.ownerDays, ['MON'])
  assert.deepEqual(rows.sort(), ['owner', 'target'])
  assert.equal(cond.targetWaitSec, 300, '원래 조건은 그대로')
})

test('말로 고치기: 직원은 별칭으로 더하기·빼기·고치기', () => {
  const reply = {
    source: 'LLM',
    intent: 'EDIT',
    changes: [],
    worker_changes: [
      { op: 'update', alias: 'P1', fields: { max_hours: 10 } },
      { op: 'remove', alias: 'P2' },
      { op: 'add', alias: 'NEW', fields: { days: ['SAT'], start: '09:00', end: '13:00' } },
    ],
    reply: '',
  }
  const { next, rows } = chat.applyReply(cond, reply, { open: '07:00', close: '19:00' })
  assert.deepEqual(next.team.people.map((p) => p.name), ['직원 A', '추가 직원 2'])
  assert.equal(next.team.people[0].maxHours, '10')
  assert.deepEqual(next.team.people[1].days, ['SAT'])
  assert.deepEqual(rows, ['team'])
})

test('말로 고치기: 마지막 직원 빼기·시작이 끝보다 늦어지는 고치기는 반영도, 바뀐 줄 표시도 안 한다', () => {
  const one = { ...cond, team: { ...team, people: [team.people[0]] } }
  const removed = chat.applyReply(one, { source: 'LLM', intent: 'EDIT', changes: [], worker_changes: [{ op: 'remove', alias: 'P1' }], reply: '' }, { open: '07:00', close: '19:00' })
  assert.equal(removed.next.team.people.length, 1)
  assert.equal(removed.changed, false)
  // 직원 A는 07:00~12:00: 시작만 13:00으로 바꾸면 끝보다 늦다
  const late = chat.applyReply(cond, { source: 'LLM', intent: 'EDIT', changes: [], worker_changes: [{ op: 'update', alias: 'P1', fields: { start: '13:00' } }], reply: '' }, { open: '07:00', close: '19:00' })
  assert.equal(late.next.team.people[0].start, '07:00')
  assert.equal(late.changed, false)
})

test('말로 고치기: 시급을 바꾸면 직원마다의 시급도 같이(조건 카드 고르기와 같게)', () => {
  const { next } = chat.applyReply(cond, { source: 'LLM', intent: 'EDIT', changes: [{ key: 'hourly_wage', value: 12000 }], worker_changes: [], reply: '' }, { open: '07:00', close: '19:00' })
  assert.equal(next.wage, '12000')
  assert.deepEqual(next.team.people.map((p) => p.wage), ['12000', '12000'])
  assert.equal(cond.team.people[0].wage, '10320', '원래 조건은 그대로')
})

test('말로 고치기: 별칭은 직원 번호로 붙어 앞 직원을 빼도 바뀌지 않는다', () => {
  const { next } = chat.applyReply(cond, { source: 'LLM', intent: 'EDIT', changes: [], worker_changes: [{ op: 'remove', alias: 'P1' }], reply: '' }, { open: '07:00', close: '19:00' })
  assert.deepEqual(chat.chatWorkers(next.team.people).map((w) => w.alias), ['P2'])
  assert.equal(chat.toNames('P2는 화요일', next.team.people), '직원 B는 화요일')
  assert.equal(chat.toNames('P1은 빠졌어요', next.team.people), 'P1은 빠졌어요')
  const later = chat.applyReply(next, { source: 'LLM', intent: 'EDIT', changes: [], worker_changes: [{ op: 'update', alias: 'P2', fields: { max_hours: 9 } }], reply: '' }, { open: '07:00', close: '19:00' })
  assert.equal(later.next.team.people[0].maxHours, '9')
})

test('말로 고치기: 뺀 직원 번호는 새 직원에게 다시 주지 않는다(화면이 넘긴 nextId)', () => {
  const removed = chat.applyReply(cond, { source: 'LLM', intent: 'EDIT', changes: [], worker_changes: [{ op: 'remove', alias: 'P2' }], reply: '' }, { open: '07:00', close: '19:00' })
  const added = chat.applyReply(removed.next, { source: 'LLM', intent: 'EDIT', changes: [], worker_changes: [{ op: 'add', alias: 'NEW', fields: { days: ['SAT'], start: '09:00', end: '13:00' } }], reply: '' }, { open: '07:00', close: '19:00', nextId: 3 })
  assert.deepEqual(chat.chatWorkers(added.next.team.people).map((w) => w.alias), ['P1', 'P3'])
})

test('말로 고치기: 바뀐 것이 없으면 changed=false (묻기)', () => {
  const { changed } = chat.applyReply(cond, { source: 'LLM', intent: 'ASK', changes: [], worker_changes: [], reply: '' }, { open: '07:00', close: '19:00' })
  assert.equal(changed, false)
})

test('AI에 보내는 직원 정보에는 이름이 없다', () => {
  const workers = chat.chatWorkers(team.people)
  assert.deepEqual(workers.map((w) => w.alias), ['P1', 'P2'])
  assert.ok(workers.every((w) => !('name' in w)))
  assert.ok(!JSON.stringify(workers).includes('직원 A'))
})

const slots = (a, b, n) => Object.fromEntries(Array.from({ length: b - a }, (_, i) => [`${String(a + i).padStart(2, '0')}:00-${String(a + i + 1).padStart(2, '0')}:00`, n]))
const stored = {
  days: [
    { day: 'TUE', operation_form: { daily_orders: 120, orders_by_slot: slots(8, 18, 12), hourly_wage_krw: 11000, target_wait_sec: 180, is_owner_working: true, peak_start_time: '12:00', peak_end_time: '13:00', store_source: { days: 28, file_name: 'a.xlsx' } }, owner_start_time: '08:00', owner_end_time: '14:00' },
    { day: 'MON', operation_form: { daily_orders: 100, orders_by_slot: slots(7, 19, 8), hourly_wage_krw: 11000, target_wait_sec: 180, is_owner_working: true }, owner_start_time: '07:00', owner_end_time: '14:00' },
    { day: 'SAT', operation_form: { daily_orders: 60, orders_by_slot: slots(9, 17, 7), hourly_wage_krw: 11000, target_wait_sec: 180, is_owner_working: false } },
  ],
  workers: [
    { worker_key: '직원 A', name: '직원 A', hourly_wage_krw: 11000, is_minor: false, max_weekly_hours: 12, available: { MON: ['07:00', '12:00'], SAT: ['07:00', '12:00'] } },
    { worker_key: '직원 B', name: '직원 B', hourly_wage_krw: 11500, is_minor: true, max_weekly_hours: 10, available: { TUE: ['12:00', '19:00'] } },
  ],
}

test('다시 불러오기: 요일은 월~일 순서, 숫자는 저장된 조건에서', () => {
  const f = restore.restoredFacts(stored)
  assert.deepEqual(f.days, ['MON', 'TUE', 'SAT'])
  assert.equal(f.open, '07:00')
  assert.equal(f.close, '19:00')
  assert.equal(f.dailyOrders, 93)
  assert.equal(f.dataDays, null, '출처 일수가 빠진 요일이 있으면 비움')
  assert.equal(restore.restoredFacts({ days: [], workers: [] }), null)
})

test('다시 불러오기: 그때의 조건·직원 명단으로 채운다', () => {
  const c = restore.restoreConditions(stored, { open: '07:00', close: '19:00' })
  assert.equal(c.targetWaitSec, 180)
  assert.equal(c.wage, '11000')
  assert.equal(c.owner, true)
  assert.deepEqual(c.team.ownerDays, ['MON', 'TUE'])
  assert.equal(c.team.ownerStart, '07:00')
  assert.deepEqual(c.team.people.map((p) => [p.name, p.days, p.start, p.end, p.maxHours, p.minor, p.wage]), [
    ['직원 A', ['MON', 'SAT'], '07:00', '12:00', '12', false, '11000'],
    ['직원 B', ['TUE'], '12:00', '19:00', '10', true, '11500'],
  ])
})

test('다시 불러오기: 사장님 시간을 그대로 다시 계산하면 요일마다 저장된 시간이 유지된다', () => {
  // 월요일은 09시 개점이라 09:00부터로 잘려 저장됐다. 그 값으로 화요일(07:00부터)이 좁아지면 안 된다.
  const late = {
    days: [
      { day: 'MON', operation_form: { daily_orders: 80, orders_by_slot: slots(9, 18, 8), is_owner_working: true }, owner_start_time: '09:00', owner_end_time: '14:00' },
      { day: 'TUE', operation_form: { daily_orders: 90, orders_by_slot: slots(7, 18, 8), is_owner_working: true }, owner_start_time: '07:00', owner_end_time: '14:00' },
    ],
    workers: [],
  }
  const c = restore.restoreConditions(late, { open: '07:00', close: '18:00' })
  assert.equal(c.team.ownerStart, '07:00')
  assert.equal(c.team.ownerEnd, '14:00')
  const days = restore.restoredDayBodies(late, c)
  assert.deepEqual(days.map((d) => [d.day, d.owner_start_time, d.owner_end_time]), [['MON', '09:00', '14:00'], ['TUE', '07:00', '14:00']])
})

test('다시 계산 본문: 지금 값으로 덮고, 사장님 근무는 그날 영업시간 안으로', () => {
  const c = restore.restoreConditions(stored, { open: '07:00', close: '19:00' })
  const next = { ...c, targetWaitSec: 300, wage: '12000', espresso: 2, team: { ...c.team, ownerDays: ['MON', 'TUE'], ownerStart: '07:00', ownerEnd: '15:00' } }
  const days = restore.restoredDayBodies(stored, next)
  assert.deepEqual(days.map((d) => d.day), ['MON', 'TUE', 'SAT'])
  const tue = days[1]
  assert.equal(tue.owner_start_time, '08:00', '화요일은 8시 오픈이라 8시부터')
  assert.equal(tue.operation_form.hourly_wage_krw, 12000)
  assert.equal(tue.operation_form.espresso_machines, 2)
  assert.ok(!('target_wait_sec' in tue.operation_form), '기본값(5분)이면 칸을 뺀다')
  assert.deepEqual(tue.operation_form.orders_by_slot, stored.days[0].operation_form.orders_by_slot, '가게 숫자는 그대로')
  assert.equal(days[2].operation_form.is_owner_working, false)
  assert.ok(!('owner_start_time' in days[2]))
})

test('미리 계산 순서: 조건 카드는 지금 조건, 결과 화면은 다른 목표 대기를 가까운 것부터', () => {
  assert.deepEqual(warm.otherWaits(5, [3, 5, 7]), [3, 7], '5분이면 3분(같은 거리면 짧은 쪽) 다음 7분')
  assert.deepEqual(warm.otherWaits(3, [3, 5, 7]), [5, 7])
  assert.deepEqual(warm.otherWaits(4, [3, 5, 7]), [3, 5, 7], '목록에 없는 값이면 셋 다')
  const cond = { targetWaitSec: 300, espresso: 1, blenders: 1, owner: true, wage: '10320', team: { people: [] } }
  assert.deepEqual(warm.warmConditions('confirm', cond, [3, 5, 7]), [cond])
  const later = warm.warmConditions('result', cond, [3, 5, 7])
  assert.deepEqual(later.map((c) => c.targetWaitSec), [180, 420])
  assert.equal(later[0].wage, '10320', '목표 대기만 바꾼다')
})

test('휴게는 그 근무조 것: 서버 번호(1부터)로 찾고, 서버가 실어 준 값이 있으면 그것', () => {
  const base = data.options[1]
  const rows = model.weekRows(base, ['MON'])
  assert.deepEqual(rows.find((r) => r.name === '직원 A').cells[0].breaks, [], '월 첫 근무조(11~14시)는 휴게 없음')
  assert.deepEqual(rows.find((r) => r.name === '직원 B').cells[0].breaks, ['16:00~16:30'], '월 둘째 근무조(14~19시)의 휴게')
  const given = { ...base, weekly: { ...base.weekly, assignments: base.weekly.assignments.map((a) => (a.slot_id === 'MON-1' ? { ...a, breaks: [{ start_time: '12:00', end_time: '12:30' }] } : a)) } }
  assert.deepEqual(model.weekRows(given, ['MON']).find((r) => r.name === '직원 A').cells[0].breaks, ['12:00~12:30'])
})

test('말로 고치기: 이름은 별칭으로 보내고, 답장의 별칭은 이름으로', () => {
  const people = [{ id: 1, name: '직원 A' }, { id: 2, name: '직원 AB' }, { id: 3, name: '김민지' }]
  assert.equal(chat.toAliases('직원 AB랑 김민지가 토요일에 못 나온대, 직원 A는 돼', people), 'P2랑 P3가 토요일에 못 나온대, P1는 돼')
  assert.equal(chat.toNames('P3은 토요일 근무를 뺐어요. P9는 없어요.', people), '김민지은 토요일 근무를 뺐어요. P9는 없어요.')
  assert.equal(chat.toNames('P1~P2 중 누구인가요?', people), '직원 A~직원 AB 중 누구인가요?')
})

test('비교 카드: 추천과 견준 한 줄(몇 초 차이는 거의 같음)', () => {
  const days = ['MON', 'TUE']
  const rec = { key: 'RECOMMENDED', plan_cost_krw: 1_000_000, peak_wait_sec: { MON: 120, TUE: 120 } }
  const save = { key: 'SAVE', plan_cost_krw: 700_000, peak_wait_sec: { MON: 180, TUE: 160 } }
  const roomy = { key: 'ROOMY', plan_cost_krw: 1_400_000, peak_wait_sec: { MON: 116, TUE: 118 } }
  assert.equal(model.versusText(rec, rec, days), null)
  assert.equal(model.versusText(save, rec, days), '추천보다 대기 +50초 · 인건비 −300,000원')
  assert.equal(model.versusText(roomy, rec, days), '추천보다 대기는 거의 같아요 · 인건비 +400,000원')
})

test('목록 요약: 바꾼 목표 대기·시급이 보여 같은 가게 근무표끼리 구분된다', async () => {
  const recent = await server.ssrLoadModule('/src/features/easy/recentFormat.ts')
  const form = { daily_orders: 142, is_owner_working: true, target_wait_sec: 180, hourly_wage_krw: 12000, orders_by_slot: { '07:00-08:00': 5 } }
  assert.equal(recent.inputSummary('operation', { operation_form: form }), '주문 142건 · 사장님 같이 일함 · 목표 대기 3분 · 시급 12,000원')
  // 1번(시간대 주문 없음)은 예전 그대로
  assert.equal(recent.inputSummary('operation', { operation_form: { daily_orders: 150, is_owner_working: true, hourly_wage_krw: 10320 } }), '보통 날(150건) · 사장님 같이 일함')
})

test('하루 근무표면 "주" 대신 "하루", 제목은 그 요일', () => {
  const { periodOf } = model
  assert.deepEqual(periodOf(['MON']), { per: '하루', title: '월요일', within: '이날' })
  assert.deepEqual(periodOf(['MON', 'TUE']), { per: '주', title: '일주일', within: '일주일에' })
})

test('말로 바꾼 내용: 같은 칸은 마지막 값만', () => {
  let list = chat.mergeChanges([], '직원 시급: 11,000원.')
  list = chat.mergeChanges(list, '직원 시급: 10,320원.')
  assert.deepEqual(list, ['직원 시급: 10,320원'])
  list = chat.mergeChanges(list, '목표 대기: 3분 / 직원 G: 가능 요일 월·화')
  assert.deepEqual(list, ['직원 시급: 10,320원', '목표 대기: 3분', '직원 G: 가능 요일 월·화'])
})

test('바쁜 시간 표시: 이어진 구간은 하나로', () => {
  assert.deepEqual(model.mergedWindows([{ start_time: '11:00', end_time: '14:00' }, { start_time: '08:00', end_time: '11:00' }]), [{ start: '08:00', end: '14:00' }])
  assert.deepEqual(model.mergedWindows([{ start_time: '08:00', end_time: '10:00' }, { start_time: '12:00', end_time: '13:00' }]).length, 2)
})

test('말로 바꿀 수 있는 것 안내는 칸 정의에서', () => {
  const text = chat.editableText(chat.chatFields('07:00', '20:00', ['MON']))
  assert.match(text, /목표 대기/)
  assert.match(text, /사장님 근무\(요일·시간\)/)
  assert.equal(text.split('사장님 근무').length, 2) // 사장님 칸 여러 개는 하나로
})

test('AI 설명 보이기: 긴 숫자에 쉼표, 문장마다 나눔', () => {
  assert.deepEqual(model.noteSentences('인건비는 1491240원에서 1527360원으로 늘어납니다. 대기는 2.5분이에요. 시급 10,320원'), [
    '인건비는 1,491,240원에서 1,527,360원으로 늘어납니다.',
    '대기는 2.5분이에요.',
    '시급 10,320원',
  ])
})

test('바쁠 때 더 배치한 근무: 절약 안에 없는 시간 근무만 표시', () => {
  const save = option('SAVE', 0)
  const rec = option('RECOMMENDED', 1)
  rec.days.MON.shifts = [...rec.days.MON.shifts, shift('11:00', '14:30')]
  rec.weekly.assignments = [...rec.weekly.assignments, { slot_id: 'MON-3', day: 'MON', worker_key: 'C', name: '직원 C', start_time: '11:00', end_time: '14:30', work_hours: 3.5 }]
  rec.weekly.workers = [...rec.weekly.workers, { worker_key: 'C', name: '직원 C', days: ['MON'], weekly_work_hours: 3.5 }]
  const rows = model.markExtraShifts(model.weekRows(rec, ['MON', 'TUE']), rec, save, ['MON', 'TUE'])
  const extra = rows.flatMap((r) => r.cells.filter((c) => c?.extra).map((c) => `${r.name} ${c.start}`))
  assert.deepEqual(extra, ['직원 C 11:00'])
  assert.deepEqual(model.markExtraShifts(model.weekRows(save, ['MON']), save, save, ['MON']), model.weekRows(save, ['MON']))
})

test('결론 한 줄: 새로 뽑지 않고 더 배치하면 그렇다고 말한다', () => {
  const rec = option('RECOMMENDED', 1)
  assert.match(model.headline(rec, ['MON', 'TUE']), /더 배치하면 돼요 · 새로 뽑지 않고 지금 직원으로 채워요/)
})


test('CodeRabbit 반영: 사장님 시작이 끝보다 늦어지는 변경은 되돌리고 이유를 준다', () => {
  const reply = { source: 'LLM', intent: 'EDIT', changes: [{ key: 'owner_start', value: '16:00' }], worker_changes: [], reply: '바꿨어요' }
  const out = chat.applyReply(cond, reply, { open: '07:00', close: '19:00' })
  assert.equal(out.changed, false)
  assert.equal(out.next.team.ownerStart, '07:00')
  assert.match(out.rejected, /시작\(16:00\)이 끝\(15:00\)보다/)
  // 시작과 끝을 같이 옮기면 받는다
  const both = chat.applyReply(cond, { ...reply, changes: [{ key: 'owner_start', value: '16:00' }, { key: 'owner_end', value: '19:00' }] }, { open: '07:00', close: '19:00' })
  assert.equal(both.rejected, undefined)
  assert.equal(both.next.team.ownerStart, '16:00')
})

test('주간 비교: 요일 평균과 가장 긴 요일의 값은 구분한다', () => {
  const o = { peak_wait_sec: { MON: 100, TUE: 300 } }
  assert.equal(model.worstPeak(o, ['MON', 'TUE']), 300)
  assert.equal(model.averagePeak(o, ['MON', 'TUE']), 200)
})


test('주간 비교: 카드의 요일 평균과 추천 대비 대기 차이가 같은 기준이다', () => {
  const days = ['MON', 'TUE', 'SAT']
  const rec = { key: 'RECOMMENDED', plan_cost_krw: 100000, peak_wait_sec: { MON: 100, TUE: 100, SAT: 224.4 } }
  const save = { key: 'SAVE', plan_cost_krw: 90000, peak_wait_sec: { MON: 150, TUE: 143.6, SAT: 229.8 } }
  assert.equal(model.waitText(model.averagePeak(rec, days)), '2분 21초')
  assert.equal(model.waitText(model.averagePeak(save, days)), '2분 54초')
  assert.equal(model.waitText(model.worstPeak(rec, days)), '3분 44초')
  assert.equal(model.waitText(model.worstPeak(save, days)), '3분 50초')
  assert.equal(model.versusText(save, rec, days), '추천보다 대기 +33초 · 인건비 −10,000원')
  // 하루 근무표는 그날의 값만 쓴다.
  assert.equal(model.averagePeak(save, ['SAT']), model.worstPeak(save, ['SAT']))
  // 두 안의 측정 요일이 다르면 카드에 표시된 평균을 무리하게 비교하지 않는다.
  const missing = { ...save, peak_wait_sec: { ...save.peak_wait_sec, MON: null } }
  assert.equal(model.versusText(missing, rec, days), '추천보다 대기 비교 불가(측정 요일 다름) · 인건비 −10,000원')
  assert.equal(model.averagePeak(missing, ['MON']), null)
})


test('주간 요약·AI에는 같은 최종 근무표 대기(초)를 집계해 분·초로 표시한다', () => {
  const fixture = { ...data, options: [
    { ...data.options[0], peak_wait_sec: { MON: 190, TUE: 210 }, plan_cost_krw: 1398360 },
    { ...data.options[1], peak_wait_sec: { MON: 150, TUE: 184 }, plan_cost_krw: 1759560 },
    { ...data.options[2], peak_wait_sec: { MON: 150, TUE: 174 }, plan_cost_krw: 2156880 },
  ] }
  const days = model.shownDays(fixture)
  assert.equal(model.waitText(model.averagePeak(fixture.options[1], days)), '2분 47초')
  assert.match(model.optionSummary(fixture, fixture.options[1], days), /3분 20초 → 2분 47초/)
  assert.match(model.optionSummary(fixture, fixture.options[2], days), /여유 근무표:.*3분 20초 → 2분 42초/)
  assert.match(model.versusText(fixture.options[0], fixture.options[1], days), /대기 \+33초/)
  const digest = rosterDigest(fixture)
  assert.equal(digest.options[1].peak_wait_text_avg, '2분 47초')
  assert.equal(digest.options[1].final_wait_by_day.MON, '2분 30초')
  assert.equal(digest.days.MON.trial_wait_by_extra[0].wait_text, '7분')
  assert.equal(digest.options[1].peak_wait_min_avg, undefined)
})

test('하루 근무표와 변경된 결과는 현재 데이터만 쓰고 인원 추가 실험과 구분한다', () => {
  const first = { ...data, days: { MON: data.days.MON }, options: [
    { ...data.options[0], peak_wait_sec: { MON: 225.6 } },
    { ...data.options[1], peak_wait_sec: { MON: 153.6 } },
    { ...data.options[2], peak_wait_sec: { MON: 146.4 } },
  ] }
  const days = model.shownDays(first)
  assert.match(model.optionSummary(first, first.options[1], days), /3분 46초 → 2분 34초, 하루 인건비/)
  assert.doesNotMatch(model.optionSummary(first, first.options[1], days), /요일 평균/)
  assert.equal(rosterDigest(first).options[1].peak_wait_text_avg, '2분 34초')
  const next = { ...first, options: [first.options[0], { ...first.options[1], peak_wait_sec: { MON: 119.6 } }, first.options[2]] }
  assert.match(model.optionSummary(next, next.options[1], days), /3분 46초 → 2분,/)
  assert.equal(rosterDigest(next).options[1].peak_wait_text_avg, '2분')
  assert.equal(model.ladderBars(next, 'MON')[1].sec, 170, '실험 값은 최종 근무표 값으로 덮어쓰지 않는다')
})

test('초 변환은 평균 집계 후 한 번만 반올림한다', () => {
  const selected = { ...data.options[1], peak_wait_sec: { MON: 59.44, TUE: 59.46 } }
  assert.equal(model.waitText(model.averagePeak(selected, ['MON', 'TUE'])), '59초')
  assert.equal(model.waitText(model.averagePeak({ ...selected, peak_wait_sec: { MON: null, TUE: 59.6 } }, ['MON', 'TUE'])), '1분')
})


test('추천 대비 차이는 카드에 표시된 초의 차이와 정확히 일치한다', () => {
  const rec = { ...data.options[1], peak_wait_sec: { MON: 100.49 } }
  const save = { ...data.options[0], peak_wait_sec: { MON: 110.51 } }
  assert.equal(model.versusText(save, rec, ['MON']), '추천보다 대기 +11초 · 인건비 같음')
})


test('재계산한 저장 응답에서 새 실험값과 최종값을 각각 읽고 막대 높이를 비례시킨다', () => {
  const stored = (trial, final) => ({ summary: { model_version: 'operation.roster_options.v1' }, detail: {
    min_gain_sec: 30, skipped_days: [], assumptions: [], days: { MON: { ...data.days.MON,
      ladder: trial.map((sec, extra) => ({ extra, peak_wait_sec: sec })) } },
    choices: data.options.map(({ key, ...o }, i) => ({ ...o, choice_key: key, peak_wait_sec: { MON: final[i] } })),
  } })
  const first = optionsFromStored(stored([213, 153, 146], [162, 151, 146]))
  const next = optionsFromStored(stored([165, 132, 131], [170, 150, 131]))
  assert.deepEqual(model.ladderBars(first, 'MON').map(b => b.sec), [213, 153, 146])
  assert.deepEqual(model.ladderBars(next, 'MON').map(b => b.sec), [165, 132, 131])
  assert.deepEqual(model.ladderBars(next, 'MON').map(b => b.ratio), [1, 132/165, 131/165])
  assert.match(model.optionSummary(next, next.options[1], ['MON']), /2분 50초 → 2분 30초/)
  assert.equal(model.ladderBars(first, 'MON')[1].ratio, 153/213)
  assert.equal(model.ladderBars(next, 'MON')[1].pick, 'RECOMMENDED')
})


test('최종 추천이 절약안이면 AI도 절약안을 기준으로 비교한다', () => {
  const fixture = { ...data, options: data.options.map((o, i) => ({ ...o, plan_cost_krw: 100000 + i * 10000 })) }
  const digest = rosterDigest(fixture, 'SAVE')
  assert.equal(digest.recommended_choice_key, 'SAVE')
  assert.equal(digest.options[1].title, '균형 근무표')
  assert.equal(digest.options[1].cost_gap_vs_recommended_krw, 10000)
  assert.equal(digest.options[0].cost_gap_vs_recommended_krw, 0)
})

test('하루 그래프는 선택 요일의 실험값만 읽는다', () => {
  const single = { ...data, days: { TUE: data.days.TUE } }
  assert.deepEqual(model.ladderBars(single, 'MON'), [])
  assert.equal(model.ladderBars(single, 'TUE')[0].sec, 300)
  assert.equal(model.ladderBars(single, 'TUE')[0].pick, 'RECOMMENDED')
})


test('절약안과 균형안의 최종 지표가 같을 때 동일하다고 표시한다', () => {
  const save = data.options[0]
  const balance = { ...save, key: 'RECOMMENDED' }
  assert.equal(model.versusText(balance, save, ['MON', 'TUE']), '추천안과 예상 대기·인건비·채용 필요 인원이 같아요')
  assert.equal(model.versusText(save, save, ['MON', 'TUE']), null)
})

test('재계산 후 같은 요일 그래프도 새 실험값을 읽는다', () => {
  const first = { ...data, days: { MON: data.days.MON } }
  const next = { ...first, days: { MON: { ...first.days.MON, ladder: [{ extra: 0, peak_wait_sec: 150 }, { extra: 1, peak_wait_sec: 144 }], picks: { SAVE: 0, RECOMMENDED: 0, ROOMY: 1 } } } }
  assert.equal(model.ladderBars(first, 'MON')[0].sec, 420)
  assert.equal(model.ladderBars(next, 'MON')[0].sec, 150)
  assert.equal(model.ladderBars(next, 'MON')[0].pick, 'RECOMMENDED')
  assert.equal(model.ladderBars(next, 'MON')[1].sec, 144)
})

test('최종 그래프는 실험값이 아닌 선택 요일의 최종값을 사용한다', () => {
  const final = { ...data, options: data.options.map((o, i) => ({ ...o, peak_wait_sec: { MON: [150,145,143][i], TUE: [186,144,140][i] } })) }
  const bars = model.finalWaitBars(final, 'MON', 'SAVE')
  assert.deepEqual(bars.map(b => b.sec), [150,145,143])
  assert.deepEqual(bars.map(b => b.recommended), [true,false,false])
  assert.deepEqual(bars.map(b => b.ratio), [1,145/150,143/150])
  assert.deepEqual(model.finalWaitBars(final, 'TUE', 'SAVE').map(b => b.sec), [186,144,140])
  assert.equal(model.busiestDay(final, ['MON','TUE']), 'TUE')
  for (const o of final.options) {
    const vals = model.shownDays(final).map(d => model.finalWaitBars(final,d,'SAVE').find(b => b.key === o.key).sec)
    assert.equal(vals.reduce((a,b) => a+b,0)/vals.length, model.averagePeak(o,model.shownDays(final)))
  }
})

test('하루 최종 그래프와 카드의 값은 동일하고 다른 요일은 읽지 않는다', () => {
  const final = { ...data, days: { TUE: data.days.TUE }, options: data.options.map((o,i) => ({ ...o, peak_wait_sec: { MON: 420, TUE: [144,144,140][i] } })) }
  assert.deepEqual(model.finalWaitBars(final,'MON','SAVE'), [])
  assert.deepEqual(model.finalWaitBars(final,'TUE','SAVE').map(b => b.sec), [144,144,140])
  assert.equal(model.busiestDay(final, model.shownDays(final)), 'TUE')
  for (const o of final.options) assert.equal(model.finalWaitBars(final,'TUE','SAVE').find(b=>b.key===o.key).sec,model.averagePeak(o,['TUE']))
})

test('재계산한 결과는 실험값이 같아도 최종 그래프가 갱신된다', () => {
  const first = { ...data, options: data.options.map((o,i) => ({ ...o, peak_wait_sec: { MON: [150,145,143][i] } })) }
  const next = { ...first, options: first.options.map((o,i) => ({ ...o, peak_wait_sec: { MON: [180,130,125][i] } })) }
  const before = JSON.stringify(first)
  assert.deepEqual(model.finalWaitBars(first,'MON','SAVE').map(b => b.sec),[150,145,143])
  assert.deepEqual(model.finalWaitBars(next,'MON','RECOMMENDED').map(b => b.sec),[180,130,125])
  assert.deepEqual(model.finalWaitBars(next,'MON','RECOMMENDED').map(b => b.recommended),[false,true,false])
  assert.equal(JSON.stringify(first),before)
})

test('측정 불가를 0초로 바꾸지 않고 0초는 유효값으로 유지한다', () => {
  const final = { ...data, options: data.options.map((o,i) => ({ ...o, peak_wait_sec: { MON: [null,0,80][i] } })) }
  const bars = model.finalWaitBars(final,'MON','ROOMY')
  assert.deepEqual(bars.map(b=>b.sec),[null,0,80])
  assert.deepEqual(bars.map(b=>b.ratio),[0,0,1])
  assert.equal(model.waitText(bars[0].sec),'—')
  assert.equal(model.waitText(bars[1].sec),'0초')
})
