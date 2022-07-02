import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, findingsFor, fixture, operation, raisedRules, record } from './support.mjs'

/**
 * The contract half of the audit: what an operation's declaration does not
 * say. None of these can be settled by a capture -- a capture that happens to
 * contain no reuse says nothing about whether the key is scoped, when it
 * expires, or whether the payload is bound.
 */

/** Two captured calls of the same key and body with the same outcome: one consistent replay. */
const consistentPair = [
  record({ id: 'cap-1' }),
  record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
]

test('a fully declared operation with a consistent replay raises nothing at all', async () => {
  const report = await apiReport(fixture([operation()], consistentPair))

  assert.deepEqual(report.findings, [], 'otherwise every case below is measuring the wrong thing')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.replays, 1)
})

test('POST with no declared boundary is reported, and PATCH too', async () => {
  for (const method of ['POST', 'PATCH']) {
    const report = await apiReport(fixture(
      [operation({ method, idempotency: null })],
      [record({ key: undefined })],
    ))

    assert.deepEqual(raisedRules(report), ['operation-guard-missing'])
    assert.equal(report.status, 'fail')
    assert.match(findingsFor(report, 'operation-guard-missing')[0].message, /retried request runs the operation again/)
  }
})

test('PUT and DELETE with no declared boundary are reported as a warning, not an error', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const report = await apiReport(fixture(
      [operation({ method, idempotency: null })],
      [record({ key: undefined })],
    ))

    assert.deepEqual(raisedRules(report), ['operation-guard-method-implied'])
    assert.equal(report.status, 'pass', 'HTTP method semantics are a statement of intent, not a defect')
    assert.match(
      findingsFor(report, 'operation-guard-method-implied')[0].message,
      /statement about intent and not a guarantee/,
    )
  }
})

test('a safe method carrying an idempotency boundary is worth saying out loud', async () => {
  const report = await apiReport(fixture(
    [operation({ method: 'GET' })],
    consistentPair,
  ))

  assert.deepEqual(raisedRules(report), ['operation-guard-on-safe-method'])
  assert.equal(report.status, 'pass')
})

test('each missing part of the declaration has its own rule', async () => {
  const cases = [
    ['keySource', 'key-source-undeclared'],
    ['expiresAfterSeconds', 'key-expiry-undeclared'],
    ['payloadBinding', 'payload-binding-undeclared'],
  ]
  for (const [field, ruleId] of cases) {
    const report = await apiReport(fixture(
      [operation({ idempotency: { [field]: undefined } })],
      consistentPair,
    ))

    assert.deepEqual(raisedRules(report), [ruleId], `${field} must be reported as ${ruleId} and nothing else`)
    assert.equal(report.status, 'fail')
    assert.equal(report.findings[0].location.pointer, `/operations/0/idempotency/${field}`)
  }
})

test('an undeclared scope stops the operation being audited at all', async () => {
  // Two operations, so the run still evaluates something and the finding is
  // not tangled up with the empty-evidence guard.
  const report = await apiReport(fixture(
    [operation({ id: 'unscoped', idempotency: { scope: undefined } }), operation({ id: 'sound' })],
    [
      record({ id: 'cap-1', operation: 'unscoped' }),
      record({ id: 'cap-2', operation: 'unscoped', observedAt: '2026-03-01T09:00:05Z' }),
      record({ id: 'cap-3', operation: 'sound' }),
      record({ id: 'cap-4', operation: 'sound', observedAt: '2026-03-01T09:00:05Z' }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['key-scope-undeclared'])
  assert.equal(report.summary.checked, 2, 'only the soundly declared operation was audited')
  assert.equal(report.summary.unevaluated, 2)
  assert.equal(report.status, 'incomplete', 'records nobody could group are not a verdict either way')
  assert.match(findingsFor(report, 'key-scope-undeclared')[0].message, /were not evaluated/)
})

test('an expiry shorter than the declared retry window is a second execution waiting to happen', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { expiresAfterSeconds: 300, retryWindowSeconds: 900 } })],
    consistentPair,
  ))

  assert.deepEqual(raisedRules(report), ['key-expiry-below-retry-window'])
  assert.equal(report.status, 'fail')
  assert.match(findingsFor(report, 'key-expiry-below-retry-window')[0].message, /300s but declares a retry window of 900s/)
})

