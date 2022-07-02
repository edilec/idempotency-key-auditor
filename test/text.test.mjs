import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXCERPT_LIMIT,
  MAX_IDENTIFIER_LENGTH,
  byCodeUnit,
  decodeUtf8,
  excerpt,
  hasForbiddenCharacter,
  isFingerprint,
  isIdentifier,
  isPlainObject,
  parseInstant,
} from '../src/text.mjs'
import { FORBIDDEN } from './support.mjs'

test('every named class is detected and stripped', () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(`before${character}after`), true, `${name} must be detected`)
    assert.equal(excerpt(`before${character}after`).includes(character), false, `${name} must not survive excerpt`)
    assert.equal(isIdentifier(`id${character}`), false, `${name} must be refused inside an identifier`)
  }
})

test('ordinary right-to-left letters are left alone', () => {
  // Arabic and Hebrew letters carry their own direction, so refusing the bidi
  // overrides refuses nothing legitimate.
  const arabic = String.fromCharCode(0x0627, 0x062e, 0x062a, 0x0628, 0x0627, 0x0631)
  assert.equal(hasForbiddenCharacter(arabic), false)
  assert.equal(excerpt(arabic), arabic)
  assert.equal(isIdentifier(arabic), true)
})

test('excerpt collapses whitespace, trims and bounds', () => {
  assert.equal(excerpt('  a\t\tb\r\nc  '), 'a b c')
  const long = 'x'.repeat(EXCERPT_LIMIT + 40)
  assert.equal(excerpt(long).length, EXCERPT_LIMIT + 3)
  assert.equal(excerpt(long).endsWith('...'), true)
  assert.equal(excerpt('short', 3), 'sho...')
})

test('identifiers are bounded, trimmed and printable', () => {
  assert.equal(isIdentifier('idem-2f9c'), true)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier(' leading'), false)
  assert.equal(isIdentifier('trailing '), false)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH)), true)
  assert.equal(isIdentifier('x'.repeat(MAX_IDENTIFIER_LENGTH + 1)), false)
  assert.equal(isIdentifier(42), false)
  assert.equal(isIdentifier(null), false)
})

test('a fingerprint is a digest, never a body', () => {
  assert.equal(isFingerprint('sha256:4f2a9c31b7d0e5a8'), true)
  assert.equal(isFingerprint('YWJjZGVmZ2g='), true)
  assert.equal(isFingerprint('short'), false, 'below eight characters')
  assert.equal(isFingerprint(`sha256:${'a'.repeat(200)}`), false, 'above two hundred characters')
  assert.equal(isFingerprint('{"amount": 1200}'), false, 'a body is not a digest')
  assert.equal(isFingerprint('sha256 4f2a9c31'), false, 'no spaces')
  assert.equal(isFingerprint(':leadingcolon'), false, 'must start alphanumeric')
})

test('decoding is the decoder decision, not an inference from the decoded text', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x61, 0x62])), { ok: true, text: 'ab' })

  // A lone continuation byte is not UTF-8 and must be refused outright.
  assert.equal(decodeUtf8(new Uint8Array([0x61, 0xff, 0x62])).ok, false)

  // A file that legitimately holds U+FFFD decodes fine. A tool that inferred
  // "not UTF-8" from the presence of a replacement character reported a pass
  // on an unread file; the decoder is the only thing that gets a vote here.
  const encoded = new TextEncoder().encode(`a${String.fromCharCode(0xfffd)}b`)
  const decoded = decodeUtf8(encoded)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text.length, 3)
})

test('instants are validated against the calendar, not rolled forward', () => {
  assert.equal(parseInstant('2026-03-01T09:00:00Z').ok, true)
  assert.equal(parseInstant('2026-03-01T09:00:00.250Z').ok, true)
  assert.equal(parseInstant('2024-02-29T00:00:00Z').ok, true, '2024 is a leap year')

  for (const value of [
    '2026-02-31T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-03-00T00:00:00Z',
    '2026-03-01T24:00:00Z',
    '2026-03-01T09:60:00Z',
    '2026-03-01T09:00:60Z',
    '2026-03-01T09:00:00+01:00',
    '2026-03-01 09:00:00Z',
    '2026-03-01T09:00Z',
    '1969-12-31T23:59:59Z',
    '2101-01-01T00:00:00Z',
    20260301,
  ]) {
    assert.equal(parseInstant(value).ok, false, `${value} must be refused`)
  }
})

test('two instants differ by the seconds between them', () => {
  const first = parseInstant('2026-03-01T09:00:00Z')
  const second = parseInstant('2026-03-01T09:10:00Z')
  assert.equal((second.ms - first.ms) / 1000, 600)
})

test('byCodeUnit orders by code unit wherever a collator disagrees', () => {
  const collator = new Intl.Collator('en')
  for (const [left, right] of [
    ['Zebra', 'apple'],
    ['README', 'assets'],
    ['MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'],
    ['key-b', 'key_b'],
  ]) {
    assert.equal(byCodeUnit(left, right), -1, `${left} must precede ${right} by code unit`)
    assert.equal(collator.compare(left, right) > 0, true, `a collator puts ${right} first, which is the disagreement being pinned`)
  }
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('isPlainObject refuses arrays, null and dressed-up instances', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Map()), false)
  assert.equal(isPlainObject('x'), false)
})
