import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureRandomUUID, uuidV4 } from '../src/utils/randomUUID.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('uuidV4는 UUID v4 형식이고 매번 다르다', () => {
  const a = uuidV4(), b = uuidV4()
  assert.match(a, UUID_V4)
  assert.match(b, UUID_V4)
  assert.notEqual(a, b)
})

test('http(보안 연결 아님)처럼 randomUUID가 없으면 대체 함수를 넣는다', () => {
  const fake = { getRandomValues: (arr) => crypto.getRandomValues(arr) }
  ensureRandomUUID(fake)
  assert.equal(typeof fake.randomUUID, 'function')
  assert.match(fake.randomUUID(), UUID_V4)
})

test('이미 randomUUID가 있으면 바꾸지 않는다', () => {
  const original = () => 'original'
  const fake = { randomUUID: original }
  ensureRandomUUID(fake)
  assert.equal(fake.randomUUID, original)
})