test('an expiry equal to the retry window is accepted', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { expiresAfterSeconds: 900, retryWindowSeconds: 900 } })],
    consistentPair,
  ))

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('payloadBinding "none" says the key is not bound to the body, and is reported as such', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { payloadBinding: 'none' } })],
    consistentPair,
  ))

  assert.deepEqual(raisedRules(report), ['payload-binding-disabled'])
  assert.equal(report.status, 'fail')
  assert.match(findingsFor(report, 'payload-binding-disabled')[0].message, /returns the first caller's result/)
})

test('an unknown key is refused at every level, never ignored', async () => {
  const cases = [
    [{ 'contract.json': { schemaVersion: '1', operations: [operation()], oprations: [] }, 'capture.json': { schemaVersion: '1', records: consistentPair } }, '/oprations'],
    [fixture([{ ...operation(), pathh: '/v1/x' }], consistentPair), '/operations/0/pathh'],
    [fixture([operation({ idempotency: { payloadBindng: 'request-body-fingerprint' } })], consistentPair), '/operations/0/idempotency/payloadBindng'],
  ]
  for (const [files, pointer] of cases) {
    const report = await apiReport(files)

    assert.equal(report.findings.some((finding) => finding.ruleId === 'contract-key-unknown'), true)
    assert.equal(findingsFor(report, 'contract-key-unknown')[0].location.pointer, pointer)
    assert.equal(report.status, 'incomplete', 'a typo must not turn a real failure green')
  }
})

test('a duplicated operation id is refused rather than silently resolved', async () => {
  const report = await apiReport(fixture(
    [operation(), operation({ path: '/v1/other' })],
    consistentPair,
  ))

  assert.equal(report.findings.some((finding) => finding.ruleId === 'operation-duplicate'), true)
  assert.equal(report.status, 'incomplete')
})

test('the contract shape itself is checked before anything is read from it', async () => {
  const cases = [
    [[], 'contract.json', { schemaVersion: '1' }, 'contract-invalid'],
    [[], 'contract.json', { schemaVersion: '2', operations: [operation()] }, 'contract-invalid'],
    [[], 'contract.json', { schemaVersion: '1', operations: {} }, 'contract-invalid'],
    [[], 'contract.json', [], 'contract-invalid'],
    [[], 'contract.json', { schemaVersion: '1', operations: [] }, 'no-operations'],
  ]
  for (const [, name, document, ruleId] of cases) {
    const report = await apiReport({ [name]: document, 'capture.json': { schemaVersion: '1', records: consistentPair } })

    assert.equal(report.findings.some((finding) => finding.ruleId === ruleId), true, `${JSON.stringify(document).slice(0, 60)} must raise ${ruleId}`)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
  }
})

test('a malformed operation entry is refused with the field named', async () => {
  const cases = [
    [{ ...operation(), id: '' }, 'identifier-invalid', '/operations/0/id'],
    [{ ...operation(), method: 'post' }, 'operation-invalid', '/operations/0/method'],
    [{ ...operation(), method: 'TRACE' }, 'operation-invalid', '/operations/0/method'],
    [{ ...operation(), path: '' }, 'operation-invalid', '/operations/0/path'],
    [{ ...operation(), idempotency: [] }, 'operation-invalid', '/operations/0/idempotency'],
    [operation({ idempotency: { scope: 'tenant' } }), 'operation-invalid', '/operations/0/idempotency/scope'],
    [operation({ idempotency: { payloadBinding: 'yes' } }), 'operation-invalid', '/operations/0/idempotency/payloadBinding'],
    [operation({ idempotency: { keySource: 'Idempotency-Key' } }), 'operation-invalid', '/operations/0/idempotency/keySource'],
    [operation({ idempotency: { expiresAfterSeconds: 0 } }), 'operation-invalid', '/operations/0/idempotency/expiresAfterSeconds'],
    [operation({ idempotency: { expiresAfterSeconds: 1.5 } }), 'operation-invalid', '/operations/0/idempotency/expiresAfterSeconds'],
    [operation({ idempotency: { retryWindowSeconds: 31622401 } }), 'operation-invalid', '/operations/0/idempotency/retryWindowSeconds'],
    [operation({ idempotency: { conflictStatus: 99 } }), 'operation-invalid', '/operations/0/idempotency/conflictStatus'],
    ['not an object', 'operation-invalid', '/operations/0'],
  ]
  for (const [entry, ruleId, pointer] of cases) {
    const report = await apiReport(fixture([entry], consistentPair))

    const matching = findingsFor(report, ruleId).filter((finding) => finding.location.pointer === pointer)
    assert.equal(matching.length, 1, `${pointer} must raise exactly one ${ruleId}`)
    assert.equal(report.status, 'incomplete')
  }
})
