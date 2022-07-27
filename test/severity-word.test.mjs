import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Severity, for the rules whose exit code cannot show it.
 *
 * Twenty-seven of the error rules also mark the run incomplete, so they exit 2
 * whether their severity says `error` or `warning`. For those the exit code is
 * not the assertion -- the count of errors in the summary and the severity word
 * printed in the human report are.
 *
 * This file deliberately shares nothing with the rest of the suite. It imports
 * no table, reads no catalog, and takes no expectation from a map or a loop
 * variable: every rule id, every pointer, every count and every printed line is
 * written out inline, at the place it is asserted. That is the whole point. A
 * table, a documented catalog and a test's expected map are three declarations,
 * and one edit that changes all three leaves every assertion that compares them
 * satisfied -- including an assertion made inside a loop over that same map.
 * Nothing below can be satisfied by editing a declaration.
 *
 * The builders are inputs, not expectations: they construct the contract and
 * capture documents a case feeds in, and carry no severity, no rule id and no
 * count.
 */

const execFileAsync = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../bin/idempotency-key-auditor.mjs')

/** Build a root, run the real binary over it with the human report on, tear the root down. */
async function audit(files, extraArgs = []) {
  const root = await mkdtemp(join(tmpdir(), 'idempotency-key-auditor-word-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await spawn(['--root', root, ...extraArgs])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function spawn(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args])
    return { code: 0, report: JSON.parse(stdout), stderr }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr ?? '' }
  }
}

// Inputs only. Nothing here decides what a case expects.
const guarded = (overrides = {}) => ({
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
  ...overrides,
})

const call = (overrides = {}) => ({
  id: 'cap-1',
  operation: 'create-payment',
  key: 'idem-aaaa1111',
  requestFingerprint: 'sha256:1111111111111111',
  responseStatus: 201,
  responseFingerprint: 'sha256:2222222222222222',
  observedAt: '2026-03-01T09:00:00Z',
  ...overrides,
})

const CONTRACT = { schemaVersion: '1', operations: [guarded()] }
const PAIR = {
  schemaVersion: '1',
  records: [call({ id: 'cap-1' }), call({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' })],
}

test('capture-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': { schemaVersion: '1', records: {} },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records capture-invalid'), true)
})

test('capture-key-unknown prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': { schemaVersion: '1', recrods: [] },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/recrods capture-key-unknown'), true)
})

test('contract-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': { schemaVersion: '1', operations: {} },
    'capture.json': PAIR,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   contract.json/operations contract-invalid'), true)
})

test('contract-key-unknown prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': { schemaVersion: '1', operatons: [] },
    'capture.json': PAIR,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   contract.json/operatons contract-key-unknown'), true)
})

test('identifier-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': {
      schemaVersion: '1',
      records: [
        call({ id: 'cap-1' }),
        call({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
        call({ id: '', observedAt: '2026-03-01T09:00:09Z' }),
      ],
    },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records/2/id identifier-invalid'), true)
})

test('input-not-json prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': 'records: none\n',
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json input-not-json'), true)
})

test('input-not-utf8 prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json input-not-utf8'), true)
})

test('input-too-large prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': `${JSON.stringify(PAIR)}${' '.repeat(2000)}`,
  }, ['--max-file-bytes', '1000'])

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json input-too-large'), true)
})

test('input-unreadable prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({ 'contract.json': CONTRACT })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json input-unreadable'), true)
})

test('no-operations prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': { schemaVersion: '1', operations: [] },
    'capture.json': PAIR,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   contract.json/operations no-operations'), true)
})

test('operation-duplicate prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': { schemaVersion: '1', operations: [guarded(), guarded({ path: '/v1/other' })] },
    'capture.json': PAIR,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   contract.json/operations/1/id operation-duplicate'), true)
})

test('operation-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': {
      schemaVersion: '1',
      operations: [guarded(), guarded({ id: 'queue-export', path: '/v1/exports', method: 'TRACE' })],
    },
    'capture.json': PAIR,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   contract.json/operations/1/method operation-invalid'), true)
})

test('path-escapes-root prints ERROR and counts as one error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'idempotency-key-auditor-word-escape-'))
  try {
    const root = join(base, 'inputs')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.json'), `${JSON.stringify(PAIR)}\n`)
    await writeFile(join(root, 'contract.json'), `${JSON.stringify(CONTRACT)}\n`)
    await symlink(join(outside, 'secret.json'), join(root, 'capture.json'))

    const { code, report, stderr } = await spawn(['--root', root])

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(stderr.includes('ERROR   capture.json path-escapes-root'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('payload-evidence-missing prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': {
      schemaVersion: '1',
      records: [
        call({ id: 'cap-1' }),
        call({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z', requestFingerprint: undefined }),
      ],
    },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records/1 payload-evidence-missing'), true)
})

test('record-duplicate prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': {
      schemaVersion: '1',
      records: [call({ id: 'cap-1' }), call({ id: 'cap-1', observedAt: '2026-03-01T09:00:05Z' })],
    },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records/1/id record-duplicate'), true)
})

test('record-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': {
      schemaVersion: '1',
      records: [
        call({ id: 'cap-1' }),
        call({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
        call({ id: 'cap-3', observedAt: '2026-03-01T09:00:09Z', responseStatus: 'ok' }),
      ],
    },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records/2/responseStatus record-invalid'), true)
})

test('record-principal-missing prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': {
      schemaVersion: '1',
      operations: [{
        id: 'create-payment',
        method: 'POST',
        path: '/v1/payments',
        idempotency: {
          keySource: 'header:Idempotency-Key',
          scope: 'principal',
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
        call({ id: 'cap-1', principal: 'acct_a' }),
        call({ id: 'cap-2', principal: 'acct_a', observedAt: '2026-03-01T09:00:05Z' }),
        call({ id: 'cap-3', observedAt: '2026-03-01T09:00:09Z' }),
      ],
    },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records/2 record-principal-missing'), true)
})

test('timestamp-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': {
      schemaVersion: '1',
      records: [
        call({ id: 'cap-1' }),
        call({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
        call({ id: 'cap-3', observedAt: '2026-02-31T00:00:00Z' }),
      ],
    },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records/2/observedAt timestamp-invalid'), true)
})

test('too-many-findings prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': {
      schemaVersion: '1',
      operations: [{
        id: 'create-payment',
        method: 'POST',
        path: '/v1/payments',
        idempotency: { scope: 'global', expiresAfterSeconds: 3600, retryWindowSeconds: 900, conflictStatus: 409 },
      }],
    },
    'capture.json': PAIR,
  }, ['--max-findings', '1'])

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json too-many-findings'), true)
})

test('too-many-operations prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': {
      schemaVersion: '1',
      operations: [guarded(), guarded({ id: 'queue-export', path: '/v1/exports' })],
    },
    'capture.json': PAIR,
  }, ['--max-operations', '1'])

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   contract.json/operations too-many-operations'), true)
})

test('too-many-records prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': PAIR,
  }, ['--max-records', '1'])

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records too-many-records'), true)
})

test('too-many-records-for-key prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'contract.json': CONTRACT,
    'capture.json': {
      schemaVersion: '1',
      records: [
        call({ id: 'cap-1' }),
        call({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
        call({ id: 'cap-3', observedAt: '2026-03-01T09:00:09Z' }),
      ],
    },
  }, ['--max-records-per-key', '2'])

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   capture.json/records/2 too-many-records-for-key'), true)
})
