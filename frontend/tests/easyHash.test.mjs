import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHash, routeHash } from '../src/features/easy/hashRoute.ts'

test('쉬운 화면 주소를 읽고 다시 만든다', () => {
  assert.deepEqual(parseHash(''), { kind: 'home' })
  assert.deepEqual(parseHash('#/'), { kind: 'home' })
  assert.deepEqual(parseHash('#/work'), { kind: 'sessions' })
  assert.deepEqual(parseHash('#/work/1795158153002000'), { kind: 'session', id: 1795158153002000 })
  assert.deepEqual(parseHash('#/plans'), { kind: 'plans' })
  assert.deepEqual(parseHash('#/plans/42'), { kind: 'plan', id: 42 })
  assert.deepEqual(parseHash('#/confirmations'), { kind: 'home' })
  for (const hash of ['#/', '#/work', '#/work/7', '#/plans', '#/plans/9']) {
    assert.equal(routeHash(parseHash(hash)), hash)
  }
})
