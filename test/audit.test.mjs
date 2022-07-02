import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, findingsFor, fixture, operation, raisedRules, record } from './support.mjs'

/**
 * The outcome audit. Every assertion here is about what the capture contains,
 * because that is the only thing this tool can be about: it issues no request,
 * so it can show that captured outcomes contradict a declared boundary and it
 * can never show that an operation is idempotent in general.
 */

const FIRST = 'sha256:1111111111111111'
const SECOND = 'sha256:aaaaaaaaaaaaaaaa'
const RESULT_A = 'sha256:2222222222222222'
const RESULT_B = 'sha256:bbbbbbbbbbbbbbbb'

const at = (seconds) => `2026-03-01T09:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z`

test('the same key and the same body have one logical outcome', async () => {
  const report = await apiReport(fixture([operation()], [
    record({ id: 'cap-1', observedAt: at(0) }),
    record({ id: 'cap-2', observedAt: at(5) }),
    record({ id: 'cap-3', observedAt: at(9) }),
  ]))

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.replays, 2, 'two repeats, both consistent with the first outcome')
  assert.equal(report.summary.conflicts, 0)
  assert.equal(report.summary.keys, 1)
})

test('a key reused with a different body, answered with the first result, is the headline failure', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { conflictStatus: undefined } })],
    [
      record({ id: 'cap-1', requestFingerprint: FIRST, responseFingerprint: RESULT_A, observedAt: at(0) }),
      record({ id: 'cap-2', requestFingerprint: SECOND, responseFingerprint: RESULT_A, observedAt: at(30) }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['key-reused-different-payload'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.conflicts, 1)
  const finding = findingsFor(report, 'key-reused-different-payload')[0]
  assert.equal(finding.location.pointer, '/records/1', 'the finding belongs to the second caller')
  assert.match(finding.message, /received that first caller's result verbatim/)
  assert.equal(finding.evidence, `request fingerprints: ${FIRST} then ${SECOND}`)
})

test('a reuse the service refused with the declared conflict status is the guard working', async () => {
  const report = await apiReport(fixture([operation()], [
    record({ id: 'cap-1', requestFingerprint: FIRST, observedAt: at(0) }),
    record({ id: 'cap-2', requestFingerprint: SECOND, responseStatus: 409, responseFingerprint: RESULT_B, observedAt: at(30) }),
  ]))

  assert.deepEqual(raisedRules(report), ['key-conflict-detected'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.conflicts, 0)
  assert.equal(report.summary.conflictsRefused, 1)
})

test('a reuse answered with anything but the declared conflict status is a failure', async () => {
  const report = await apiReport(fixture([operation()], [
    record({ id: 'cap-1', requestFingerprint: FIRST, observedAt: at(0) }),
    record({ id: 'cap-2', requestFingerprint: SECOND, responseStatus: 200, responseFingerprint: RESULT_B, observedAt: at(30) }),
  ]))

  assert.deepEqual(raisedRules(report), ['key-reused-different-payload'])
  assert.equal(report.status, 'fail')
  assert.match(findingsFor(report, 'key-reused-different-payload')[0].message, /instead of the declared conflict status 409/)
})

test('a reuse whose handling cannot be read off the capture is undetermined, and never a pass', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { conflictStatus: undefined } })],
    [
      record({ id: 'cap-1', requestFingerprint: FIRST, responseFingerprint: RESULT_A, observedAt: at(0) }),
      record({ id: 'cap-2', requestFingerprint: SECOND, responseFingerprint: RESULT_B, observedAt: at(30) }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['key-reuse-outcome-undetermined'])
  assert.equal(report.status, 'incomplete', 'unknown is never a verdict either way')
  assert.match(
    findingsFor(report, 'key-reuse-outcome-undetermined')[0].message,
    /whether the second caller was refused or executed cannot be decided/,
  )
})

test('the same key and body reaching two different outcomes is a conflict', async () => {
  for (const [label, second] of [
    ['a different body in the response', { responseFingerprint: RESULT_B }],
    ['a different status', { responseStatus: 500 }],
  ]) {
    const report = await apiReport(fixture([operation()], [
      record({ id: 'cap-1', observedAt: at(0) }),
      record({ id: 'cap-2', observedAt: at(5), ...second }),
    ]))

    assert.deepEqual(raisedRules(report), ['duplicate-outcome-conflict'], label)
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.replays, 0)
    assert.equal(report.summary.conflicts, 1)
  }
})

test('the message names what actually differed', async () => {
  const report = await apiReport(fixture([operation()], [
    record({ id: 'cap-1', observedAt: at(0) }),
    record({ id: 'cap-2', observedAt: at(5), responseStatus: 500, responseFingerprint: RESULT_B }),
  ]))

  const message = findingsFor(report, 'duplicate-outcome-conflict')[0].message
  assert.match(message, /status 201 then 500/)
  assert.match(message, /a different response body/)
  assert.match(message, /within the declared expiry of 3600s/)
})

test('a reuse past the declared expiry is a fresh execution, not a broken replay', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { expiresAfterSeconds: 60, retryWindowSeconds: 60 } })],
    [
      record({ id: 'cap-1', observedAt: at(0) }),
      record({ id: 'cap-2', observedAt: at(120), responseFingerprint: RESULT_B }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['key-expired-between-attempts'])
  assert.equal(report.status, 'pass', 'the contract predicted this, so it is a warning and not a failure')
  assert.equal(report.summary.conflicts, 0)
  assert.match(findingsFor(report, 'key-expired-between-attempts')[0].message, /120s after the first attempt/)
})

