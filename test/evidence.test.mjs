import assert from 'node:assert/strict'
import test from 'node:test'

import { describeValue } from '../src/index.mjs'
import { FORBIDDEN, captureOf, cliRun, contractOf, findingsFor, operation, record, withRoot } from './support.mjs'

/**
 * What a refused value is allowed to put on stdout.
 *
 * The fingerprint alphabet exists so that a capture cannot carry a payload, a
 * credential or a personal detail into the report under the name of a digest.
 * Honouring the alphabet and then echoing the refused value verbatim defeats
 * the point of having one: the value lands on stdout, which is the stream a
 * consumer pipes somewhere more public than the capture ever was.
 *
 * So a value this tool refused is never reproduced. Its shape is described,
 * its location is named by the pointer -- precise enough to find it in the
 * file -- and its content stays in the file it arrived in.
 *
 * Every secret below is a fake with a distinctive shape. The assertion is that
 * none of them appears on either stream, not that one particular field was
 * cleaned: a test that checks the field somebody remembered is a test the next
 * field passes for free.
 */

const CARD = '4111111111111111'
const CVV = '737'
const EMAIL = 'ada.lovelace@example.invalid'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const PASSWORD = 'password=hunter2-correct-horse'

const SECRETS = [CARD, CVV, EMAIL, JWT, AWS_KEY, PASSWORD]

/** Run the real binary and hand back both streams, unparsed. */
async function streams(files) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

function assertNothingLeaked(result, label) {
  for (const secret of SECRETS) {
    assert.equal(result.stdout.includes(secret), false, `${label}: ${secret.slice(0, 12)} reached stdout`)
    assert.equal(result.stderr.includes(secret), false, `${label}: ${secret.slice(0, 12)} reached stderr`)
  }
}

test('a refused record field is described, never reproduced', async () => {
  const result = await streams({
    'contract.json': contractOf([operation()]),
    'capture.json': captureOf([
      { ...record({ id: 'cap-1' }), requestFingerprint: `${CARD} ${CVV} ${EMAIL}` },
    ]),
  })

  assertNothingLeaked(result, 'requestFingerprint')
  const finding = findingsFor(result.report, 'record-invalid')[0]
  assert.equal(finding.location.pointer, '/records/0/requestFingerprint', 'the pointer is how the value is found')
  assert.equal(finding.evidence, 'received a string of 49 character(s)')
  assert.equal(result.code, 2)
})

test('every refused field in a capture describes its value and reproduces none of it', async () => {
  const cases = [
    ['id', { id: JWT.repeat(4) }, '/records/0/id', 'identifier-invalid'],
    ['operation', { operation: `${EMAIL}${FORBIDDEN['C0 NUL']}` }, '/records/0/operation', 'identifier-invalid'],
    ['key', { key: `${PASSWORD}${FORBIDDEN['bidi RLO']}` }, '/records/0/key', 'identifier-invalid'],
    ['principal', { principal: ` ${AWS_KEY} ` }, '/records/0/principal', 'identifier-invalid'],
    ['responseFingerprint', { responseFingerprint: EMAIL }, '/records/0/responseFingerprint', 'record-invalid'],
    ['responseStatus', { responseStatus: Number(CARD) }, '/records/0/responseStatus', 'record-invalid'],
    ['observedAt', { observedAt: JWT }, '/records/0/observedAt', 'timestamp-invalid'],
  ]

  for (const [label, override, pointer, ruleId] of cases) {
    const result = await streams({
      'contract.json': contractOf([operation()]),
      'capture.json': captureOf([{ ...record({ id: 'cap-1' }), ...override }]),
    })

    assertNothingLeaked(result, label)
    const finding = findingsFor(result.report, ruleId).find((item) => item.location.pointer === pointer)
    assert.notEqual(finding, undefined, `${label} must be reported at ${pointer}`)
    assert.match(finding.evidence, /^received (a|an|nothing|null|true|false)\b/, `${label}: the evidence describes the value`)
  }
})

test('every refused field in a contract describes its value and reproduces none of it', async () => {
  const cases = [
    ['id', { id: `${AWS_KEY}${FORBIDDEN['C0 NUL']}` }, '/operations/0/id', 'identifier-invalid'],
    ['method', { method: PASSWORD }, '/operations/0/method', 'operation-invalid'],
    ['scope', { idempotency: { scope: EMAIL } }, '/operations/0/idempotency/scope', 'operation-invalid'],
    ['expiresAfterSeconds', { idempotency: { expiresAfterSeconds: Number(CARD) } }, '/operations/0/idempotency/expiresAfterSeconds', 'operation-invalid'],
    ['payloadBinding', { idempotency: { payloadBinding: JWT } }, '/operations/0/idempotency/payloadBinding', 'operation-invalid'],
    ['conflictStatus', { idempotency: { conflictStatus: Number(CARD) } }, '/operations/0/idempotency/conflictStatus', 'operation-invalid'],
  ]

  for (const [label, override, pointer, ruleId] of cases) {
    const result = await streams({
      'contract.json': contractOf([operation(override)]),
      'capture.json': captureOf([record({ id: 'cap-1' })]),
    })

    assertNothingLeaked(result, label)
    const finding = findingsFor(result.report, ruleId).find((item) => item.location.pointer === pointer)
    assert.notEqual(finding, undefined, `${label} must be reported at ${pointer}`)
    assert.match(finding.evidence, /^received (a|an|nothing|null|true|false)\b/, `${label}: the evidence describes the value`)
  }
})

test('a refused schemaVersion is described on both inputs', async () => {
  const result = await streams({
    'contract.json': { schemaVersion: JWT, operations: [operation()] },
    'capture.json': { schemaVersion: AWS_KEY, records: [record({ id: 'cap-1' })] },
  })

  assertNothingLeaked(result, 'schemaVersion')
  assert.equal(findingsFor(result.report, 'contract-invalid')[0].evidence, 'received a string of 79 character(s)')
  assert.equal(findingsFor(result.report, 'capture-invalid')[0].evidence, 'received a string of 20 character(s)')
})

test('describeValue names the shape of a value and carries none of its content', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(false), 'false')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(-7), 'an integer')
  assert.equal(describeValue(1.5), 'a number')
  assert.equal(describeValue(''), 'a string of 0 character(s)')
  assert.equal(describeValue(AWS_KEY), 'a string of 20 character(s)')
  assert.equal(describeValue([1, 2, 3]), 'an array of 3 item(s)')
  assert.equal(describeValue({ a: 1 }), 'an object')

  for (const secret of SECRETS) {
    assert.equal(describeValue(secret).includes(secret), false)
  }
  assert.equal(describeValue(Number(CARD)).includes(CARD), false, 'a card number is a number too')
})
