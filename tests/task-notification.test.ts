import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTaskNotifications, taskTone } from '../src/shared/task-notification.ts'

const sample = `<task-notification> <task-id>bzrkol1d2</task-id> <tool-use-id>toolu_01Sb</tool-use-id> <output-file>/private/tmp/x/tasks/bzrkol1d2.output</output-file> <status>completed</status> <summary>Background command "Wait for PR 63 CI" completed (exit code 0)</summary> </task-notification>`

test('parses a background command notification', () => {
  const { notifications, rest } = parseTaskNotifications(sample)
  assert.equal(rest, '')
  assert.deepEqual(notifications, [{
    status: 'completed',
    summary: 'Background command "Wait for PR 63 CI" completed (exit code 0)',
    taskId: 'bzrkol1d2',
    outputFile: '/private/tmp/x/tasks/bzrkol1d2.output',
    result: null,
  }])
})

test('keeps surrounding text and handles several blocks with results', () => {
  const text = `before\n${sample}\n<task-notification><status>failed</status><summary>Agent "review" failed</summary><result>line 1\nline 2</result></task-notification>\nafter`
  const { notifications, rest } = parseTaskNotifications(text)
  assert.equal(notifications.length, 2)
  assert.equal(notifications[1].status, 'failed')
  assert.equal(notifications[1].result, 'line 1\nline 2')
  assert.equal(rest, 'before\n\n\nafter')
})

test('plain messages pass through untouched', () => {
  assert.deepEqual(parseTaskNotifications('hi <b>there</b>'), { notifications: [], rest: 'hi <b>there</b>' })
})

test('taskTone maps statuses', () => {
  assert.equal(taskTone('completed'), 'ok')
  assert.equal(taskTone('killed'), 'error')
  assert.equal(taskTone('running'), 'neutral')
})
