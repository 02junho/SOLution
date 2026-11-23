// 가게 데이터 버전 폼: 영업시간·가게 데이터(메뉴별 잔 수·제조시간)를 저장 본문에 넣는지, 안 넣으면 지금 버전과 같은지.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
const input = await server.ssrLoadModule('/src/features/operation/workspace/operationInput.ts')
after(async () => {
  await server.close()
})

test('영업시간과 가게 데이터를 안 넣으면 저장 본문이 지금 버전과 같다', () => {
  const body = input.draftBody(input.DEFAULT_FORM)
  assert.deepEqual(Object.keys(body).sort(), [
    'daily_orders',
    'handoff_time_sec',
    'hourly_wage_krw',
    'is_owner_working',
    'menu_weights',
    'order_time_sec',
    'selected_menu_ids',
  ])
})

test('가게 데이터가 있으면 잔 수 합계가 하루 주문이고 비중 칸 대신 잔 수를 보낸다', () => {
  const { store, openTime, closeTime } = input.parseStoreData(input.DEMO_STORE)
  const form = { ...input.DEFAULT_FORM, store, openTime, closeTime }
  const body = input.draftBody(form)
  assert.equal(body.daily_orders, 130)
  assert.equal(body.open_time, '08:00')
  assert.equal(body.close_time, '20:00')
  assert.deepEqual(body.menu_cups, input.DEMO_STORE.menu_cups)
  assert.deepEqual(body.manufacture_sec_by_menu, input.DEMO_STORE.manufacture_sec_by_menu)
  assert.equal(body.menu_weights, undefined)
  assert.deepEqual(input.problemsOf(form), [])
  // 저장한 값을 다시 열면 같은 폼이 된다.
  const reopened = input.formFromInput(input.formInput(form))
  assert.equal(reopened.openTime, '08:00')
  assert.deepEqual(reopened.store, store)
  const saved = input.readOperationInput(input.formInput(form))
  assert.equal(saved.dailyOrders, 130)
  assert.equal(saved.lastOrderTime, '19:45')
  assert.equal(saved.slotOrders, null)
})

test('라스트 오더는 마감에 맞춰 고른다', () => {
  assert.deepEqual(input.lastOrderTimes('20:00'), ['19:30', '19:35', '19:40', '19:45', '19:50', '19:55', '20:00'])
  const form = { ...input.DEFAULT_FORM, closeTime: '20:00', lastOrderTime: '19:00' }
  assert.ok(input.problemsOf(form).some((p) => p.includes('19:30~20:00')))
})

test('잘못된 가게 데이터는 이유를 알려 준다', () => {
  assert.throws(() => input.parseStoreData({}), /menu_cups/)
  assert.throws(() => input.parseStoreData({ menu_cups: { latte: 10 } }), /모르는 메뉴/)
  assert.throws(() => input.parseStoreData({ menu_cups: { iced_americano: 301 } }), /1~300잔/)
  assert.throws(
    () => input.parseStoreData({ menu_cups: { iced_americano: 10 }, manufacture_sec_by_menu: { hot_cafe_latte: 60 } }),
    /잔 수가 있는 메뉴/,
  )
  assert.throws(() => input.parseStoreData({ menu_cups: { iced_americano: 10 }, open_time: '11:00' }), /오픈/)
})
