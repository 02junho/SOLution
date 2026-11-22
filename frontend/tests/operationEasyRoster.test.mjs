// 쉬운 화면 추천 근무표: 결과 글자·표 모양과 말로 고치기 반영(서버가 검사한 값만, 바뀐 줄 표시).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
const model = await server.ssrLoadModule('/src/features/operation/easy/easyRosterModel.ts')
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

test('대기 글자: 1분 안 / 반올림한 분 / 없음', () => {
  assert.equal(model.waitText(40), '1분 안')
  assert.equal(model.waitText(170), '약 3분')
  assert.equal(model.waitText(null), '—')
})

test('추천 한 줄: 새로 뽑을 직원 먼저, 모든 요일 같은 수면 "N명씩", 아니면 요일, 0이면 충분', () => {
  const days = model.shownDays(data)
  assert.deepEqual(days, ['MON', 'TUE'])
  assert.equal(model.headline(data.options[1], days), '바쁜 시간에 1명씩 더 두면 돼요')
  assert.equal(model.headline(data.options[0], days), '지금 직원으로 충분해요')
  // 새로 뽑을 직원이 있으면 그걸 먼저(표의 노란 줄과 맞게)
  assert.equal(model.headline({ ...data.options[0], shortfall: { more_people_under_15h: 2 } }, days), '직원 2명을 더 뽑으면 돼요')
  assert.equal(model.headline({ ...data.options[1], shortfall: { more_people_under_15h: 1 } }, days), '직원 1명을 더 뽑고, 바쁜 시간에 1명씩 더 두면 돼요')
  const mixed = { ...data.options[1], extra_by_day: { MON: 1, TUE: 0 } }
  assert.equal(model.headline(mixed, days), '월요일 바쁜 시간에 사람을 더 두면 돼요')
  const uneven = { ...data.options[1], extra_by_day: { MON: 1, TUE: 2 } }
  assert.equal(model.headline(uneven, days), '바쁜 시간에 요일마다 1~2명 더 두면 돼요')
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
  assert.equal(recent.CHOICE.RECOMMENDED, '추천 근무표')
  assert.equal(model.OPTION_NAME.ROOMY, recent.CHOICE.ROOMY)
})

test('줄 서는 모습의 일하는 사람: 이름 없이 사장님·직원 수', () => {
  assert.equal(model.staffText(['OWNER', 'STAFF_1', 'STAFF_2']), '사장님 · 직원 2명')
  assert.equal(model.staffText(['STAFF_3']), '직원 1명')
  assert.equal(model.staffText([]), '없음')
})

test('시각 글자', () => {
  assert.equal(model.clock('07:00'), '오전 7시')
  assert.equal(model.clock('13:30'), '오후 1시 30분')
  assert.equal(model.clock('12:00'), '오후 12시')
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
  assert.deepEqual(next.team.people.map((p) => p.name), ['직원 A', '새 직원 2'])
  assert.equal(next.team.people[0].maxHours, '10')
  assert.deepEqual(next.team.people[1].days, ['SAT'])
  assert.deepEqual(rows, ['team'])
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
