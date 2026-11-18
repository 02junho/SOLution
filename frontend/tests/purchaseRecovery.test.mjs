import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const server = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
const { default: Results } = await server.ssrLoadModule(
  '/src/features/workflow/Results.tsx',
)
const { default: Form } = await server.ssrLoadModule(
  '/src/features/workflow/PurchaseForm.tsx',
)
test.after(async () => {
  await server.close()
})
const context = {
  feature_type: 'purchase',
  current_version_id: 100201,
  current_version: 1,
}
const result = {
  result_id: 1,
  input_version_id: 100201,
  response_status: 'infeasible',
  summary: {
    message: '예산이 부족해요',
    suggested_changes: [
      {
        path: 'budget_krw',
        label: '예산',
        unit: '원',
        current: 100000,
        suggested: 120400,
      },
      {
        path: 'max_delivery_count',
        label: '배송 횟수',
        unit: '회',
        current: 0,
        suggested: 2,
      },
    ],
  },
}
function render(value) {
  return renderToStaticMarkup(
    createElement(Results, {
      feature: 'purchase',
      workspace: {
        context,
        messages: [],
        busy: '',
        saved: null,
        input: null,
        result: value,
      },
      onEdit() {},
      onSaved() {},
    }),
  )
}
test('계산 불가 결과의 서버 제안 값과 단위를 표시한다', () => {
  const html = render(result)
  for (const text of ['예산 → 120,400원', '배송 횟수 → 2회', '조건 수정하기'])
    assert.ok(html.includes(text))
})
test('제안이 없으면 제안 영역을 표시하지 않는다', () => {
  assert.ok(
    !render({ ...result, summary: { message: '조건 확인 필요' } }).includes(
      '조건 변경 제안',
    ),
  )
})
test('조건 수정 폼은 저장된 숫자·품목을 채우고 재고 미입력은 비워 둔다', () => {
  const html = renderToStaticMarkup(
    createElement(Form, {
      initial: {
        budget_krw: 200000,
        planning_days: 7,
        items: [
          {
            item_id: 'milk',
            item_name: '우유',
            base_unit: 'ml',
            usable_inventory: null,
          },
        ],
        suppliers: [],
        quotes: [],
      },
      busy: false,
      serverError: '',
      onSave() {},
      onClose() {},
    }),
  )
  assert.ok(html.includes('value="200000"'))
  assert.ok(html.includes('value="7"'))
  assert.ok(html.includes('value="우유"'))
  assert.ok(!html.includes('value="null"'))
})

test('소수 제안 값은 화면에서 다시 입력해도 서버 값의 정밀도가 유지된다', () => {
  for (const suggested of [21000.123456789, 1.0000000000000002, 0.00000001]) {
    const html = render({
      ...result,
      summary: {
        suggested_changes: [
          {
            path: 'items[0].storage_capacity',
            label: '우유 보관 한도',
            unit: 'ml',
            current: 0,
            suggested,
          },
        ],
      },
    })
    const displayed = html.match(/우유 보관 한도 → ([\d,.]+)ml/)
    assert.ok(displayed, html)
    assert.equal(Number(displayed[1].replaceAll(',', '')), suggested)
  }
})
