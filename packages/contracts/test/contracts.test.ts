import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can, canTransition, reduceMessageState } from '../src/index.ts'

test('role defaults and delegated grants', () => {
  assert.ok(can('owner', [], 'workspace.close'))
  assert.ok(!can('admin', [], 'knowledge.publish'))
  assert.ok(can('admin', ['knowledge.publish'], 'knowledge.publish'))
  // grants never elevate support agents, and export/close are not delegable
  assert.ok(!can('support_agent', ['knowledge.publish'], 'knowledge.publish'))
  assert.ok(!can('admin', ['workspace.close'], 'workspace.close'))
})

test('state machine edges', () => {
  assert.ok(canTransition('knowledge', 'approved', 'published'))
  assert.ok(!canTransition('knowledge', 'draft', 'published'))
  assert.ok(!canTransition('workspace', 'draft', 'active'))
  assert.ok(!canTransition('connection', 'revoked', 'connected'))
  assert.ok(!canTransition('job', 'nonsense', 'leased'))
})

test('delivery state never moves backwards', () => {
  assert.equal(reduceMessageState('read', 'delivered'), 'read')
  assert.equal(reduceMessageState('accepted', 'read'), 'read') // skipped intermediate
  assert.equal(reduceMessageState('delivered', 'failed'), 'delivered')
  assert.equal(reduceMessageState('accepted', 'failed'), 'failed')
  assert.equal(reduceMessageState('uncertain', 'queued'), 'uncertain') // no blind resend
  assert.equal(reduceMessageState('uncertain', 'delivered'), 'delivered')
})
