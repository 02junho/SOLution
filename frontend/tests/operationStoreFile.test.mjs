// 가게 데이터 파일 읽기: 시연 예시 두 개(마이샵 승인 내역 CSV·EUC-KR, POS 판매 내역 xlsx)와 작은 표로 정리 규칙을 본다.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
const f = await server.ssrLoadModule('/src/features/operation/workspace/storeFile.ts')
after(async () => {
  await server.close()
})
const fileOf = (name) => {
  const buf = readFileSync(new URL(`../public/samples/${name}`, import.meta.url))
  return new File([buf], name)
}

test('마이샵 승인 내역(EUC-KR CSV): 시각만으로 시간대·영업시간·바쁜 시간을 뽑고 취소·중복을 뺀다', async () => {
  const table = await f.readTable(fileOf('myshop_approvals_sample.csv'))
  const imp = f.analyzeTable(table, 'myshop_approvals_sample.csv')
  assert.equal(imp.hasTime, true)
  assert.equal(imp.hasMenu, false)
  assert.equal(imp.excluded.cancelled, 12)
  assert.equal(imp.excluded.duplicate, 1)
  assert.equal(Object.keys(imp.byDate).length, 14)
  const plan = f.planFrom(imp)
  assert.equal(plan.open, '08:00')
  assert.equal(plan.close, '20:00')
  assert.equal(Object.keys(plan.ordersBySlot).length, 12)
  // 연속 3시간 중 주문이 가장 많은 구간(점심 12~14시를 포함)
  assert.ok(plan.peak.start <= '12:00' && plan.peak.end >= '14:00', JSON.stringify(plan.peak))
  assert.equal(plan.dailyOrders, Object.values(plan.ordersBySlot).reduce((a, b) => a + b, 0))
  assert.ok(plan.dailyOrders > 80 && plan.dailyOrders < 160, String(plan.dailyOrders))
  assert.ok(plan.outsideHours > 0, '오픈 전 결제는 영업시간 밖으로 빠진다')
  assert.equal(plan.menuCups, null)
  assert.ok(plan.defaults.some((d) => d.startsWith('메뉴 구성')))
  assert.deepEqual(plan.problems, [])
  // 가장 바쁜 요일(금)과 주말은 평균과 다르다.
  assert.equal(plan.busiestWeekday, 'FRI')
  const sunday = f.planFrom(imp, 'SUN')
  assert.equal(sunday.days, 2)
  assert.ok(sunday.dailyOrders < plan.dailyOrders)
  // 바쁜 시간을 고치면 그대로 쓴다.
  assert.deepEqual(f.planFrom(imp, 'AVERAGE', { start: '11:00', end: '14:00' }).peak, { start: '11:00', end: '14:00' })
})

test('POS 판매 내역(xlsx): 머리글 줄을 찾고 메뉴를 유형으로 알아보며, 고르거나 뺄 수 있다', async () => {
  const table = await f.readTable(fileOf('pos_sales_sample.xlsx'))
  const imp = f.analyzeTable(table, 'pos_sales_sample.xlsx')
  assert.equal(imp.hasTime, true)
  assert.equal(imp.hasMenu, true)
  assert.ok(imp.excluded.cancelled > 0, '반품 줄')
  const plan = f.planFrom(imp)
  const byName = Object.fromEntries(plan.menus.map((m) => [m.name, m.menuId]))
  assert.equal(byName['아이스아메리카노'], 'iced_americano')
  assert.equal(byName['(ICE)카페라떼'], 'iced_cafe_latte')
  assert.equal(byName['카페라떼 HOT'], 'hot_cafe_latte')
  assert.equal(byName['바닐라라떼(ICE)'], 'iced_vanilla_latte')
  // 온도 없는 아메리카노는 아이스 커피로 추정, 크로플은 음료 아님으로 뺀다.
  const how = Object.fromEntries(plan.menus.map((m) => [m.name, m.how]))
  assert.equal(byName['아메리카노'], 'iced_americano')
  assert.equal(how['아메리카노'], 'KEYWORD')
  assert.equal(byName['크로플'], null)
  assert.equal(how['크로플'], 'FOOD')
  assert.deepEqual(plan.problems, [])
  assert.ok(plan.defaults.some((d) => d.includes('추정')))
  // 빼는 메뉴는 시간대 주문에서도 빠지고, 잔 수 합계는 시간대 합계와 같다.
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)
  assert.equal(sum(plan.menuCups), plan.dailyOrders)
  const mapped = f.planFrom(imp, 'AVERAGE', null, { 아메리카노: 'hot_americano', 크로플: 'iced_americano' })
  assert.ok(mapped.menuCups.hot_americano > 0)
  assert.equal(mapped.menus.find((m) => m.name === '크로플').chosen, true)
  assert.ok(mapped.dailyOrders > plan.dailyOrders, '뺐던 메뉴를 넣으면 주문 수에 다시 들어간다')
})

