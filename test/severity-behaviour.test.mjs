import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'
import { captureOf, cliRun, contractOf, fixture, operation, raisedRules, record, withRoot } from './support.mjs'

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog. That is worth having and it is not this: a table, a catalog and a
 * hand-written expected map are three declarations agreeing with each other,
 * and a coordinated edit of all three passes every one of those assertions. A
 * rule quietly demoted from `error` to `warning` would reach exit 0 with the
 * whole suite green.
 *
 * These tests assert the consequence instead. Each case builds a root that
 * isolates one rule, runs the real binary, and pins the rules raised, the
 * report status and the process exit code. A demotion changes the observable
 * outcome -- `fail` becomes `pass`, exit 1 becomes exit 0 -- and no edit to a
 * declaration can satisfy an exit code.
 */

const PAIR = [record({ id: 'cap-1' }), record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' })]

/** Build the root, run the real binary over it, and report what happened. */
async function audit(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { code: result.code, report: JSON.parse(result.stdout), stderr: result.stderr }
  })
}

/**
 * Every error rule whose severity alone decides the verdict.
 *
 * The rest of the error rules are backstopped by the `incomplete` flag, so
 * they exit 2 whatever their severity says. Those are listed at the bottom of
 * this file and pinned separately, with literal expectations.
 */
const FAILING = [
  {
    ruleId: 'operation-guard-missing',
    raised: ['operation-guard-missing'],
    files: fixture([operation({ idempotency: null })], [record({ key: undefined })]),
  },
  {
    ruleId: 'key-source-undeclared',
    raised: ['key-source-undeclared'],
    files: fixture([operation({ idempotency: { keySource: undefined } })], PAIR),
  },
  {
    ruleId: 'key-expiry-undeclared',
    raised: ['key-expiry-undeclared'],
    files: fixture([operation({ idempotency: { expiresAfterSeconds: undefined } })], PAIR),
  },
  {
    ruleId: 'key-expiry-below-retry-window',
    raised: ['key-expiry-below-retry-window'],
    files: fixture([operation({ idempotency: { expiresAfterSeconds: 300, retryWindowSeconds: 900 } })], PAIR),
  },
  {
    ruleId: 'payload-binding-undeclared',
    raised: ['payload-binding-undeclared'],
    files: fixture([operation({ idempotency: { payloadBinding: undefined } })], PAIR),
  },
  {
    ruleId: 'payload-binding-disabled',
    raised: ['payload-binding-disabled'],
    files: fixture([operation({ idempotency: { payloadBinding: 'none' } })], PAIR),
  },
  {
    ruleId: 'key-absent',
    raised: ['duplicate-never-observed', 'key-absent'],
    files: fixture([operation()], [record({ key: undefined })]),
  },
  {
    // The headline rule: the second caller silently received the first
    // caller's result. Demoting this to a warning is the exact defect this
    // whole tool exists to catch.
    ruleId: 'key-reused-different-payload',
    raised: ['key-reused-different-payload'],
    files: fixture([operation()], [
      record({ id: 'cap-1', requestFingerprint: 'sha256:1111111111111111' }),
      record({ id: 'cap-2', requestFingerprint: 'sha256:aaaaaaaaaaaaaaaa', responseStatus: 201, observedAt: '2026-03-01T09:00:30Z' }),
    ]),
  },
  {
    ruleId: 'duplicate-outcome-conflict',
    raised: ['duplicate-outcome-conflict'],
    files: fixture([operation()], [
      record({ id: 'cap-1' }),
      record({ id: 'cap-2', responseFingerprint: 'sha256:bbbbbbbbbbbbbbbb', observedAt: '2026-03-01T09:00:05Z' }),
    ]),
  },
]

for (const item of FAILING) {
  test(`${item.ruleId} fails the run and exits 1, whatever a table says`, async () => {
    const { code, report } = await audit(item.files)

    assert.deepEqual(raisedRules(report), [...item.raised].sort(), 'the fixture must isolate the rule under test')
    assert.equal(report.status, 'fail', `${item.ruleId} must fail the run`)
    assert.equal(code, 1, `${item.ruleId} must exit 1`)
    assert.equal(report.summary.errors > 0, true)
    assert.equal(RULE_SEVERITY[item.ruleId], 'error', 'and the table must still say so')
  })
}

