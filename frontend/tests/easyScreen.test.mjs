import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baselineSentence,
  choiceSentence,
  defaultTitle,
  packLabel,
  quantity,
} from '../src/features/workflow/model.ts'

// 쉬운 화면(시니어 사장님 기준): 안 카드와 비교 문장이 숫자 대신 쉬운 말로 나온다.

test('가장 싼 안은 "가장 싸요", 다른 안은 얼마 더 드는지 말한다', () => {
  assert.equal(
    choiceSentence({ choice_key: 'purchase_1', total_krw: 113280, delivery_count: 2 }, 113280),
    '가장 싸요. 배송은 2번 와요.',
  )
  assert.equal(
    choiceSentence({ choice_key: 'purchase_2', total_krw: 127500, delivery_count: 1 }, 113280),
    '가장 싼 안보다 14,220원 더 들어요. 한 번에 다 받아요.',
  )
})

test('값이 없으면 빈 말을 만들지 않는다', () => {
  assert.equal(choiceSentence({ choice_key: 'x' }, null), '')
  assert.equal(
    choiceSentence({ choice_key: 'x', total_krw: 1000 }, null),
    '',
  )
})

test('기준선과의 차이를 아끼는지 더 드는지로 말한다', () => {
  assert.equal(
    baselineSentence(-52810),
    '품목마다 가장 싼 곳에서 따로 살 때보다 52,810원 아껴요.',
  )
  assert.equal(
    baselineSentence(2200),
    '품목마다 가장 싼 곳에서 따로 살 때보다 2,200원 더 들어요.',
  )
  assert.equal(
    baselineSentence(0),
    '품목마다 가장 싼 곳에서 따로 살 때와 같아요.',
  )
})

test('양은 kg·L·개로 읽기 쉽게 보여 준다', () => {
  assert.equal(quantity(2700, 'g'), '2.7kg')
  assert.equal(quantity(500, 'g'), '500g')
  assert.equal(quantity(10400, 'ml'), '10.4L')
  assert.equal(quantity(130, 'ea'), '130개')
  assert.equal(quantity(null, 'g'), '확인 필요')
  // 바꾸면 반올림돼 차이가 사라지는 값은 원래 단위로 둔다
  assert.equal(quantity(1001, 'g'), '1,001g')
  assert.equal(quantity(0.001, 'g'), '0.001g')
  assert.equal(quantity(12500, 'ml'), '12.5L')
  assert.equal(packLabel(1000, 'g'), '1kg')
  assert.equal(packLabel(12000, 'ml'), '12L')
  assert.equal(packLabel(50, 'ea'), '50개 묶음')
})

test('업무 이름을 비우면 날짜가 들어간 이름을 쓴다', () => {
  const day = new Date(2026, 10, 18)
  assert.equal(defaultTitle('purchase', day), '11월 18일 매입 준비')
  assert.equal(defaultTitle('operation', day), '11월 18일 운영 준비')
})
