import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, METHODS, RULE_SEVERITY, auditIdempotency, compareFindings } from '../src/index.mjs'
import { apiReport, captureOf, cliReport, contractOf, findingsFor, fixture, operation, raisedRules, record, withRoot } from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running. Every case here uses inputs that an English collator orders the
 * other way round, pushes them through the real report path, and asserts the
 * exact emitted order -- so substituting a collator under any spelling fails a
 * test rather than going unnoticed.
 *
 * The collator is constructed in each test and asserted to disagree, which is
 * what makes these cases cases at all.
 */

const collator = new Intl.Collator('en')
const RESULT_B = 'sha256:bbbbbbbbbbbbbbbb'
const at = (seconds) => `2026-03-01T09:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z`

test('which record owns a key entry is decided by code unit when the instants are equal', async () => {
  // Same instant, so the record id is the whole of the tie-break. `Z` (0x5A)
  // precedes `a` (0x61) by code unit; an English collator puts "apple" first.
  assert.equal(collator.compare('Zebra', 'apple') > 0, true, 'the disagreement being pinned')

  const report = await apiReport(fixture(
    [operation({ idempotency: { conflictStatus: undefined } })],
    [
      record({ id: 'apple', requestFingerprint: 'sha256:aaaaaaaaaaaaaaaa', observedAt: at(0) }),
      record({ id: 'Zebra', requestFingerprint: 'sha256:zzzzzzzzzzzzzzzz'.replace(/z/g, 'f'), observedAt: at(0) }),
    ],
  ))

  assert.deepEqual(raisedRules(report), ['key-reused-different-payload'])
  const finding = findingsFor(report, 'key-reused-different-payload')[0]
  assert.match(finding.message, /^Record "apple"/, 'the second record by code unit is the one judged')
  assert.match(finding.message, /first attempt "Zebra"/, 'and the first by code unit owns the entry')
})

test('the per-key cut-off follows code units, so it decides which records are audited at all', async () => {
  for (const [first, second, third] of [['Zebra', 'apple', 'beta'], ['README', 'assets', 'build']]) {
    assert.equal(collator.compare(first, second) > 0, true, `a collator would examine ${second} before ${first}`)

    const report = await apiReport(fixture([operation()], [
      record({ id: second, observedAt: at(0) }),
      record({ id: third, observedAt: at(0), responseFingerprint: RESULT_B }),
      record({ id: first, observedAt: at(0) }),
    ]), { limits: { maxRecordsPerKey: 2 } })

    const stopped = findingsFor(report, 'too-many-records-for-key')
    assert.equal(stopped.length, 1)
    assert.match(stopped[0].message, new RegExp(`the walk stopped at record "${third}"`), 'the walk must stop at the third entry in code-unit order')
    assert.deepEqual(raisedRules(report), ['too-many-records-for-key'], `${third} was never judged, so its conflict is not reported`)
    assert.equal(report.summary.checked, 2)
  }
})

test('a list inside evidence is ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { scope: 'principal' } })],
    [
      record({ id: 'cap-1', principal: 'apple', observedAt: at(0) }),
      record({ id: 'cap-2', principal: 'Zebra', observedAt: at(5) }),
      record({ id: 'cap-3', principal: 'assets', observedAt: at(9) }),
      record({ id: 'cap-4', principal: 'README', observedAt: at(13) }),
    ],
  ))

  const finding = findingsFor(report, 'key-reused-across-principals')[0]
  assert.equal(finding.evidence, 'principals: README, Zebra, apple, assets')
  assert.notEqual(
    ['README', 'Zebra', 'apple', 'assets'].join(','),
    ['README', 'Zebra', 'apple', 'assets'].sort((a, b) => collator.compare(a, b)).join(','),
    'a collator orders these differently, which is what makes this a test',
  )
})

test('findings are emitted in the documented order, by code unit throughout', async () => {
  const records = [record({ id: 'cap-0', observedAt: at(0) })]
  for (let index = 1; index <= 10; index += 1) {
    records.push(record({
      id: `cap-${index}`,
      observedAt: at(index),
      responseFingerprint: `sha256:${String(index).padStart(16, '0')}`,
    }))
  }
  const report = await apiReport(fixture([operation()], records))

  const pointers = report.findings.map((finding) => finding.location.pointer)
  assert.deepEqual(pointers, [
    '/records/1', '/records/10', '/records/2', '/records/3', '/records/4',
    '/records/5', '/records/6', '/records/7', '/records/8', '/records/9',
  ])
  // A numeric collator -- a plausible substitution, since it reads "better" --
  // would put /records/9 before /records/10, which is exactly the drift being
  // refused: the documented order is by code unit and nothing else.
  const numeric = new Intl.Collator('en', { numeric: true })
  assert.equal(numeric.compare('/records/10', '/records/9') > 0, true)
})

