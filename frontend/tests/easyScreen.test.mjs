import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baselineSentence,
  choiceSentence,
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
