import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditIdempotency, isInside } from '../src/index.mjs'
import { captureOf, cliRun, contractOf, findingsFor, operation, record } from './support.mjs'

/**
 * Path confinement, resolved on both sides.
 *
 * Rejecting `..` and absolute paths is a usage check, not confinement: a
 * symbolic link planted inside the root contains neither and points anywhere.
 * Equally, comparing a real root against an unresolved target refuses
 * legitimate files whenever the root is itself reached through a link -- a
 * `/var` that is really `/private/var` is enough -- and a false refusal is a
 * defect too. Both directions are pinned here.
 */

const MARKER = 'OUTSIDE_CONTENT_MARKER'
const pair = [record({ id: 'cap-1' }), record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' })]

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'idempotency-key-auditor-confine-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/file.json'), true)
  assert.equal(isInside('/a/root', '/a/rootsibling/file.json'), false)
  assert.equal(isInside('/a/root/', '/a/root/file.json'), true)
})

test('a symbolic link out of the root is refused, and its content never reaches the report', async () => {
  const report = await withBase(async (base) => {
    const root = join(base, 'inputs')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeJson(join(outside, 'secret.json'), { schemaVersion: '1', records: pair, note: MARKER })
    await writeJson(join(root, 'contract.json'), contractOf([operation()]))
    await symlink(join(outside, 'secret.json'), join(root, 'capture.json'))
    return auditIdempotency({ root })
  })

  assert.equal(findingsFor(report, 'path-escapes-root').length, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(JSON.stringify(report).includes(MARKER), false, 'out-of-root content must never be echoed')
  assert.equal(findingsFor(report, 'path-escapes-root')[0].location.file, 'capture.json')
})

test('a root reached through a symbolic link still reads its own files', async () => {
  // The false-refusal half. Resolving only one side would refuse every file
  // under this root, and a tool that refuses legitimate input is as broken as
  // one that reads what it should not.
  const report = await withBase(async (base) => {
    const real = join(base, 'real')
    await mkdir(real)
    await writeJson(join(real, 'contract.json'), contractOf([operation()]))
    await writeJson(join(real, 'capture.json'), captureOf(pair))
    await symlink(real, join(base, 'link'))
    return auditIdempotency({ root: join(base, 'link') })
  })

  assert.deepEqual(report.findings, [], 'a symlinked root is legitimate and must not be refused')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
})

test('a symbolic link that stays inside the root is followed', async () => {
  const report = await withBase(async (base) => {
    const root = join(base, 'inputs')
    await mkdir(root)
    await mkdir(join(root, 'nested'))
    await writeJson(join(root, 'contract.json'), contractOf([operation()]))
    await writeJson(join(root, 'nested', 'real-capture.json'), captureOf(pair))
    await symlink(join(root, 'nested', 'real-capture.json'), join(root, 'capture.json'))
    return auditIdempotency({ root })
  })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 2)
})

test('a name that steps outside the root is a configuration error, before any evidence', async () => {
  await withBase(async (base) => {
    const root = join(base, 'inputs')
    await mkdir(root)
    await writeJson(join(root, 'contract.json'), contractOf([operation()]))
    await writeJson(join(root, 'capture.json'), captureOf(pair))

    for (const name of ['../outside.json', '/etc/hosts', 'a/../../b.json']) {
      await assert.rejects(() => auditIdempotency({ root, capture: name }), /--capture/)
      const result = await cliRun(['--root', root, '--capture', name])
      assert.equal(result.code, 2)
      assert.equal(result.stdout, '', 'a configuration error never had a subject, so stdout stays empty')
    }
  })
})

test('a named input that is not there is evidence missing, not configuration', async () => {
  const result = await withBase(async (base) => {
    await writeJson(join(base, 'contract.json'), contractOf([operation()]))
    return cliRun(['--root', base, '--json'])
  })

  assert.equal(result.code, 2)
  assert.notEqual(result.stdout, '', 'the run had a subject and failed to obtain evidence about it')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'input-unreadable')[0].location.file, 'capture.json')
})

test('an entry that exists but resolves nowhere is refused unresolved', async () => {
  const report = await withBase(async (base) => {
    await writeJson(join(base, 'contract.json'), contractOf([operation()]))
    await symlink(join(base, 'nothing-here.json'), join(base, 'capture.json'))
    return auditIdempotency({ root: base })
  })

  assert.equal(findingsFor(report, 'input-unreadable').length, 1)
  assert.equal(report.status, 'incomplete')
})

test('a directory where a file was named is reported, not read', async () => {
  const report = await withBase(async (base) => {
    await writeJson(join(base, 'contract.json'), contractOf([operation()]))
    await mkdir(join(base, 'capture.json'))
    return auditIdempotency({ root: base })
  })

  assert.match(findingsFor(report, 'input-unreadable')[0].message, /not a regular file/)
  assert.equal(report.status, 'incomplete')
})

test('no finding ever carries an absolute host path', async () => {
  const report = await withBase(async (base) => {
    const root = join(base, 'inputs')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeJson(join(outside, 'secret.json'), captureOf(pair))
    await writeJson(join(root, 'contract.json'), contractOf([operation()]))
    await symlink(join(outside, 'secret.json'), join(root, 'capture.json'))
    return auditIdempotency({ root })
  })

  for (const finding of report.findings) {
    assert.equal(finding.location.file.startsWith('/'), false, `${finding.location.file} must be relative to the root`)
  }
  assert.equal(JSON.stringify(report).includes(tmpdir()), false)
})

test('a root that is not a directory is a configuration error', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'plain.txt'), 'x')
    await assert.rejects(() => auditIdempotency({ root: join(base, 'plain.txt') }), /--root must be a directory/)
    await assert.rejects(() => auditIdempotency({ root: join(base, 'absent') }), /--root could not be resolved/)
  })
})
