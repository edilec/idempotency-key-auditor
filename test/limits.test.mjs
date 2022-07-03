import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, validateLimits } from '../src/index.mjs'
import { apiReport, captureOf, cliReport, contractOf, findingsFor, fixture, operation, raisedRules, record } from './support.mjs'

/**
 * Every documented limit, enforced and reported by name.
 *
 * A limit that is documented and never wired is the defect this catalog has
 * already shipped once: the key was accepted, the bound was never applied, and
 * the report claimed a complete run over input nobody had walked. So each of
 * these drives a real input past the bound and asserts both the finding and
 * that the work beyond the bound did not happen.
 */

const pair = [record({ id: 'cap-1' }), record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' })]

test('every default limit has a hard cap, and the two agree in both directions', () => {
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), Object.keys(HARD_LIMITS).sort())
  for (const [key, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.equal(Number.isInteger(value) && value >= 1, true, `${key} must be a positive integer`)
    assert.equal(value <= HARD_LIMITS[key], true, `${key} must not default above its own cap`)
  }
})

test('an unknown limit is refused, never ignored', () => {
  assert.throws(() => validateLimits({ maxRecrds: 5 }), /Unknown limit "maxRecrds"/)
  assert.throws(() => validateLimits({ maxRecords: 0 }), /between 1 and/)
  assert.throws(() => validateLimits({ maxRecords: 1.5 }), /between 1 and/)
  assert.throws(() => validateLimits({ maxRecords: HARD_LIMITS.maxRecords + 1 }), /between 1 and/)
  assert.throws(() => validateLimits([]), /must be an object/)
  assert.equal(validateLimits({ maxRecords: 7 }).maxRecords, 7)
})

test('a file above maxFileBytes is not read', async () => {
  const padded = `${JSON.stringify(contractOf([operation()]))}${' '.repeat(400)}`
  const report = await apiReport(
    { 'contract.json': padded, 'capture.json': captureOf(pair) },
    { limits: { maxFileBytes: 64 } },
  )

  assert.equal(report.findings.some((finding) => finding.ruleId === 'input-too-large'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.operations, 0, 'the file was not read, so nothing was compiled from it')
  assert.match(findingsFor(report, 'input-too-large')[0].message, /the maxFileBytes limit of 64/)
})

test('a contract above maxOperations compiles none of them', async () => {
  const operations = [operation({ id: 'a' }), operation({ id: 'b' }), operation({ id: 'c' })]
  const report = await apiReport(fixture(operations, pair), { limits: { maxOperations: 2 } })

  assert.deepEqual(raisedRules(report), ['too-many-operations'], 'the bound is the whole of what went wrong; nothing else is guessed at')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.operations, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.unevaluated, 2, 'with no contract compiled, no record could be audited against anything')
})

test('a capture above maxRecords compiles none of them', async () => {
  const report = await apiReport(fixture([operation()], pair), { limits: { maxRecords: 1 } })

  assert.deepEqual(raisedRules(report), ['too-many-records'], 'the bound is the whole of what went wrong; nothing else is guessed at')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.records, 2)
  assert.equal(report.summary.unevaluated, 2, 'the summary states the gap rather than claiming an empty capture')
})

test('a key entry above maxRecordsPerKey stops the walk, and the rest is not judged', async () => {
  const report = await apiReport(fixture([operation()], [
    record({ id: 'cap-1', observedAt: '2026-03-01T09:00:00Z' }),
    record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
    record({ id: 'cap-3', observedAt: '2026-03-01T09:00:09Z', responseFingerprint: 'sha256:bbbbbbbbbbbbbbbb' }),
  ]), { limits: { maxRecordsPerKey: 2 } })

  assert.deepEqual(raisedRules(report), ['too-many-records-for-key'], 'cap-3 would otherwise be a duplicate-outcome-conflict')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.unevaluated, 1)
  const finding = findingsFor(report, 'too-many-records-for-key')[0]
  assert.equal(finding.location.pointer, '/records/2', 'the finding names the first record the walk did not reach')
  assert.match(finding.message, /the maxRecordsPerKey limit of 2/)
})

test('a report above maxFindings is partial, and says so', async () => {
  const operations = ['a', 'b', 'c'].map((id) => operation({ id, idempotency: { payloadBinding: undefined } }))
  const records = ['a', 'b', 'c'].flatMap((id) => [
    record({ id: `${id}-1`, operation: id, key: `idem-${id}0000000` }),
    record({ id: `${id}-2`, operation: id, key: `idem-${id}0000000`, observedAt: '2026-03-01T09:00:05Z' }),
  ])
  const report = await apiReport(fixture(operations, records), { limits: { maxFindings: 2 } })

  assert.equal(report.findings.length, 2)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'too-many-findings'), true)
  assert.equal(report.status, 'incomplete', 'a truncated report is not a verdict on what it truncated')
  assert.match(findingsFor(report, 'too-many-findings')[0].message, /2 were not reported/)
})

test('the limit flags on the command line reach the run that enforces them', async () => {
  const files = fixture([operation()], pair)

  const unbounded = await cliReport(files)
  assert.equal(unbounded.code, 0)
  assert.deepEqual(unbounded.report.findings, [])

  const bounded = await cliReport(files, ['--max-records', '1'])
  assert.deepEqual(raisedRules(bounded.report), ['too-many-records'])
  assert.equal(bounded.code, 2)

  const perKey = await cliReport(files, ['--max-records-per-key', '1'])
  assert.equal(perKey.report.findings.some((finding) => finding.ruleId === 'too-many-records-for-key'), true)
  assert.equal(perKey.code, 2)
})