test('the contract file and the capture file sort into one documented order', async () => {
  const report = await apiReport(fixture(
    [operation({ idempotency: { payloadBinding: undefined } })],
    [
      record({ id: 'cap-1', observedAt: at(0) }),
      record({ id: 'cap-2', observedAt: at(5), responseFingerprint: RESULT_B }),
    ],
  ))

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.location.pointer, finding.ruleId]),
    [
      ['capture.json', '/records/1', 'duplicate-outcome-conflict'],
      ['contract.json', '/operations/0/idempotency/payloadBinding', 'payload-binding-undeclared'],
    ],
  )
})

test('two runs over the same bytes produce byte-identical stdout', async () => {
  const files = fixture(
    [operation({ idempotency: { payloadBinding: undefined } }), operation({ id: 'refund', path: '/v1/refunds' })],
    [
      record({ id: 'cap-1', observedAt: at(0) }),
      record({ id: 'cap-2', observedAt: at(5), responseFingerprint: RESULT_B }),
      record({ id: 'cap-3', operation: 'refund', key: 'idem-cccc3333', observedAt: at(9) }),
    ],
  )

  const first = await cliReport(files)
  const second = await cliReport(files)

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.equal(first.report.findings.length > 2, true, 'the comparison is over a report with something in it')
})

/**
 * The documented sort key, comparison by comparison.
 *
 * `compareFindings` compares five fields in order, and a substitution at any
 * one of them is a separate mutation: pinning the first four leaves the fifth
 * free. Each case below reaches a different comparison -- and reaching the
 * later ones takes some arranging, because a finding's file, pointer and rule
 * id are usually enough to separate it from every other finding in the report.
 */

test('the file name decides first, by code unit', async () => {
  // Both names are chosen by the caller, so this comparison is driven by input
  // rather than by the two default names, which collate the same way they sort.
  assert.equal(collator.compare('Z.json', 'a.json') > 0, true, 'a collator would put a.json first')

  const report = await apiReport({
    'Z.json': contractOf([operation({ idempotency: { payloadBinding: undefined } })]),
    'a.json': captureOf([
      record({ id: 'cap-1', observedAt: at(0) }),
      record({ id: 'cap-2', observedAt: at(5), responseFingerprint: RESULT_B }),
    ]),
  }, { contract: 'Z.json', capture: 'a.json' })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.ruleId]),
    [['Z.json', 'payload-binding-undeclared'], ['a.json', 'duplicate-outcome-conflict']],
  )
})

test('the pointer decides second, by code unit', async () => {
  // A JSON key may hold any character, so the pointers two unknown keys produce
  // are the one place an arbitrary alphabet reaches this comparison.
  assert.equal(collator.compare('/operations/0/extraZ', '/operations/0/extra_a') > 0, true, 'a collator would put extra_a first')

  const report = await apiReport({
    'contract.json': { schemaVersion: '1', operations: [{ ...operation(), extraZ: 1, extra_a: 2 }] },
    'capture.json': captureOf([record({ id: 'cap-1', observedAt: at(0) })]),
  })

  assert.deepEqual(
    findingsFor(report, 'contract-key-unknown').map((finding) => finding.location.pointer),
    ['/operations/0/extraZ', '/operations/0/extra_a'],
  )
})

test('the message decides fourth, by code unit, where the pointer no longer separates two findings', async () => {
  // Two keys that agree for 199 characters: the pointers are excerpted to the
  // same 200 characters and the rule id is the same, so the message is the
  // first field that can tell these two findings apart.
  const shared = 'x'.repeat(199)
  const first = `${shared}Zebra`
  const second = `${shared}_apple`
  assert.equal(collator.compare(first, second) > 0, true, 'a collator would put the _apple key first')

  const report = await apiReport({
    'contract.json': { schemaVersion: '1', operations: [operation()], [first]: 1, [second]: 2 },
    'capture.json': captureOf([record({ id: 'cap-1', observedAt: at(0) })]),
  })

  const unknown = findingsFor(report, 'contract-key-unknown')
  assert.equal(unknown.length, 2)
  assert.equal(unknown[0].location.pointer, unknown[1].location.pointer, 'the pointers are excerpted to the same string')
  assert.equal(unknown[0].message.endsWith('Zebra".'), true, 'the Zebra key sorts first by code unit')
  assert.equal(unknown[1].message.endsWith('_apple".'), true)
})

