import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, captureOf, findingsFor, fixture, operation, raisedRules, record } from './support.mjs'

/**
 * The capture half: records that describe calls that already happened. A
 * record that cannot be read is not evidence, so it is never counted as
 * checked and the run that contains one is never a pass.
 */

const pair = [record({ id: 'cap-1' }), record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' })]

test('a malformed record is refused with the field named', async () => {
  const cases = [
    [{ ...record(), id: 42 }, 'identifier-invalid', '/records/0/id'],
    [{ ...record(), operation: '' }, 'identifier-invalid', '/records/0/operation'],
    [{ ...record(), key: ' padded ' }, 'identifier-invalid', '/records/0/key'],
    [{ ...record(), principal: 'x'.repeat(201) }, 'identifier-invalid', '/records/0/principal'],
    [{ ...record(), requestFingerprint: 'short' }, 'record-invalid', '/records/0/requestFingerprint'],
    [{ ...record(), responseFingerprint: '{"amount":1200}' }, 'record-invalid', '/records/0/responseFingerprint'],
    [{ ...record(), responseStatus: '201' }, 'record-invalid', '/records/0/responseStatus'],
    [{ ...record(), responseStatus: 600 }, 'record-invalid', '/records/0/responseStatus'],
    [{ ...record(), observedAt: '2026-02-31T00:00:00Z' }, 'timestamp-invalid', '/records/0/observedAt'],
    [{ ...record(), observedAt: '2026-03-01T09:00:00+01:00' }, 'timestamp-invalid', '/records/0/observedAt'],
    [{ ...record(), obsrvedAt: '2026-03-01T09:00:00Z' }, 'capture-key-unknown', '/records/0/obsrvedAt'],
    ['not an object', 'record-invalid', '/records/0'],
  ]
  for (const [entry, ruleId, pointer] of cases) {
    const report = await apiReport(fixture([operation()], [entry]))

    const matching = findingsFor(report, ruleId).filter((finding) => finding.location.pointer === pointer)
    assert.equal(matching.length, 1, `${pointer} must raise exactly one ${ruleId}`)
    assert.equal(report.status, 'incomplete', 'a record nobody could read is not a verdict either way')
    assert.equal(report.summary.checked, 0)
    assert.equal(report.summary.unevaluated, 1)
  }
})

test('a duplicated record id is refused rather than silently resolved', async () => {
  const report = await apiReport(fixture([operation()], [record({ id: 'cap-1' }), record({ id: 'cap-1' })]))

  assert.equal(report.findings.some((finding) => finding.ruleId === 'record-duplicate'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unevaluated, 1)
})

test('the capture shape itself is checked before anything is read from it', async () => {
  const cases = [
    [{ schemaVersion: '1' }, 'capture-invalid'],
    [{ schemaVersion: '2', records: [] }, 'capture-invalid'],
    [{ schemaVersion: '1', records: {} }, 'capture-invalid'],
    [{ schemaVersion: '1', records: [], recrds: [] }, 'capture-key-unknown'],
    [[], 'capture-invalid'],
  ]
  for (const [document, ruleId] of cases) {
    const report = await apiReport({ 'contract.json': { schemaVersion: '1', operations: [operation()] }, 'capture.json': document })

    assert.equal(report.findings.some((finding) => finding.ruleId === ruleId), true)
    assert.equal(report.status, 'incomplete')
  }
})

test('a record naming an operation the contract does not declare is not evaluated', async () => {
  const report = await apiReport(fixture(
    [operation()],
    [...pair, record({ id: 'cap-3', operation: 'delete-account' })],
  ))

  assert.deepEqual(raisedRules(report), ['capture-operation-unknown'])
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.status, 'incomplete')
})

test('a guarded operation reached with no key at all is a definite failure, not an unknown', async () => {
  const report = await apiReport(fixture([operation()], [record({ key: undefined })]))

  assert.deepEqual(raisedRules(report), ['duplicate-never-observed', 'key-absent'])
  assert.equal(report.status, 'fail', 'the call demonstrably carried no key; nothing about it is unknown')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.unevaluated, 0)
  assert.match(findingsFor(report, 'key-absent')[0].suggestion, /header:Idempotency-Key/)
})

test('a per-principal key with no principal recorded cannot be grouped, so it is not evaluated', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { scope: 'principal' } })],
    [record({ principal: undefined })],
  ))

  assert.equal(report.findings.some((finding) => finding.ruleId === 'record-principal-missing'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.unevaluated, 1)
})

test('a global-scope key needs no principal', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { scope: 'global' } })],
    pair.map((entry) => ({ ...entry, principal: undefined })),
  ))

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.replays, 1)
})

test('an operation with no captured record at all is reported, since nothing confirmed it', async () => {
  const report = await apiReport(fixture(
    [operation(), operation({ id: 'refund-payment', path: '/v1/refunds' })],
    pair,
  ))

  assert.deepEqual(raisedRules(report), ['operation-not-captured'])
  assert.equal(report.status, 'pass', 'an uncaptured operation is a gap in the evidence, not a defect in the contract')
  assert.equal(findingsFor(report, 'operation-not-captured')[0].location.pointer, '/operations/1')
})

test('an empty capture is refused rather than passing on no evidence', async () => {
  const report = await apiReport({
    'contract.json': { schemaVersion: '1', operations: [operation()] },
    'capture.json': captureOf([]),
  })

  assert.equal(report.findings.some((finding) => finding.ruleId === 'no-records-evaluated'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
})
