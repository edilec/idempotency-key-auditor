import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { auditIdempotency } from '../src/index.mjs'
import { cliRun, fixture, operation, projectDirectory, record, withRoot } from './support.mjs'

/**
 * The command-line surface, including the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * empty and a consumer piping stdout gets nothing rather than a fabricated
 * report. Evidence that could not be obtained means the run had a subject and
 * failed to learn something about it, which is what `incomplete` exists to
 * say -- and the consumer needs the report to know *which* input was not read.
 */

const CLEAN = fixture([operation()], [
  record({ id: 'cap-1' }),
  record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
])

const example = (name) => join(projectDirectory, 'examples', name)

test('--help explains the surface and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await cliRun([flag])

    assert.equal(result.code, 0)
    assert.match(result.stdout, /^idempotency-key-auditor/)
    assert.match(result.stdout, /--root DIR/)
    assert.match(result.stdout, /--max-records-per-key N/)
    assert.match(result.stdout, /Exit codes:/)
    assert.match(result.stdout, /never proof that an operation is idempotent/)
    assert.equal(result.stderr, '')
  }
})

test('--version prints the version and exits 0', async () => {
  for (const flag of ['--version', '-v']) {
    const result = await cliRun([flag])

    assert.equal(result.code, 0)
    assert.equal(result.stdout, '0.1.0\n')
  }
})

test('a configuration error leaves stdout empty', async () => {
  const cases = [
    [[], /--root is required/],
    [['--root'], /--root requires a value/],
    [['--root', '.', '--nope'], /Unknown option "--nope"/],
    [['--root', '.', '--max-records'], /--max-records requires a value/],
    [['--root', '.', '--max-records', 'many'], /--max-records requires a positive integer/],
    [['--root', '.', '--max-records', '0'], /--max-records requires a positive integer/],
    [['--root', '.', '--max-records', '9999999999'], /between 1 and/],
  ]
  for (const [args, message] of cases) {
    const result = await cliRun(args)

    assert.equal(result.code, 2, `${args.join(' ')} must exit 2`)
    assert.equal(result.stdout, '', `${args.join(' ')} must leave stdout empty`)
    assert.match(result.stderr, message)
  }
})

test('a value-carrying flag given twice is refused, not silently overwritten', async () => {
  for (const args of [
    ['--root', '.', '--root', '..'],
    ['--root', '.', '--capture', 'a.json', '--capture', 'b.json'],
    ['--root', '.', '--max-records', '5', '--max-records', '50'],
  ]) {
    const result = await cliRun(args)

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /was given more than once/)
  }
})

test('stdout carries the report and nothing else, in both modes', async () => {
  await withRoot(CLEAN, async (root) => {
    for (const args of [['--root', root], ['--root', root, '--json']]) {
      const result = await cliRun(args)

      assert.equal(result.code, 0)
      assert.equal(result.stdout.endsWith('}\n'), true)
      const report = JSON.parse(result.stdout)
      assert.equal(report.tool, 'idempotency-key-auditor')
      assert.equal(report.schemaVersion, '1')
      assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
    }
  })
})

test('--json suppresses the human summary, and without it the summary is on stderr', async () => {
  await withRoot(CLEAN, async (root) => {
    const quiet = await cliRun(['--root', root, '--json'])
    const loud = await cliRun(['--root', root])

    assert.equal(quiet.stderr, '')
    assert.match(loud.stderr, /^contract contract\.json: 1 operation\(s\), 1 with a declared idempotency boundary\.$/m)
    assert.match(loud.stderr, /2 of 2 record\(s\) evaluated/)
    assert.match(loud.stderr, /1 consistent replay\(s\)/)
    assert.equal(quiet.stdout, loud.stdout, 'the report itself does not change with the flag')
  })
})

test('--contract and --capture name the files, and appear in the report as given', async () => {
  await withRoot({ 'ops.json': CLEAN['contract.json'], 'seen.json': CLEAN['capture.json'] }, async (root) => {
    const result = await cliRun(['--root', root, '--contract', 'ops.json', '--capture', 'seen.json'])

    assert.equal(result.code, 0)
    assert.match(result.stderr, /contract ops\.json/)
    assert.match(result.stderr, /capture seen\.json/)
  })
})

test('the three example roots exit 0, 1 and 2', async () => {
  const clean = await cliRun(['--root', example('clean'), '--json'])
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const broken = await cliRun(['--root', example('broken'), '--json'])
  assert.equal(broken.code, 1)
  assert.equal(JSON.parse(broken.stdout).status, 'fail')

  const incomplete = await cliRun(['--root', example('incomplete'), '--json'])
  assert.equal(incomplete.code, 2)
  assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete')
})

test('the API refuses an unknown option key rather than ignoring it', async () => {
  await withRoot(CLEAN, async (root) => {
    await assert.rejects(() => auditIdempotency({ root, captures: 'capture.json' }), /Unknown option "captures"/)
    await assert.rejects(() => auditIdempotency({ root, limits: { maxRecrds: 1 } }), /Unknown limit "maxRecrds"/)
    await assert.rejects(() => auditIdempotency('not an object'), /options must be an object/)
    await assert.rejects(() => auditIdempotency({ contract: 'contract.json' }), /root must be a non-empty string/)
  })
})