test('the whole documented sort key is applied in order, every comparison by code unit', () => {
  // The evidence comparison is the last resort, reached only when the file, the
  // pointer, the rule id and the message are all equal -- which no pair of
  // findings this tool emits manages. It is still a comparison in the exported
  // contract, so it is asserted here directly rather than left free.
  const finding = (overrides) => ({
    ruleId: 'key-absent',
    location: { file: 'capture.json', pointer: '/records/0' },
    message: 'same',
    evidence: 'same',
    ...overrides,
  })
  // `Z` (0x5A) precedes `_` (0x5F) by code unit; an English collator puts the
  // underscored value first, so every pair below is a disagreement.
  assert.equal(collator.compare('Z', '_a') > 0, true, 'the disagreement being pinned')
  const differing = [
    ['file', { location: { file: 'Z', pointer: '/p' } }, { location: { file: '_a', pointer: '/p' } }],
    ['pointer', { location: { file: 'f', pointer: 'Z' } }, { location: { file: 'f', pointer: '_a' } }],
    ['message', { message: 'Z' }, { message: '_a' }],
    ['evidence', { evidence: 'Z' }, { evidence: '_a' }],
  ]

  for (const [field, low, high] of differing) {
    assert.equal(compareFindings(finding(low), finding(high)) < 0, true, `${field} must order by code unit`)
    assert.equal(compareFindings(finding(high), finding(low)) > 0, true, `${field} must order by code unit in both directions`)
  }

  assert.equal(compareFindings(finding({}), finding({})), 0, 'two identical findings tie')
  // A finding with no evidence compares as the empty string rather than
  // throwing or sorting as "undefined".
  const bare = finding({})
  delete bare.evidence
  assert.equal(compareFindings(bare, finding({ evidence: 'a' })) < 0, true)
})

test('the comparisons over a closed alphabet cannot be told from a collator, enumerated', () => {
  // Three comparisons order values this package declares rather than values a
  // file supplies: the rule id tie-break in `compareFindings` (an id outside
  // `RULE_SEVERITY` throws in `createFinding`), the method list a refusal
  // prints, and the known-limit list an unknown limit is reported against.
  // Over each of those alphabets an English collator agrees with code unit on
  // every ordered pair, so no fixture can tell the two comparators apart there.
  // The enumeration is the test: a value added in some other alphabet -- an
  // underscore, a lower-case method, a digit-letter mix that collates apart --
  // makes this fail and says the comparison has become observable and needs a
  // fixture of its own.
  const alphabets = [
    ['rule ids', Object.keys(RULE_SEVERITY), 30],
    ['methods', METHODS, 5],
    ['limit names', Object.keys(DEFAULT_LIMITS), 4],
  ]

  for (const [label, values, atLeast] of alphabets) {
    assert.equal(values.length > atLeast, true, `${label} were actually read`)
    let compared = 0
    for (const left of values) {
      for (const right of values) {
        if (left === right) continue
        compared += 1
        assert.equal(
          Math.sign(collator.compare(left, right)),
          Math.sign(left < right ? -1 : 1),
          `${label}: ${left} and ${right} order differently under collation, so this comparison is now observable and needs a fixture`,
        )
      }
    }
    assert.equal(compared, values.length * (values.length - 1), `${label}: every ordered pair`)
  }
})

test('an unknown limit is named by walking the given keys in code-unit order', async () => {
  // Object keys keep insertion order, so the sort is what decides which of two
  // unknown limits the throw names -- and the list of known limits it prints is
  // ordered by the same comparator.
  assert.equal(collator.compare('Zed', 'abc') > 0, true, 'a collator would name abc')

  await assert.rejects(
    () => auditIdempotency({ root: '.', limits: { abc: 1, Zed: 1 } }),
    /^TypeError: Unknown limit "Zed"; known limits are maxFileBytes, maxFindings, maxOperations, maxRecords, maxRecordsPerKey$/,
  )
  assert.deepEqual(
    Object.keys(DEFAULT_LIMITS).sort((left, right) => (left < right ? -1 : 1)),
    ['maxFileBytes', 'maxFindings', 'maxOperations', 'maxRecords', 'maxRecordsPerKey'],
  )
})

test('an unknown option is named by walking the given keys in code-unit order', async () => {
  await assert.rejects(
    () => auditIdempotency({ root: '.', abc: 1, Zed: 1 }),
    /^TypeError: Unknown option "Zed"; known options are capture, contract, limits, root$/,
  )
})

test('the method list a refusal prints is ordered by code unit', async () => {
  const report = await apiReport({
    'contract.json': { schemaVersion: '1', operations: [{ ...operation(), method: 'TRACE' }] },
    'capture.json': captureOf([record({ id: 'cap-1', observedAt: at(0) })]),
  })

  assert.equal(
    findingsFor(report, 'operation-invalid')[0].message,
    'Operation "create-payment" needs a "method" from DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.',
  )
})

test('a run over a root that cannot be reached is a configuration error, not an order', async () => {
  // A positive control for the two rejection tests above: the same call with no
  // unknown key reaches the root check instead, so those tests are failing on
  // the key they name and not on the root they borrow.
  await withRoot({}, async (root) => {
    const report = await auditIdempotency({ root, limits: { maxRecords: 5 } })
    assert.equal(report.status, 'incomplete')
  })
})
