import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { captureOf, cliRun, contractOf, findingsFor, operation, record, withRoot } from './support.mjs'

/**
 * A JSON parse failure must not carry the document into the report.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. The quoted
 * run is the first ten characters of the document, or the whole document when
 * it is shorter, so a file short enough to be nothing but a credential is
 * reproduced in full by its own error message. `input-not-json` interpolated
 * that message whole, which put the contents of an unparseable input on stdout
 * and in the human summary -- on the error path, which is exactly the path an
 * untrusted or malformed file takes.
 *
 * Sanitising does not fix it and neither does truncating: `excerpt` strips
 * control characters and cuts from the end, and the snippet sits at the front.
 *
 * The canary is `AKIAIOSFODNN7EXAMPLE`, the access key id AWS publishes in its
 * own documentation. It is not a credential; it is the shape of one, and it is
 * the shape a scanner watching this tool's output would flag. A capture file is
 * the likelier carrier of a real one: it holds recorded request material.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

const CONTRACT = contractOf([operation()])
const CAPTURE = captureOf([record()])

/** Run the real binary with the human summary left on, so both streams are checked. */
const run = (files) => withRoot(files, (root) => cliRun(['--root', root]))

/**
 * Assert the canary is absent from both streams, and so is every prefix of it
 * down to eight characters. The prefixes matter because V8 quotes only the
 * first ten characters once the document is long enough: a test looking for
 * the whole canary would pass against a message still leaking `AKIAIOSFOD`.
 */
function assertNoCanary(result, label) {
  for (let length = CANARY.length; length >= 8; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.equal(result.stdout.includes(prefix), false, `${label}: stdout carries ${prefix}`)
    assert.equal(result.stderr.includes(prefix), false, `${label}: stderr carries ${prefix}`)
  }
}

test('a capture that is nothing but a credential is not echoed by the parse failure', async () => {
  const result = await run({ 'contract.json': CONTRACT, 'capture.json': CANARY })
  const report = JSON.parse(result.stdout)

  const refused = findingsFor(report, 'input-not-json')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].location.file, 'capture.json')
  assertNoCanary(result, 'whole document')
})

test('the contract side is covered too, not only the capture side', async () => {
  const result = await run({ 'contract.json': CANARY, 'capture.json': CAPTURE })
  const report = JSON.parse(result.stdout)

  const refused = findingsFor(report, 'input-not-json')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].location.file, 'contract.json')
  assertNoCanary(result, 'contract')
})

test('a credential inside a longer document is not echoed either', async () => {
  const result = await run({
    'contract.json': CONTRACT,
    'capture.json': `{"schemaVersion": "1", "records": ${CANARY}}`,
  })

  assert.equal(findingsFor(JSON.parse(result.stdout), 'input-not-json').length, 1)
  assertNoCanary(result, 'embedded in a document')
})

test('the position, line and column survive -- a parse error that says nothing is a different defect', async () => {
  const result = await run({
    'contract.json': CONTRACT,
    'capture.json': '{"schemaVersion": "1" "records": []}',
  })

  const refused = findingsFor(JSON.parse(result.stdout), 'input-not-json')
  assert.equal(refused.length, 1)
  assert.match(refused[0].message, /at position \d+ \(line \d+ column \d+\)/)
})

test('parseFailureDetail keeps the offset and drops the quoted document', () => {
  const detailFor = (text) => {
    try {
      JSON.parse(text)
    } catch (error) {
      return parseFailureDetail(error)
    }
    throw new Error('the fixture parsed, so it pins nothing')
  }

  assert.equal(detailFor(CANARY), "unexpected token 'A' at the start of the document")
  assert.equal(detailFor('ssn 123-45-6789'), "unexpected token 's' at the start of the document")
  assert.equal(detailFor('password=hunter2-correct-horse'), "unexpected token 'p' at the start of the document")
  assert.equal(detailFor(`{"a": 1, "b": ${CANARY}}`), "unexpected token 'A' inside the document")
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
  assert.equal(detailFor('{"a": 1 "b": 2}'), "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)")
  assert.equal(detailFor('{"a": 1} trailing'), 'Unexpected non-whitespace character after JSON at position 9 (line 1 column 10)')
})

test('parseFailureDetail refuses a wording it was not taught rather than guessing', () => {
  assert.equal(
    parseFailureDetail(new Error('Unexpected token \'A\', "AKIAIOSFODNN7EXAMPLE" is not valid JSON at position 0')),
    'the document could not be parsed as JSON',
    'a double quote surviving to the end means the snippet survived with it',
  )
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})