test('메뉴 유형: 처음 보는 이름도 낱말로 만드는 방식을 알아본다', () => {
  const pick = (name) => f.classifyMenu(name)
  assert.deepEqual(pick('말차 프라페'), { menuId: 'blueberry_yogurt_smoothie', how: 'KEYWORD' })
  assert.deepEqual(pick('얼그레이 밀크티'), { menuId: 'iced_milk_tea', how: 'KEYWORD' })
  assert.deepEqual(pick('HOT 아인슈페너'), { menuId: 'hot_cafe_latte', how: 'KEYWORD' })
  assert.deepEqual(pick('아인슈페너'), { menuId: 'iced_vanilla_latte', how: 'KEYWORD' })
  assert.deepEqual(pick('자몽에이드'), { menuId: 'iced_lemon_ade', how: 'KEYWORD' })
  assert.deepEqual(pick('콜드브루'), { menuId: 'iced_americano', how: 'KEYWORD' })
  assert.deepEqual(pick('따뜻한 딸기라떼'), { menuId: 'hot_cafe_latte', how: 'KEYWORD' })
  assert.deepEqual(pick('티라미수 케이크'), { menuId: null, how: 'FOOD' })
  assert.deepEqual(pick('아이스 카페라떼'), { menuId: 'iced_cafe_latte', how: 'EXACT' })
  assert.equal(pick('시그니처 블렌딩 X'), null)
  // 모르는 이름은 가장 많이 팔린 유형으로 채우고(확인 필요), AI가 고른 유형이 있으면 그것을 쓴다.
  const imp = f.analyzeTable(f.parseCsv('품목,수량\n아이스 카페라떼,70\n오늘의 시그니처,30\n'), 'm.csv')
  const guessed = f.planFrom(imp)
  assert.equal(guessed.menus[1].how, 'GUESS')
  assert.deepEqual(guessed.menuCups, { iced_cafe_latte: 100 })
  assert.ok(guessed.defaults.some((d) => d.includes('오늘의 시그니처')))
  const ai = f.planFrom(imp, 'AVERAGE', null, {}, 1, { '오늘의 시그니처': 'blueberry_yogurt_smoothie' })
  assert.equal(ai.menus[1].how, 'AI')
  assert.deepEqual(ai.menuCups, { blueberry_yogurt_smoothie: 30, iced_cafe_latte: 70 })
})

test('작은 표: 날짜+시간 두 열, 오전/오후, 탭 구분, 시각 없는 메뉴 파일', () => {
  const tsv = '거래일자\t거래시간\t금액\n2026.11.03\t오후 2:05\t4500\n2026.11.03\t오전 9:10\t4500\n2026.11.03\t오후 12:30\t-4500\n'
  const imp = f.analyzeTable(f.parseCsv(tsv), 'a.tsv')
  assert.equal(imp.excluded.cancelled, 1)
  assert.equal(imp.byDate['2026-11-03'].hours[14], 1)
  assert.equal(imp.byDate['2026-11-03'].hours[9], 1)
  const menuOnly = f.analyzeTable(f.parseCsv('품목,수량\n아이스 아메리카노,70\n"핫 카페라떼",30\n'), 'b.csv')
  const plan = f.planFrom(menuOnly)
  assert.equal(plan.ordersBySlot, null)
  assert.equal(plan.dailyOrders, 100)
  assert.deepEqual(plan.menuCups, { hot_cafe_latte: 30, iced_americano: 70 })
  assert.ok(plan.defaults.some((d) => d.startsWith('시간대별 손님')))
  assert.throws(() => f.analyzeTable(f.parseCsv('이름,전화\n가,1\n'), 'c.csv'), /열을 찾지 못했어요/)
})

