import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { captureOf, cliRun, contractOf, fixture, operation, record, withRoot } from './support.mjs'

/**
 * Every place this tool decides a run is `incomplete`, pinned by the outcome.
 *
 * An `incomplete = true` that nothing tests is the defect this catalog has
 * already shipped: deleting one let an entirely unread input report a pass,
 * with the full suite still green. Each case below drives a real input through
 * the real binary and asserts the status *and* the process exit code, so
 * removing the flag at that site turns `incomplete` into `fail` and exit 2
 * into exit 1 -- an observable change no edit to a declaration can hide.
 *
 * The positive control at the top proves the assertion can come out the other
 * way, which is what stops this file being a set of assertions that cannot
 * fail.
 */

const CLEAN = fixture([operation()], [
  record({ id: 'cap-1' }),
  record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
])

/** A second operation that is audited soundly, so a case can isolate one skip. */
const SOUND_OPERATION = operation({ id: 'queue-export', path: '/v1/exports' })
const SOUND_RECORDS = [
  record({ id: 'sound-1', operation: 'queue-export', key: 'idem-cccc3333' }),
  record({ id: 'sound-2', operation: 'queue-export', key: 'idem-cccc3333', observedAt: '2026-03-01T09:00:05Z' }),
]

async function audit(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { code: result.code, report: JSON.parse(result.stdout) }
  })
}

test('a run that obtained all its evidence is not incomplete, and exits 0', async () => {
  const { code, report } = await audit(CLEAN)

  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.unevaluated, 0)
})

const CASES = [
  {
    site: 'an input that is not there',
    ruleId: 'input-unreadable',
    files: { 'contract.json': contractOf([operation()]) },
  },
  {
    site: 'an input that is not UTF-8',
    ruleId: 'input-not-utf8',
    files: {
      'contract.json': contractOf([operation()]),
      'capture.json': new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    },
  },
  {
    site: 'an input that is not JSON',
    ruleId: 'input-not-json',
    files: { 'contract.json': contractOf([operation()]), 'capture.json': 'records: none\n' },
  },
  {
    site: 'an input above maxFileBytes',
    ruleId: 'input-too-large',
    files: CLEAN,
    args: ['--max-file-bytes', '32'],
  },
  {
    site: 'a contract that could not be compiled at all',
    ruleId: 'no-operations',
    files: fixture([], CLEAN['capture.json'].records),
  },
  {
    site: 'a contract only part of which compiled',
    ruleId: 'operation-duplicate',
    files: fixture([operation(), operation({ path: '/v1/other' })], CLEAN['capture.json'].records),
  },
  {
    site: 'a capture that could not be compiled at all',
    ruleId: 'capture-invalid',
    files: { 'contract.json': contractOf([operation()]), 'capture.json': { schemaVersion: '1', records: {} } },
  },
  {
    site: 'a capture only part of which compiled',
    ruleId: 'record-invalid',
    files: fixture([operation()], [...CLEAN['capture.json'].records, { ...record({ id: 'cap-3' }), responseStatus: 'ok' }]),
  },
  {
    site: 'a record naming an operation the contract does not declare',
    ruleId: 'capture-operation-unknown',
    files: fixture([operation()], [...CLEAN['capture.json'].records, record({ id: 'cap-3', operation: 'delete-account' })]),
  },
  {
    site: 'an operation whose key scope is undeclared',
    ruleId: 'key-scope-undeclared',
    files: fixture(
      [operation({ idempotency: { scope: undefined } }), SOUND_OPERATION],
      [...CLEAN['capture.json'].records, ...SOUND_RECORDS],
    ),
  },
  {
    site: 'a per-principal key recorded with no principal',
    ruleId: 'record-principal-missing',
    files: fixture(
      [operation({ idempotency: { scope: 'principal' } }), SOUND_OPERATION],
      [record({ id: 'cap-1', principal: undefined }), ...SOUND_RECORDS],
    ),
  },
  {
    site: 'a compared record with no request fingerprint',
    ruleId: 'payload-evidence-missing',
    files: fixture([operation()], [
      record({ id: 'cap-1' }),
      record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z', requestFingerprint: undefined }),
    ]),
  },
  {
    site: 'a compared record with no response fingerprint',
    ruleId: 'outcome-evidence-missing',
    files: fixture([operation()], [
      record({ id: 'cap-1' }),
      record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z', responseFingerprint: undefined }),
    ]),
  },
  {
    site: 'a reuse with a different body whose outcome evidence is missing',
    ruleId: 'outcome-evidence-missing',
    files: fixture([operation({ idempotency: { conflictStatus: undefined } })], [
      record({ id: 'cap-1' }),
      record({
        id: 'cap-2',
        observedAt: '2026-03-01T09:00:05Z',
        requestFingerprint: 'sha256:aaaaaaaaaaaaaaaa',
        responseFingerprint: undefined,
      }),
    ]),
  },
  {
    site: 'a reuse with a different body and no declared conflict status',
    ruleId: 'key-reuse-outcome-undetermined',
    files: fixture([operation({ idempotency: { conflictStatus: undefined } })], [
      record({ id: 'cap-1' }),
      record({
        id: 'cap-2',
        observedAt: '2026-03-01T09:00:05Z',
        requestFingerprint: 'sha256:aaaaaaaaaaaaaaaa',
        responseFingerprint: 'sha256:bbbbbbbbbbbbbbbb',
      }),
    ]),
  },
  {
    site: 'a key entry above maxRecordsPerKey',
    ruleId: 'too-many-records-for-key',
    files: fixture([operation()], [
      ...CLEAN['capture.json'].records,
      record({ id: 'cap-3', observedAt: '2026-03-01T09:00:09Z' }),
    ]),
    args: ['--max-records-per-key', '2'],
  },
  {
    site: 'a capture above maxRecords',
    ruleId: 'too-many-records',
    files: CLEAN,
    args: ['--max-records', '1'],
  },
  {
    site: 'a contract above maxOperations',
    ruleId: 'too-many-operations',
    files: fixture([operation(), SOUND_OPERATION], CLEAN['capture.json'].records),
    args: ['--max-operations', '1'],
  },
  {
    site: 'a report above maxFindings',
    ruleId: 'too-many-findings',
    files: fixture(
      [operation({ idempotency: { payloadBinding: undefined, keySource: undefined } })],
      CLEAN['capture.json'].records,
    ),
    args: ['--max-findings', '1'],
  },
  {
    site: 'a run that evaluated no record at all',
    ruleId: 'no-records-evaluated',
    files: { 'contract.json': contractOf([operation()]), 'capture.json': captureOf([]) },
  },
]

