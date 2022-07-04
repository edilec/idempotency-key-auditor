import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, cliReport, findingsFor, fixture, operation, raisedRules, record } from './support.mjs'

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