test('a reuse exactly at the declared expiry is still inside the window', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { expiresAfterSeconds: 60, retryWindowSeconds: 60 } })],
    [
      record({ id: 'cap-1', observedAt: at(0) }),
      record({ id: 'cap-2', observedAt: at(60), responseFingerprint: RESULT_B }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['duplicate-outcome-conflict'], 'the boundary is exclusive, and the pair is still compared')
})

test('the first caller keeps the key entry: a later mismatch does not move the anchor', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { conflictStatus: undefined } })],
    [
      record({ id: 'cap-1', requestFingerprint: FIRST, responseFingerprint: RESULT_A, observedAt: at(0) }),
      record({ id: 'cap-2', requestFingerprint: SECOND, responseFingerprint: RESULT_A, observedAt: at(10) }),
      record({ id: 'cap-3', requestFingerprint: FIRST, responseFingerprint: RESULT_A, observedAt: at(20) }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['key-reused-different-payload'])
  assert.equal(findingsFor(report, 'key-reused-different-payload')[0].location.pointer, '/records/1')
  assert.equal(report.summary.replays, 1, 'cap-3 is judged against cap-1, which still owns the entry')
})

test('evidence the capture never obtained is unknown, in both directions', async () => {
  const cases = [
    ['responseFingerprint', 'outcome-evidence-missing'],
    ['requestFingerprint', 'payload-evidence-missing'],
  ]
  for (const [field, ruleId] of cases) {
    const report = await apiReport(fixture([operation()], [
      record({ id: 'cap-1', observedAt: at(0) }),
      record({ id: 'cap-2', observedAt: at(5), [field]: undefined }),
    ]))

    assert.deepEqual(raisedRules(report), [ruleId])
    assert.equal(report.status, 'incomplete', 'a comparison nobody could make is not a pass')
    assert.equal(report.summary.replays, 0)
    assert.equal(findingsFor(report, ruleId)[0].location.pointer, '/records/1')
  }
})

test('a record nothing was compared against is not asked for evidence it did not need', async () => {
  const report = await apiReport(fixture([operation()], [
    record({ id: 'cap-1', responseFingerprint: undefined }),
    record({ id: 'cap-2', key: 'idem-bbbb2222', requestFingerprint: undefined, observedAt: at(5) }),
  ]))

  assert.deepEqual(raisedRules(report), ['duplicate-never-observed'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.keys, 2, 'two singleton key entries, nothing to compare')
})

test('an operation whose boundary the capture never exercised says so', async () => {
  const report = await apiReport(fixture([operation()], [record({ id: 'cap-1' })]))

  assert.deepEqual(raisedRules(report), ['duplicate-never-observed'])
  assert.equal(report.status, 'pass')
  assert.match(
    findingsFor(report, 'duplicate-never-observed')[0].message,
    /does not exercise the boundary at all/,
  )
})

test('the declared scope decides whether two callers share a key entry', async () => {
  const records = [
    record({ id: 'cap-1', principal: 'acct_a', requestFingerprint: FIRST, responseFingerprint: RESULT_A, observedAt: at(0) }),
    record({ id: 'cap-2', principal: 'acct_b', requestFingerprint: SECOND, responseFingerprint: RESULT_A, observedAt: at(30) }),
  ]

  const perPrincipal = await apiReport(fixture(
    [operation({ idempotency: { scope: 'principal', conflictStatus: undefined } })],
    records,
  ))
  assert.deepEqual(raisedRules(perPrincipal), ['duplicate-never-observed', 'key-reused-across-principals'])
  assert.equal(perPrincipal.status, 'pass', 'per principal these are two separate key entries')
  assert.equal(perPrincipal.summary.keys, 2)
  assert.equal(
    findingsFor(perPrincipal, 'key-reused-across-principals')[0].evidence,
    'principals: acct_a, acct_b',
  )

  const global = await apiReport(fixture(
    [operation({ idempotency: { scope: 'global', conflictStatus: undefined } })],
    records,
  ))
  assert.deepEqual(raisedRules(global), ['key-reused-different-payload'])
  assert.equal(global.status, 'fail', 'globally these are one key entry, and the second caller got the first result')
  assert.equal(global.summary.keys, 1)
})

test('records are compared in observation order however the capture lists them', async () => {
  const forwards = await apiReport(fixture([operation()], [
    record({ id: 'cap-1', observedAt: at(0) }),
    record({ id: 'cap-2', observedAt: at(5), responseFingerprint: RESULT_B }),
  ]))
  const backwards = await apiReport(fixture([operation()], [
    record({ id: 'cap-2', observedAt: at(5), responseFingerprint: RESULT_B }),
    record({ id: 'cap-1', observedAt: at(0) }),
  ]))

  assert.equal(findingsFor(forwards, 'duplicate-outcome-conflict')[0].message.includes('"cap-2"'), true)
  assert.equal(findingsFor(backwards, 'duplicate-outcome-conflict')[0].message.includes('"cap-2"'), true)
  assert.match(findingsFor(backwards, 'duplicate-outcome-conflict')[0].message, /first attempt "cap-1"/)
})