/**
 * The other direction, which a severity table usually forgets: a rule below
 * error must not fail the run either. Promoting one of these turns a capture
 * that merely did not exercise a boundary into a broken build, and a table
 * agreeing with a copy of itself would never show it.
 */
const PASSING = [
  {
    ruleId: 'operation-guard-method-implied',
    raised: ['operation-guard-method-implied'],
    files: fixture([operation({ method: 'PUT', idempotency: null })], [record({ key: undefined })]),
  },
  {
    ruleId: 'operation-not-captured',
    raised: ['operation-not-captured'],
    files: fixture([operation(), operation({ id: 'refund-payment', path: '/v1/refunds' })], PAIR),
  },
  {
    ruleId: 'key-expired-between-attempts',
    raised: ['key-expired-between-attempts'],
    files: fixture([operation({ idempotency: { expiresAfterSeconds: 60, retryWindowSeconds: 60 } })], [
      record({ id: 'cap-1', observedAt: '2026-03-01T09:00:00Z' }),
      record({ id: 'cap-2', observedAt: '2026-03-01T09:02:00Z', responseFingerprint: 'sha256:bbbbbbbbbbbbbbbb' }),
    ]),
  },
  {
    ruleId: 'operation-guard-on-safe-method',
    raised: ['operation-guard-on-safe-method'],
    files: fixture([operation({ method: 'GET' })], PAIR),
  },
  {
    ruleId: 'key-conflict-detected',
    raised: ['key-conflict-detected'],
    files: fixture([operation()], [
      record({ id: 'cap-1', requestFingerprint: 'sha256:1111111111111111' }),
      record({ id: 'cap-2', requestFingerprint: 'sha256:aaaaaaaaaaaaaaaa', responseStatus: 409, responseFingerprint: 'sha256:bbbbbbbbbbbbbbbb', observedAt: '2026-03-01T09:00:30Z' }),
    ]),
  },
  {
    ruleId: 'key-reused-across-principals',
    raised: ['duplicate-never-observed', 'key-reused-across-principals'],
    files: fixture([operation({ idempotency: { scope: 'principal' } })], [
      record({ id: 'cap-1', principal: 'acct_a' }),
      record({ id: 'cap-2', principal: 'acct_b', observedAt: '2026-03-01T09:00:30Z' }),
    ]),
  },
  {
    ruleId: 'duplicate-never-observed',
    raised: ['duplicate-never-observed'],
    files: fixture([operation()], [record({ id: 'cap-1' })]),
  },
]

for (const item of PASSING) {
  test(`${item.ruleId} is reported without failing the run, and exits 0`, async () => {
    const { code, report } = await audit(item.files)

    assert.deepEqual(raisedRules(report), [...item.raised].sort(), 'the fixture must isolate the rule under test')
    assert.equal(report.findings.some((finding) => finding.ruleId === item.ruleId), true)
    assert.equal(report.status, 'pass', `${item.ruleId} must not fail the run`)
    assert.equal(code, 0, `${item.ruleId} must exit 0`)
    assert.equal(report.summary.errors, 0)
    assert.notEqual(RULE_SEVERITY[item.ruleId], 'error', 'and the table must still say so')
  })
}

test('the clean fixture every failing case is cut from raises nothing at all', async () => {
  const { code, report } = await audit(fixture([operation()], PAIR))

  assert.deepEqual(report.findings, [], 'otherwise every case above is measuring the wrong thing')
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.replays, 1)
})

test('every rule that decides the verdict by severity alone is pinned above', () => {
  // The error rules this file does not drive through the binary are backstopped
  // by the incomplete flag: they exit 2 whatever their severity says, and each
  // is pinned in `test/incomplete.test.mjs` by status, exit code and count. A
  // new error rule that nobody pins has to be added to one list or the other,
  // deliberately.
  const backstopped = [
    'capture-invalid', 'capture-key-unknown', 'capture-operation-unknown',
    'contract-invalid', 'contract-key-unknown', 'identifier-invalid',
    'input-not-json', 'input-not-utf8', 'input-too-large', 'input-unreadable',
    'key-reuse-outcome-undetermined', 'key-scope-undeclared', 'no-operations',
    'no-records-evaluated', 'operation-duplicate', 'operation-invalid',
    'outcome-evidence-missing', 'path-escapes-root', 'payload-evidence-missing',
    'record-duplicate', 'record-invalid', 'record-principal-missing',
    'timestamp-invalid', 'too-many-findings', 'too-many-operations',
    'too-many-records', 'too-many-records-for-key',
  ]
  const errors = Object.entries(RULE_SEVERITY)
    .filter(([, severity]) => severity === 'error')
    .map(([ruleId]) => ruleId)
    .sort()

  assert.deepEqual(errors, [...FAILING.map((item) => item.ruleId), ...backstopped].sort())
})