test('반올림해도 합계는 그대로다', () => {
  assert.deepEqual(f.roundKeepingTotal([1.4, 1.4, 1.2]), [2, 1, 1])
  assert.equal(f.menuKey('ICE 카페라떼'), f.menuKey('아이스 카페라떼'))
})

test('가게 데이터로 저장할 폼을 만들고, 본문에는 정리한 숫자와 근거만 들어간다', async () => {
  const lab = await server.ssrLoadModule('/src/features/operation/roster/labModel.ts')
  const input = await server.ssrLoadModule('/src/features/operation/workspace/operationInput.ts')
  const imp = f.analyzeTable(await f.readTable(fileOf('myshop_approvals_sample.csv')), 'myshop_approvals_sample.csv')
  const plan = f.planFrom(imp, 'FRI')
  assert.deepEqual(lab.blocking(plan), [])
  const form = lab.formFromPlan(imp, plan, { isOwnerWorking: false, hourlyWage: 11000 })
  const body = input.draftBody(form)
  assert.deepEqual(body.orders_by_slot, plan.ordersBySlot)
  assert.equal(body.daily_orders, plan.dailyOrders)
  assert.equal(body.peak_start_time, plan.peak.start)
  assert.equal(body.store_source.basis, 'FRI')
  assert.equal(body.open_time, undefined, '영업시간은 시간대에서 정한다')
  assert.equal(body.menu_cups, undefined, '메뉴 없는 파일은 기본 메뉴 구성')
  assert.equal(body.menu_weights, undefined)
  assert.equal(body.is_owner_working, false)
  assert.ok(!JSON.stringify(body).includes('승인번호'), '원본 열은 담지 않는다')
  // 다시 열면 같은 값으로 보인다.
  const saved = input.readOperationInput(input.formInput(form))
  assert.equal(saved.hours.open, '08:00')
  assert.equal(saved.rush.start, plan.peak.start)
  assert.equal(saved.dailyOrders, plan.dailyOrders)
  assert.deepEqual(lab.hourEdges('08:00', '11:00'), ['08:00', '09:00', '10:00', '11:00'])
})

test('POS 예시는 가끔 있는 오픈 전 결제를 영업시간에 넣지 않는다', async () => {
  const imp = f.analyzeTable(await f.readTable(fileOf('pos_sales_sample.xlsx')), 'pos_sales_sample.xlsx')
  assert.equal(f.planFrom(imp).open, '08:00')
})

test('신한 상권 분포 예시: 첫 줄 출처 설명을 건너뛰고, 상권 데이터처럼 11~14시가 바쁘고 주말이 한산하다', async () => {
  for (const name of ['shinhan_pattern_approvals.csv', 'shinhan_pattern_pos.xlsx']) {
    const imp = f.analyzeTable(await f.readTable(fileOf(name)), name)
    assert.equal(Object.keys(imp.byDate).length, 28, name)
    const plan = f.planFrom(imp)
    assert.deepEqual(plan.peak, { start: '11:00', end: '14:00' }, name)
    assert.equal(plan.open, '07:00', name)
    assert.equal(plan.close, '20:00', name)
    assert.ok(plan.dailyOrders > 120 && plan.dailyOrders < 180, `${name} ${plan.dailyOrders}`)
    assert.ok(['MON', 'TUE', 'WED', 'THU', 'FRI'].includes(plan.busiestWeekday), name)
    assert.ok(f.planFrom(imp, 'SUN').dailyOrders < plan.dailyOrders / 3, name)
    assert.ok(f.planFrom(imp, 'THU').dailyOrders <= 300, name)
  }
  // 판매 내역 예시는 메뉴판 이름이 제각각이다. 유형으로 묶고, 디저트는 빼고, 모르는 이름 하나는 확인 필요로 채운다.
  const pos = f.planFrom(f.analyzeTable(await f.readTable(fileOf('shinhan_pattern_pos.xlsx')), 'pos.xlsx'))
  const how = Object.fromEntries(pos.menus.map((m) => [m.name, m.how]))
  assert.equal(how['말차 프라페'], 'KEYWORD')
  assert.equal(how['바스크 치즈케이크'], 'FOOD')
  assert.equal(how['오늘의 시그니처'], 'GUESS')
  assert.ok(pos.menuCups.blueberry_yogurt_smoothie > 0 && pos.menuCups.iced_milk_tea > 0)
  // 바쁜 카페 예시: 하루 250잔 안팎, 어느 요일도 계산 한도(300건) 안, 아침 8~10시도 붐빈다.
  const busy = f.analyzeTable(await f.readTable(fileOf('busy_cafe_pos.xlsx')), 'busy.xlsx')
  const avg = f.planFrom(busy)
  assert.ok(avg.dailyOrders > 180 && avg.dailyOrders < 260, String(avg.dailyOrders))
  for (const w of f.WEEKDAYS) assert.ok(f.planFrom(busy, w).dailyOrders <= 300, w)
  const mon = f.planFrom(busy, 'MON')
  assert.ok(mon.ordersBySlot['09:00-10:00'] > mon.ordersBySlot['15:00-16:00'] * 2)
})

