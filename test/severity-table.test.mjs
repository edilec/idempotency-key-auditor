import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, createFinding } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * The table against the documented catalog, in both directions.
 *
 * This is worth having and it is *not* the test that pins severity. A table,
 * a documented catalog and a hand-written expected map are three declarations
 * agreeing with each other, and a coordinated edit of all three passes every
 * assertion in this file. `test/severity-behaviour.test.mjs` drives real
 * inputs through the real binary and asserts the process exit code instead,
 * which no edit to a declaration can satisfy.
 *
 * What this file is for: catching a rule that exists in the code and nowhere
 * in the documentation, or the reverse.
 */

const CATALOG = join(projectDirectory, 'docs/idempotency-rules.md')
const ROW = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| /gm

async function documentedSeverities() {
  const text = await readFile(CATALOG, 'utf8')
  const documented = new Map()
  for (const match of text.matchAll(ROW)) {
    assert.equal(documented.has(match[1]), false, `${match[1]} is documented twice`)
    documented.set(match[1], match[2])
  }
  return documented
}

test('every rule in the table is documented, with the same severity', async () => {
  const documented = await documentedSeverities()
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(documented.get(ruleId), severity, `${ruleId} is ${severity} in the table`)
  }
})

test('every documented rule is in the table, with the same severity', async () => {
  const documented = await documentedSeverities()
  for (const [ruleId, severity] of documented) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `${ruleId} is documented as ${severity}`)
  }
  assert.equal(documented.size, Object.keys(RULE_SEVERITY).length)
  assert.equal(documented.size > 30, true, 'the catalog was actually parsed')
})

test('the table is the only source of severity, and an unknown rule throws', () => {
  const finding = createFinding({ ruleId: 'key-absent', file: 'capture.json', pointer: '/records/0', message: 'x' })
  assert.equal(finding.severity, RULE_SEVERITY['key-absent'])

  assert.throws(
    () => createFinding({ ruleId: 'not-a-rule', file: 'capture.json', pointer: '/', message: 'x' }),
    /is not in RULE_SEVERITY/,
  )
})

test('every severity in the table is one the report contract allows', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(['error', 'warning', 'info'].includes(severity), true, `${ruleId} has severity "${severity}"`)
  }
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
})

test('rule ids are stable kebab-case, as the report contract requires', () => {
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.match(ruleId, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${ruleId} is not a stable kebab-case id`)
  }
})
