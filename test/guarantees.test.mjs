import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, fixture, operation, projectDirectory, record, withRoot } from './support.mjs'

/**
 * The claims the README and the docs make, each held by something that fails
 * when the claim stops being true.
 *
 * The source scans below are a secondary guard and are labelled as such: a
 * scan cannot tell a comparator from its replacement, which is why ordering is
 * pinned behaviourally in `test/ordering.test.mjs`. What a scan is good for is
 * catching a whole capability arriving -- a socket, a clock -- which has no
 * behavioural signature until the day it misbehaves.
 */

const CLEAN = fixture([operation()], [
  record({ id: 'cap-1' }),
  record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' }),
])

async function shippedSource() {
  const parts = []
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join('\n')
}

test('the shipped source opens no network connection of any kind', async () => {
  const source = await shippedSource()
  for (const name of [
    'node:net', 'node:http', 'node:https', 'node:http2', 'node:dns', 'node:tls',
    'node:dgram', 'fetch(', 'XMLHttpRequest', 'WebSocket',
  ]) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
})

test('the shipped source reads no clock, no random source and no environment', async () => {
  const source = await shippedSource()
  assert.equal(/\bnew\s+Date\b/.test(source), false, 'a wall clock in the output breaks byte-identical runs')
  assert.equal(/\bDate\.now\s*\(/.test(source), false)
  assert.equal(/\bMath\.random\s*\(/.test(source), false)
  assert.equal(/\bperformance\.now\s*\(/.test(source), false)
  assert.equal(/\bprocess\.env\b/.test(source), false)
  // `Date.UTC` is a pure conversion from validated components to an epoch
  // offset and is the one member of Date this package uses.
  assert.equal(source.includes('Date.UTC('), true)
})

test('the shipped source never reaches for a locale-aware comparison', async () => {
  // Secondary only. `Intl.Collator` drifts exactly as `localeCompare` does and
  // spells differently, so this scan cannot be the ordering test -- it is
  // `test/ordering.test.mjs` that pins the emitted order.
  const source = await shippedSource()
  assert.equal(source.includes('localeCompare'), false, 'localeCompare depends on ICU data that varies between Node builds')
  assert.equal(/\bIntl\b/.test(source), false, 'Intl.Collator drifts exactly as localeCompare does')
  assert.equal(/\btoLocale(?:Lower|Upper)Case\b/.test(source), false)
  assert.equal(/\bsort\s*\(\s*\)/.test(source), false, 'a bare sort() is code-unit ordering by accident, not by decision')
})

test('the shipped source writes nothing, and a run leaves its inputs untouched', async () => {
  const source = await shippedSource()
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm(', 'unlink', 'rename', 'createWriteStream']) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }

  await withRoot(CLEAN, async (root) => {
    const before = await snapshot(root)
    const result = await cliRun(['--root', root, '--json'])
    const after = await snapshot(root)

    assert.equal(result.code, 0)
    assert.deepEqual(after, before, 'a read-only tool must leave the root byte-identical')
  })
})

async function snapshot(root) {
  const entries = {}
  for (const name of (await readdir(root)).sort()) {
    entries[name] = await readFile(join(root, name), 'utf8')
  }
  return entries
}

test('the package ships with no dependencies at all', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(Object.hasOwn(manifest, 'dependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'peerDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'optionalDependencies'), false)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(manifest.version, '0.1.0')
})

test('the README states what the tool cannot conclude, and the docs agree', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  const docs = await readFile(join(projectDirectory, 'docs/idempotency-rules.md'), 'utf8')

  assert.match(readme, /## Limits and non-goals/)
  assert.match(readme, /cannot(?: prove| conclude)/i)
  assert.match(readme, /issues no request/i)
  assert.match(docs, /## What this tool can and cannot conclude/)
  assert.match(docs, /It cannot conclude that an operation is idempotent/)
})

test('the CHANGELOG says no release has been published', async () => {
  const changelog = await readFile(join(projectDirectory, 'CHANGELOG.md'), 'utf8')

  assert.equal(changelog.trimEnd().endsWith('No release has been published.'), true)
})

test('a pass is never reported on an unread input', async () => {
  // The invariant every scan above exists to protect, asserted directly: if a
  // run did not read an input, it does not get to say the capture was fine.
  await withRoot({ 'contract.json': CLEAN['contract.json'] }, async (root) => {
    const result = await cliRun(['--root', root, '--json'])
    const report = JSON.parse(result.stdout)

    assert.notEqual(report.status, 'pass')
    assert.equal(report.status, 'incomplete')
    assert.equal(result.code, 2)
    assert.equal(report.summary.checked, 0)
  })
})