for (const item of CASES) {
  test(`${item.site} makes the run incomplete, and exits 2`, async () => {
    const { code, report } = await audit(item.files, item.args ?? [])

    assert.equal(
      report.findings.some((finding) => finding.ruleId === item.ruleId),
      true,
      `${item.site} must raise ${item.ruleId}`,
    )
    assert.equal(report.status, 'incomplete', `${item.site} must not report a verdict it did not reach`)
    assert.equal(code, 2, `${item.site} must exit 2`)
    assert.notEqual(report.status, 'pass')
  })
}

test('an input refused for leaving the root makes the run incomplete, and exits 2', async () => {
  const base = await mkdtemp(join(tmpdir(), 'idempotency-key-auditor-escape-'))
  try {
    const root = join(base, 'inputs')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.json'), `${JSON.stringify(CLEAN['capture.json'])}\n`)
    await writeFile(join(root, 'contract.json'), `${JSON.stringify(CLEAN['contract.json'])}\n`)
    await symlink(join(outside, 'secret.json'), join(root, 'capture.json'))

    const result = await cliRun(['--root', root, '--json'])
    const report = JSON.parse(result.stdout)

    assert.equal(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'), true)
    assert.equal(report.status, 'incomplete')
    assert.equal(result.code, 2)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('every incomplete run says on stderr how much of the capture it managed to evaluate', async () => {
  await withRoot({ 'contract.json': contractOf([operation()]), 'capture.json': captureOf([]) }, async (root) => {
    const result = await cliRun(['--root', root, '--json'])

    assert.equal(result.code, 2)
    assert.match(result.stderr, /^incomplete: 0 of 0 captured record\(s\) were evaluated; this run is not a pass\.$/m)
  })
})