test('every rule below error is pinned above too', () => {
  const lenient = Object.entries(RULE_SEVERITY)
    .filter(([, severity]) => severity !== 'error')
    .map(([ruleId]) => ruleId)
    .sort()

  assert.deepEqual(lenient, PASSING.map((item) => item.ruleId).sort())
})

/**
 * The rules where severity and the `incomplete` flag both point at exit 2.
 *
 * For these the exit code cannot tell a demotion apart from the flag, so the
 * severity word that reaches the human report is asserted directly, with
 * literal inline expectations. Nothing in this test reads a map, a table or a
 * fixture helper's expectations: every string below is written out.
 */
test('key-scope-undeclared prints ERROR and counts as one error, at exit 2', async () => {
  await withRoot({
    'contract.json': {
      schemaVersion: '1',
      operations: [{
        id: 'create-payment',
        method: 'POST',
        path: '/v1/payments',
        idempotency: {
          keySource: 'header:Idempotency-Key',
          expiresAfterSeconds: 3600,
          retryWindowSeconds: 900,
          payloadBinding: 'request-body-fingerprint',
          conflictStatus: 409,
        },
      }, {
        id: 'queue-export',
        method: 'POST',
        path: '/v1/exports',
        idempotency: {
          keySource: 'header:Idempotency-Key',
          scope: 'global',
          expiresAfterSeconds: 3600,
          retryWindowSeconds: 900,
          payloadBinding: 'request-body-fingerprint',
          conflictStatus: 409,
        },
      }],
    },
    'capture.json': {
      schemaVersion: '1',
      records: [{
        id: 'cap-1',
        operation: 'create-payment',
        key: 'idem-aaaa1111',
        requestFingerprint: 'sha256:1111111111111111',
        responseStatus: 201,
        responseFingerprint: 'sha256:2222222222222222',
        observedAt: '2026-03-01T09:00:00Z',
      }, {
        id: 'cap-2',
        operation: 'queue-export',
        key: 'idem-bbbb2222',
        requestFingerprint: 'sha256:3333333333333333',
        responseStatus: 202,
        responseFingerprint: 'sha256:4444444444444444',
        observedAt: '2026-03-01T09:01:00Z',
      }, {
        id: 'cap-3',
        operation: 'queue-export',
        key: 'idem-bbbb2222',
        requestFingerprint: 'sha256:3333333333333333',
        responseStatus: 202,
        responseFingerprint: 'sha256:4444444444444444',
        observedAt: '2026-03-01T09:01:05Z',
      }],
    },
  }, async (root) => {
    const result = await cliRun(['--root', root])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.checked, 2)
    assert.equal(report.summary.unevaluated, 1)
    assert.equal(
      result.stderr.includes('ERROR   contract.json/operations/0/idempotency/scope key-scope-undeclared'),
      true,
      'the severity word itself must be ERROR in the human report',
    )
  })
})

test('outcome-evidence-missing prints ERROR and counts as one error, at exit 2', async () => {
  await withRoot({
    'contract.json': {
      schemaVersion: '1',
      operations: [{
        id: 'queue-export',
        method: 'POST',
        path: '/v1/exports',
        idempotency: {
          keySource: 'header:Idempotency-Key',
          scope: 'global',
          expiresAfterSeconds: 3600,
          retryWindowSeconds: 900,
          payloadBinding: 'request-body-fingerprint',
          conflictStatus: 409,
        },
      }],
    },
    'capture.json': {
      schemaVersion: '1',
      records: [
        {
          id: 'cap-1',
          operation: 'queue-export',
          key: 'idem-aaaa1111',
          requestFingerprint: 'sha256:1111111111111111',
          responseStatus: 202,
          responseFingerprint: 'sha256:2222222222222222',
          observedAt: '2026-03-01T09:00:00Z',
        },
        {
          id: 'cap-2',
          operation: 'queue-export',
          key: 'idem-aaaa1111',
          requestFingerprint: 'sha256:1111111111111111',
          responseStatus: 202,
          observedAt: '2026-03-01T09:00:05Z',
        },
      ],
    },
  }, async (root) => {
    const result = await cliRun(['--root', root])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.replays, 0, 'a comparison nobody could make is not a replay')
    assert.equal(
      result.stderr.includes('ERROR   capture.json/records/1 outcome-evidence-missing'),
      true,
      'the severity word itself must be ERROR in the human report',
    )
  })
})