test('카드 외 결제 보정: 비율만큼 주문을 늘리고 가정으로 표시한다', async () => {
  const imp = f.analyzeTable(await f.readTable(fileOf('myshop_approvals_sample.csv')), 'myshop_approvals_sample.csv')
  const base = f.planFrom(imp)
  const fixed = f.planFrom(imp, 'AVERAGE', null, {}, 0.8)
  assert.ok(Math.abs(fixed.dailyOrders - base.dailyOrders / 0.8) <= 1)
  assert.equal(fixed.open, base.open, '영업시간 판단은 파일 그대로')
  assert.ok(fixed.defaults.some((d) => d.includes('80%')))
  assert.equal(f.sourceOf(imp, fixed).card_share, 0.8)
  assert.equal(f.planFrom(imp, 'AVERAGE', null, {}, 0.1).cardShare, 0.5, '50% 아래는 50%로')
})

test('취소여부 열: Y는 취소, N은 정상', () => {
  const imp = f.analyzeTable(f.parseCsv('거래일시,취소여부,품목\n2026-11-02 09:10,N,아이스 아메리카노\n2026-11-02 09:20,Y,아이스 아메리카노\n2026-11-02 09:30,N,핫 카페라떼\n'), 'y.csv')
  assert.equal(imp.excluded.cancelled, 1)
  assert.equal(imp.byDate['2026-11-02'].hours[9], 2)
})

test('엑셀 숫자 시각: 093000(HHMMSS)은 9시 30분, 소수는 일련번호', () => {
  const imp = f.analyzeTable([['승인일자', '승인시간'], ['2026-11-02', 93000], ['2026-11-02', 143015], ['2026-11-02', 0.75]], 'n.xlsx')
  const hours = imp.byDate['2026-11-02'].hours
  assert.equal(hours[9], 1)
  assert.equal(hours[14], 1)
  assert.equal(hours[18], 1)
  assert.equal(imp.excluded.unreadable, 0)
})

test('설명 줄 뒤에 탭 머리글이 와도 탭으로 나눈다(설명 줄의 쉼표는 따옴표 안)', () => {
  const tsv = '"조회 기간: 2026-11-01, 2026-11-07"\n승인일시\t승인금액\t품목\n2026-11-02 09:10\t4500\t아이스 아메리카노\n'
  const imp = f.analyzeTable(f.parseCsv(tsv), 'd.tsv')
  assert.equal(imp.byDate['2026-11-02'].hours[9], 1)
})

test('메뉴 이름이 constructor·toString이어도 그대로 센다', () => {
  const imp = f.analyzeTable(f.parseCsv('품목,수량\nconstructor,3\ntoString,2\n'), 'p.csv')
  assert.equal(imp.undated.constructor, 3)
  assert.equal(imp.undated.toString, 2)
  const plan = f.planFrom(imp)
  assert.deepEqual(plan.menus.map((m) => m.chosen), [false, false])
})
