import assert from 'node:assert/strict'
import test from 'node:test'

import { cliReport, findingsFor, fixture, operation, raisedRules, record } from './support.mjs'

/**
 * Which record owns the key entry, in every branch that could move it.
 *
 * `docs/idempotency-rules.md` steps 4-5 say the anchor moves when the declared
 * expiry has passed and at no other time: the first caller is the one whose
 * result the store holds, so a later caller disagreeing with it does not
 * dispossess it. That is one rule with six branches, and five of them are
 * "do not move" -- the kind of guarantee a single test over the happy branch
 * leaves wide open.
 *
 * Each case below runs three records through the real binary and pins the
 * findings, the replay count, the status and the exit code. Three is the
 * smallest number that can tell the branches apart: with two records every
 * anchor is the same anchor.
 *
 * The replay count is the assertion that catches the dangerous direction. A
 * wrongly moved anchor can make a warning-severity finding vanish from a report
 * that still says `pass`, and only `replays` and the missing finding show it.
 */

const REQUEST_A = 'sha256:1111111111111111'
const REQUEST_B = 'sha256:aaaaaaaaaaaaaaaa'
const RESULT_A = 'sha256:2222222222222222'
const RESULT_B = 'sha256:bbbbbbbbbbbbbbbb'

const at = (seconds) => `2026-03-01T09:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z`

/** Three records on one key, in observation order. */
const three = (first, second, third) => [
  record({ id: 'cap-1', observedAt: at(0), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A, ...first }),
  record({ id: 'cap-2', observedAt: at(30), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A, ...second }),
  record({ id: 'cap-3', observedAt: at(60), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A, ...third }),
]

const SHORT_EXPIRY = { expiresAfterSeconds: 60, retryWindowSeconds: 60 }

test('the anchor moves when the declared expiry has passed, and the next pair is judged against the new one', async () => {
  const { code, report } = await cliReport(fixture([operation({ idempotency: SHORT_EXPIRY })], [
    record({ id: 'cap-1', observedAt: at(0), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
    record({ id: 'cap-2', observedAt: at(100), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
    record({ id: 'cap-3', observedAt: at(150), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
  ]))

  assert.deepEqual(raisedRules(report), ['key-expired-between-attempts'])
  assert.equal(findingsFor(report, 'key-expired-between-attempts').length, 1, 'cap-3 is inside cap-2 entry, not 150s past cap-1')
  assert.equal(findingsFor(report, 'key-expired-between-attempts')[0].location.pointer, '/records/1')
  assert.equal(report.summary.replays, 1, 'cap-3 replays the entry cap-2 opened')
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
})

test('a consistent replay does not move the anchor, so a later expiry is still measured from the first caller', async () => {
  const { code, report } = await cliReport(fixture([operation({ idempotency: SHORT_EXPIRY })], [
    record({ id: 'cap-1', observedAt: at(0), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
    record({ id: 'cap-2', observedAt: at(50), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
    record({ id: 'cap-3', observedAt: at(100), requestFingerprint: REQUEST_A, responseFingerprint: RESULT_A }),
  ]))

  assert.deepEqual(raisedRules(report), ['key-expired-between-attempts'], 'cap-3 arrives 100s after the entry was opened')
  assert.equal(findingsFor(report, 'key-expired-between-attempts')[0].location.pointer, '/records/2')
  assert.equal(report.summary.replays, 1, 'cap-2 alone')
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
})

test('a reuse the service refused does not move the anchor', async () => {
  const { code, report } = await cliReport(fixture([operation()], three(
    {},
    { requestFingerprint: REQUEST_B, responseFingerprint: RESULT_B, responseStatus: 409 },
    {},
  )))

  assert.deepEqual(raisedRules(report), ['key-conflict-detected'], 'cap-3 repeats the body cap-1 sent, which still owns the entry')
  assert.equal(report.summary.replays, 1)
  assert.equal(report.summary.conflictsRefused, 1)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
})

test('a key reused with a different body does not move the anchor', async () => {
  const { code, report } = await cliReport(fixture([operation()], three(
    {},
    { requestFingerprint: REQUEST_B, responseFingerprint: RESULT_B, responseStatus: 200 },
    {},
  )))

  assert.deepEqual(raisedRules(report), ['key-reused-different-payload'])
  assert.equal(findingsFor(report, 'key-reused-different-payload').length, 1, 'cap-3 agrees with cap-1, so there is one conflict and not two')
  assert.equal(findingsFor(report, 'key-reused-different-payload')[0].location.pointer, '/records/1')
  assert.equal(report.summary.replays, 1)
  assert.equal(report.summary.conflicts, 1)
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
})

test('a reuse whose handling is undetermined does not move the anchor', async () => {
  const { code, report } = await cliReport(fixture(
    [operation({ idempotency: { conflictStatus: undefined } })],
    three({}, { requestFingerprint: REQUEST_B, responseFingerprint: RESULT_B }, {}),
  ))

  assert.deepEqual(raisedRules(report), ['key-reuse-outcome-undetermined'])
  assert.equal(findingsFor(report, 'key-reuse-outcome-undetermined').length, 1)
  assert.equal(findingsFor(report, 'key-reuse-outcome-undetermined')[0].location.pointer, '/records/1')
  assert.equal(report.summary.replays, 1)
  assert.equal(report.summary.conflicts, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('two different outcomes for one body do not move the anchor', async () => {
  const { code, report } = await cliReport(fixture([operation()], three(
    {},
    { responseFingerprint: RESULT_B },
    {},
  )))

  assert.deepEqual(raisedRules(report), ['duplicate-outcome-conflict'])
  assert.equal(findingsFor(report, 'duplicate-outcome-conflict').length, 1, 'cap-3 matches cap-1, which still owns the entry')
  assert.equal(findingsFor(report, 'duplicate-outcome-conflict')[0].location.pointer, '/records/1')
  assert.equal(report.summary.replays, 1)
  assert.equal(report.summary.conflicts, 1)
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
})

test('a record with no request fingerprint does not become the anchor', async () => {
  const { code, report } = await cliReport(fixture([operation()], three(
    {},
    { requestFingerprint: undefined },
    {},
  )))

  assert.deepEqual(raisedRules(report), ['payload-evidence-missing'])
  assert.equal(findingsFor(report, 'payload-evidence-missing')[0].location.pointer, '/records/1')
  assert.equal(report.summary.replays, 1, 'cap-3 is still judged against cap-1, which has the evidence')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('a record with no response fingerprint does not become the anchor', async () => {
  const { code, report } = await cliReport(fixture([operation()], three(
    {},
    { responseFingerprint: undefined },
    {},
  )))

  assert.deepEqual(raisedRules(report), ['outcome-evidence-missing'])
  assert.equal(findingsFor(report, 'outcome-evidence-missing')[0].location.pointer, '/records/1')
  assert.equal(report.summary.replays, 1, 'cap-3 is still judged against cap-1, which has the evidence')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})
