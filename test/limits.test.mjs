import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, validateLimits } from '../src/index.mjs'
import { apiReport, captureOf, cliReport, cliRun, contractOf, findingsFor, fixture, operation, projectDirectory, raisedRules, record } from './support.mjs'

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

test('the defaults and the hard caps are these exact numbers', () => {
  // Written out rather than derived. "a positive integer below its own cap" is
  // satisfied by any number at all, so it holds none of these: dropping
  // maxOperations from 500 to 3 passes that check while silently refusing every
  // contract with four operations in it.
  assert.deepEqual({ ...DEFAULT_LIMITS }, {
    maxFileBytes: 5242880,
    maxOperations: 500,
    maxRecords: 20000,
    maxRecordsPerKey: 500,
    maxFindings: 1000,
  })
  assert.deepEqual({ ...HARD_LIMITS }, {
    maxFileBytes: 67108864,
    maxOperations: 5000,
    maxRecords: 500000,
    maxRecordsPerKey: 50000,
    maxFindings: 20000,
  })
})

test('the documented defaults are the ones the help text and the rule document print', async () => {
  const help = await cliRun(['--help'])
  const docs = await readFile(join(projectDirectory, 'docs/idempotency-rules.md'), 'utf8')

  assert.equal(help.code, 0)
  for (const [flag, name, value, cap] of [
    ['--max-file-bytes', 'maxFileBytes', 5242880, 67108864],
    ['--max-operations', 'maxOperations', 500, 5000],
    ['--max-records', 'maxRecords', 20000, 500000],
    ['--max-records-per-key', 'maxRecordsPerKey', 500, 50000],
    ['--max-findings', 'maxFindings', 1000, 20000],
  ]) {
    assert.equal(help.stdout.includes(`${flag} `), true, `${flag} must appear in the help text`)
    assert.equal(help.stdout.includes(`(default ${value})`), true, `the help text must state the default ${value}`)
    assert.equal(docs.includes(`| \`${name}\` | ${value} | ${cap} | \`${flag}\` |`), true, `the rule document row for ${name}`)
  }
})

test('a contract well inside the default maxOperations compiles every operation', async () => {
  // The one default no other fixture crosses, driven end to end. A lowered
  // default turns this contract into `too-many-operations` and compiles none of
  // it, which is the silent truncation the limits exist to prevent.
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const operations = ids.map((id) => operation({ id, path: `/v1/${id}` }))
  const records = ids.flatMap((id) => [
    record({ id: `${id}-1`, operation: id, key: `idem-${id}0000000` }),
    record({ id: `${id}-2`, operation: id, key: `idem-${id}0000000`, observedAt: '2026-03-01T09:00:05Z' }),
  ])
  const report = await apiReport(fixture(operations, records))

  assert.deepEqual(report.findings, [], 'nothing was refused and nothing went unexercised')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.operations, 8)
  assert.equal(report.summary.checked, 16)
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
