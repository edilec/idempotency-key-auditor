import assert from 'node:assert/strict'
import test from 'node:test'

import { formatReport, hasForbiddenCharacter } from '../src/index.mjs'
import { FORBIDDEN, apiReport, captureOf, cliRun, contractOf, fixture, operation, record, withRoot } from './support.mjs'

/**
 * Sanitisation, tested by class and by route.
 *
 * Stripping C0 and the line and paragraph separators is not sanitising. The C1
 * range does the same damage unaided -- U+0085 NEL is a line break to a great
 * many consumers and U+009B is the 8-bit CSI -- and U+202E reverses everything
 * printed after it, so a key can be displayed as something other than the
 * value that was grouped.
 *
 * So every class below is driven through four different routes into the
 * report, including one where the character arrives inside an *identifier*
 * rather than an excerpt: a sibling tool sanitised its evidence field with
 * care and let a page id containing a newline forge whole lines.
 */

const HEADER_LINES = 3

/** Every string anywhere in the report, however deeply nested. */
function everyString(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) everyString(item, found)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.push(key)
      everyString(item, found)
    }
  }
  return found
}

/**
 * Assert the whole report is clean, and that the human rendering gained no
 * line. The line count is the part a forged newline cannot survive: one
 * un-sanitised field prints an extra row that no finding accounts for.
 */
function assertClean(report, label) {
  for (const value of everyString(report)) {
    assert.equal(hasForbiddenCharacter(value), false, `${label}: ${JSON.stringify(value).slice(0, 80)} carried a forbidden character`)
  }
  const lines = formatReport(report).trimEnd().split('\n')
  assert.equal(lines.length, HEADER_LINES + report.findings.length, `${label}: the human report gained or lost a line`)
}

const pair = [record({ id: 'cap-1' }), record({ id: 'cap-2', observedAt: '2026-03-01T09:00:05Z' })]

test('a forbidden character arriving through an identifier never reaches output', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(fixture([operation()], [record({ id: `cap${character}1` })]))

    assert.equal(report.findings.some((finding) => finding.ruleId === 'identifier-invalid'), true, `${name} must be refused inside a record id`)
    assert.equal(report.status, 'incomplete')
    assertClean(report, `record id carrying ${name}`)
  }
})

test('a forbidden character arriving through an object key never reaches output', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    // A JSON key may hold any character at all, and it reaches both the
    // message and the pointer without passing through JSON.stringify first.
    const report = await apiReport({
      'contract.json': { schemaVersion: '1', operations: [{ ...operation(), [`extra${character}key`]: 1 }] },
      'capture.json': captureOf(pair),
    })

    assert.equal(report.findings.some((finding) => finding.ruleId === 'contract-key-unknown'), true, `${name} must be reported`)
    assertClean(report, `unknown key carrying ${name}`)
  }
})

test('a forbidden character arriving through a free-text field never reaches output', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    // `path` is prose, not an identifier: it is accepted and then sanitised on
    // its way into the evidence of the guard findings.
    const report = await apiReport(fixture(
      [operation({ method: 'POST', path: `/v1/cha${character}rges`, idempotency: null })],
      [record({ key: undefined })],
    ))

    const finding = report.findings.find((item) => item.ruleId === 'operation-guard-missing')
    assert.notEqual(finding, undefined, `${name}: the guard finding must still be raised`)
    assert.equal(finding.evidence.includes(character), false, `${name} must not survive into evidence`)
    assertClean(report, `operation path carrying ${name}`)
  }
})

test('a forbidden character in an unknown command-line option cannot forge a line on stderr', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    // NUL is excluded on this route alone: an argument vector is NUL-
    // terminated at the kernel boundary, so the character cannot reach argv at
    // all. Every other class can, and every other class is driven through.
    if (name === 'C0 NUL') continue
    const result = await cliRun(['--root', '.', `--unknown${character}flag`])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(hasForbiddenCharacter(result.stderr.split('\n')[0]), false, `${name} must not survive into the diagnostic`)
    assert.match(result.stderr, /^Unknown option "--unknown ?flag"$/m, `${name} must be flattened into one line`)
  }
})

test('U+202E cannot make a reported key print as something other than what was grouped', async () => {
  const override = FORBIDDEN['bidi RLO']
  const report = await apiReport(fixture([operation()], [record({ key: `idem-${override}1234` })]))

  assert.equal(report.findings.some((finding) => finding.ruleId === 'identifier-invalid'), true)
  assert.equal(JSON.stringify(report).includes(override), false)
  assertClean(report, 'key carrying U+202E')
})

test('the serialised report carries no raw separator or C1 byte at all', async () => {
  const nel = FORBIDDEN['C1 NEL']
  const separator = FORBIDDEN['line separator']
  const report = await apiReport({
    'contract.json': { schemaVersion: '1', operations: [{ ...operation(), [`k${nel}${separator}`]: 1 }] },
    'capture.json': captureOf(pair),
  })

  const serialised = JSON.stringify(report, null, 2)
  // JSON.stringify escapes C0 but leaves U+0085 and U+2028 literal, so an
  // unsanitised field would put real bytes here, not escape text.
  assert.equal(serialised.includes(nel), false)
  assert.equal(serialised.includes(separator), false)
})

test('a file name is checked as configuration before it can reach the report', async () => {
  await withRoot({ 'contract.json': contractOf([operation()]), 'capture.json': captureOf(pair) }, async (root) => {
    const result = await cliRun(['--root', root, '--capture', `capture${FORBIDDEN['C0 LF']}.json`])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error never had a subject')
    assert.match(result.stderr, /must not contain a control, separator or bidi character/)
  })
})
