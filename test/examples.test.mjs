import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { auditIdempotency, exitCodeFor, isFingerprint } from '../src/index.mjs'
import { cliRun, findingsFor, projectDirectory, raisedRules } from './support.mjs'

/**
 * The shipped examples, which are the acceptance evidence for this tool:
 * the same key and body have one logical outcome, a reused key with a
 * different body is flagged, and the limits of static evidence are stated in
 * the report itself rather than only in the prose.
 *
 * `npm run example` runs the clean root, so this file is also what keeps that
 * script honest.
 */

const root = (name) => join(projectDirectory, 'examples', name)

test('the clean example passes, and shows one logical outcome per key and body', async () => {
  const report = await auditIdempotency({ root: root('clean') })

  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.checked, 8)
  assert.equal(report.summary.unevaluated, 0)
  assert.equal(report.summary.keys, 4)
  assert.equal(report.summary.replays, 3, 'three repeats of one key and body, all consistent')
  assert.equal(report.summary.conflicts, 0)
  assert.equal(report.summary.conflictsRefused, 1, 'and one reuse the declared conflict status refused')
  assert.deepEqual(raisedRules(report), ['key-conflict-detected', 'key-reused-across-principals'])
})

test('the broken example fails, and flags the key reused with a different body', async () => {
  const report = await auditIdempotency({ root: root('broken') })

  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(raisedRules(report), [
    'duplicate-outcome-conflict',
    'key-absent',
    'key-expired-between-attempts',
    'key-expiry-below-retry-window',
    'key-expiry-undeclared',
    'key-reused-different-payload',
    'operation-guard-missing',
    'payload-binding-disabled',
  ])
  assert.equal(report.summary.errors, 8)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.conflicts, 3)
  assert.equal(report.summary.replays, 0)

  const reused = findingsFor(report, 'key-reused-different-payload')
  assert.equal(reused.length, 2)
  assert.match(reused[0].message, /received that first caller's result verbatim/)
  assert.match(reused[1].message, /instead of the declared conflict status 409/)
})

test('the incomplete example is incomplete, and names each unknown it ran into', async () => {
  const report = await auditIdempotency({ root: root('incomplete') })

  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(raisedRules(report), [
    'capture-operation-unknown',
    'key-scope-undeclared',
    'outcome-evidence-missing',
  ])
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.unevaluated, 3)
  assert.equal(report.summary.records, 5)
})

test('every example is runnable through the binary at the exit code it documents', async () => {
  for (const [name, code, status] of [['clean', 0, 'pass'], ['broken', 1, 'fail'], ['incomplete', 2, 'incomplete']]) {
    const result = await cliRun(['--root', root(name), '--json'])

    assert.equal(result.code, code, `examples/${name} must exit ${code}`)
    assert.equal(JSON.parse(result.stdout).status, status)
  }
})

test('no example carries a body, a credential or a personal detail', async () => {
  for (const name of ['clean', 'broken', 'incomplete']) {
    const capture = JSON.parse(await readFile(join(root(name), 'capture.json'), 'utf8'))
    for (const record of capture.records) {
      for (const field of ['requestFingerprint', 'responseFingerprint']) {
        if (record[field] === undefined) continue
        assert.equal(isFingerprint(record[field]), true, `${name}/${record.id}.${field} must be a digest`)
        assert.match(record[field], /^sha256:[0-9a-f]{16}$/, 'and a plainly synthetic one')
      }
      assert.equal(/@|\+\d{6,}/.test(JSON.stringify(record)), false, `${name}/${record.id} must carry nothing that looks personal`)
    }
  }
})

test('the example script in package.json runs the clean root', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(manifest.scripts.example, 'node bin/idempotency-key-auditor.mjs --root examples/clean')
  assert.equal(manifest.scripts.check, 'npm run lint && npm test && npm run example && npm run pack:check')
})
