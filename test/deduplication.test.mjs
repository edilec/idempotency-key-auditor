import assert from 'node:assert/strict'
import test from 'node:test'

import { cliReport, findingsFor, fixture, operation, raisedRules, record } from './support.mjs'

/**
 * One record, one finding, however many comparisons needed it.
 *
 * A record that is missing a fingerprint is compared against every later
 * record on its key, so the branch that reports the gap runs once per
 * comparison. Without the `reported` guard the same record produces the same
 * finding at the same pointer several times over, and a reader counting
 * findings counts one problem as three.
 *
 * Each case below puts the record with the missing evidence *first*, so it
 * stays the anchor and is re-examined by every follower. Two followers is
 * enough: the guard either holds or the finding appears twice.
 */

const REQUEST_A = 'sha256:1111111111111111'
const REQUEST_B = 'sha256:aaaaaaaaaaaaaaaa'
const REQUEST_C = 'sha256:cccccccccccccccc'
const RESULT_A = 'sha256:2222222222222222'
const RESULT_B = 'sha256:bbbbbbbbbbbbbbbb'

const at = (seconds) => `2026-03-01T09:00:${String(seconds).padStart(2, '0')}Z`

test('a record with no request fingerprint is reported once, not once per comparison', async () => {
  const { code, report } = await cliReport(fixture([operation()], [
    record({ id: 'cap-1', observedAt: at(0), requestFingerprint: undefined, responseFingerprint: RESULT_A }),
    record({ id: 'cap-2', observedAt: at(30), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
    record({ id: 'cap-3', observedAt: at(45), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
  ]))

  assert.deepEqual(raisedRules(report), ['payload-evidence-missing'])
  assert.equal(findingsFor(report, 'payload-evidence-missing').length, 1, 'cap-1 was compared twice and is missing one fingerprint')
  assert.equal(findingsFor(report, 'payload-evidence-missing')[0].location.pointer, '/records/0')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('a record with no response fingerprint is reported once when the bodies match', async () => {
  const { code, report } = await cliReport(fixture([operation()], [
    record({ id: 'cap-1', observedAt: at(0), requestFingerprint: REQUEST_A, responseFingerprint: undefined }),
    record({ id: 'cap-2', observedAt: at(30), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_B }),
    record({ id: 'cap-3', observedAt: at(45), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_B }),
  ]))

  assert.deepEqual(raisedRules(report), ['outcome-evidence-missing'])
  assert.equal(findingsFor(report, 'outcome-evidence-missing').length, 1, 'cap-1 was compared twice and is missing one fingerprint')
  assert.equal(findingsFor(report, 'outcome-evidence-missing')[0].location.pointer, '/records/0')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('a record with no response fingerprint is reported once when the bodies differ', async () => {
  const { code, report } = await cliReport(fixture(
    [operation({ idempotency: { conflictStatus: undefined } })],
    [
      record({ id: 'cap-1', observedAt: at(0), requestFingerprint: REQUEST_A, responseFingerprint: undefined }),
      record({ id: 'cap-2', observedAt: at(30), requestFingerprint: REQUEST_B, responseFingerprint: RESULT_B }),
      record({ id: 'cap-3', observedAt: at(45), requestFingerprint: REQUEST_C, responseFingerprint: RESULT_B }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['outcome-evidence-missing'])
  assert.equal(findingsFor(report, 'outcome-evidence-missing').length, 1, 'cap-1 was compared twice and is missing one fingerprint')
  assert.equal(findingsFor(report, 'outcome-evidence-missing')[0].location.pointer, '/records/0')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})