test('key-reuse-outcome-undetermined prints ERROR and counts as one error, at exit 2', async () => {
  await withRoot({
    'contract.json': {
      schemaVersion: '1',
      operations: [{
        id: 'issue-refund',
        method: 'POST',
        path: '/v1/refunds',
        idempotency: {
          keySource: 'header:Idempotency-Key',
          scope: 'global',
          expiresAfterSeconds: 3600,
          retryWindowSeconds: 900,
          payloadBinding: 'request-body-fingerprint',
        },
      }],
    },
    'capture.json': {
      schemaVersion: '1',
      records: [
        {
          id: 'cap-1',
          operation: 'issue-refund',
          key: 'idem-aaaa1111',
          requestFingerprint: 'sha256:1111111111111111',
          responseStatus: 201,
          responseFingerprint: 'sha256:2222222222222222',
          observedAt: '2026-03-01T09:00:00Z',
        },
        {
          id: 'cap-2',
          operation: 'issue-refund',
          key: 'idem-aaaa1111',
          requestFingerprint: 'sha256:aaaaaaaaaaaaaaaa',
          responseStatus: 201,
          responseFingerprint: 'sha256:bbbbbbbbbbbbbbbb',
          observedAt: '2026-03-01T09:00:30Z',
        },
      ],
    },
  }, async (root) => {
    const result = await cliRun(['--root', root])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.conflicts, 1)
    assert.equal(
      result.stderr.includes('ERROR   capture.json/records/1 key-reuse-outcome-undetermined'),
      true,
      'the severity word itself must be ERROR in the human report',
    )
  })
})

test('capture-operation-unknown prints ERROR and counts as one error, at exit 2', async () => {
  await withRoot({
    'contract.json': {
      schemaVersion: '1',
      operations: [{
        id: 'create-payment',
        method: 'POST',
        path: '/v1/payments',
        idempotency: {
          keySource: 'header:Idempotency-Key',
          scope: 'global',
          expiresAfterSeconds: 3600,
          retryWindowSeconds: 900,
          payloadBinding: 'request-body-fingerprint',
          conflictStatus: 409,
        },
      }],
    },
    'capture.json': {
      schemaVersion: '1',
      records: [
        {
          id: 'cap-1',
          operation: 'create-payment',
          key: 'idem-aaaa1111',
          requestFingerprint: 'sha256:1111111111111111',
          responseStatus: 201,
          responseFingerprint: 'sha256:2222222222222222',
          observedAt: '2026-03-01T09:00:00Z',
        },
        {
          id: 'cap-2',
          operation: 'create-payment',
          key: 'idem-aaaa1111',
          requestFingerprint: 'sha256:1111111111111111',
          responseStatus: 201,
          responseFingerprint: 'sha256:2222222222222222',
          observedAt: '2026-03-01T09:00:05Z',
        },
        {
          id: 'cap-3',
          operation: 'delete-account',
          key: 'idem-bbbb2222',
          requestFingerprint: 'sha256:3333333333333333',
          responseStatus: 204,
          responseFingerprint: 'sha256:4444444444444444',
          observedAt: '2026-03-01T09:01:00Z',
        },
      ],
    },
  }, async (root) => {
    const result = await cliRun(['--root', root])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(report.summary.checked, 2)
    assert.equal(report.summary.unevaluated, 1)
    assert.equal(
      result.stderr.includes('ERROR   capture.json/records/2 capture-operation-unknown'),
      true,
      'the severity word itself must be ERROR in the human report',
    )
  })
})

test('no-records-evaluated prints ERROR and counts as one error, at exit 2', async () => {
  await withRoot({
    'contract.json': contractOf([operation()]),
    'capture.json': captureOf([]),
  }, async (root) => {
    const result = await cliRun(['--root', root])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 1, 'the uncaptured operation is the warning')
    assert.equal(report.summary.checked, 0)
    assert.equal(
      result.stderr.includes('ERROR   capture.json/records no-records-evaluated'),
      true,
      'the severity word itself must be ERROR in the human report',
    )
  })
})
