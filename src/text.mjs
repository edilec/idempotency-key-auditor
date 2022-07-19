/**
 * Decoding, sanitising, ordering, identifiers and instants.
 *
 * Nothing here touches the filesystem, the network, the locale or the clock.
 * Every value this module handles arrived in a file the tool did not write, so
 * every value it returns is treated as data on its way to a report -- never as
 * something that can shape a line of output.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Locale-aware comparison -- the string method and the collator class alike --
 * depends on ICU data that differs between Node builds and between hosts, and
 * both treat punctuation as ignorable: under collation `key-a` and `key_a`
 * swap places depending on where the tool runs. A report that is only
 * deterministic on one machine is not deterministic, so every order this tool
 * exposes is decided here. Neither spelling appears anywhere in this package,
 * and `test/ordering.test.mjs` pins the emitted order rather than the spelling
 * -- a scan cannot tell one comparator from the other.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the JavaScript parser, and
 * the rest are invisible in an editor. Spelling each one keeps this file plain
 * ASCII and keeps the list readable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in
 *   the human report; ESC opens a terminal escape sequence; NUL truncates a
 *   value in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two of them
 *   do the same damage unaided: U+0085 NEL is a line break to a great many
 *   consumers, and U+009B is the 8-bit CSI, a terminal control introducer that
 *   needs no ESC in front of it.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so an idempotency key can be displayed as something other than
 *   the value that was compared and grouped. Ordinary right-to-left text --
 *   Arabic, Hebrew -- needs none of these: the letters carry their own
 *   direction, so refusing the overrides refuses nothing legitimate.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- ids, keys,
 * principals, paths, pointers, messages, suggestions and evidence alike, not
 * only an excerpt field. Tab, newline and carriage return are left out of this
 * class deliberately: `excerpt` collapses them into a single space in the very
 * next step, which is the same result by a shorter route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What an identifier may not contain: the same four classes, plus the three
 * ASCII whitespace controls `CONTROL` leaves to the collapse. An identifier
 * gets no second pass, and an idempotency key that prints differently from the
 * value that was compared and grouped is a key nobody can audit.
 */
const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * Detects any of the four classes anywhere in a string. Exported so tests can
 * walk a whole report and assert that nothing survived, rather than checking
 * the one field a developer remembered.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN_IN_IDENTIFIER.test(String(value))
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 200

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every identifier, path, pointer, message and piece of evidence that reaches
 * a finding goes through here. A tool in this catalog sanitised its evidence
 * carefully and left its identifiers raw, so a record id holding a newline
 * printed two lines into the human report and invented a finding that was
 * never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Identifiers are this tool's vocabulary: operation ids, record ids,
 * idempotency keys and principals. They are compared, used as map keys, used
 * to group captured outcomes and then printed. A control character in one of
 * them is refused at the door rather than cleaned up on the way out, because a
 * value that prints differently from the value that was grouped cannot be
 * audited by the person reading the report.
 */
export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (value.trim() !== value) return false
  return !FORBIDDEN_IN_IDENTIFIER.test(value)
}

/**
 * A fingerprint stands in for a request or response body that this tool must
 * never see. The accepted shape is deliberately narrow -- printable ASCII from
 * a fixed set, 8 to 200 characters -- so that a body, a sentence of free text
 * or a personal detail cannot arrive in the report under the name of a digest.
 *
 * It is a shape check and not a secret filter: a value that already looks like
 * a digest is accepted, and whoever writes the capture is the one who decides
 * that the field holds one. What the alphabet *does* guarantee is that a
 * refused value is refused -- and a refused value is never reproduced, which
 * is what `describeValue` below is for.
 */
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9:._+/=-]{7,199}$/

export function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT.test(value)
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field is arbitrary content from a file this tool did not write,
 * and the report goes to stdout -- a stream that is piped, logged and pasted
 * somewhere more public than the capture ever was. Echoing the value back
 * ("received \"4111111111111111\"") hands that content a wider audience than
 * it had, and it does so on exactly the fields whose validation exists to keep
 * a payload, a credential or a personal detail out of the report.
 *
 * The pointer on the finding already names the exact position in the file, so
 * the shape is all a reader needs from the report itself; the value is in the
 * file, where it started.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains
 * a replacement character, and that confusion has let an unread input report a
 * pass in this catalog. The decoder decides; the decoded text never gets a
 * vote. Every file this tool opens goes through here, the contract included --
 * the configuration path is exactly where a sibling tool hardened its data
 * path and forgot.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/
const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

function daysInMonth(year, month) {
  if (month !== 2) return DAYS_IN_MONTH[month - 1]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return leap ? 29 : 28
}

/**
 * Parse an ISO-8601 UTC instant, exactly.
 *
 * `Date.parse` alone is not a validator: it accepts `2026-02-31T00:00:00Z` and
 * hands back the third of March, and it accepts `24:00:00` and hands back the
 * following midnight. Either would let a capture claim two attempts were
 * further apart -- or closer together -- than the bytes actually say, which is
 * the difference between "the key had expired" and "the key was replayed".
 * The calendar is checked arithmetically instead, and only `Z` is accepted:
 * a capture that mixes local offsets is a capture whose ordering depends on
 * who wrote the line.
 *
 * `Date.UTC` is a pure conversion from validated components to an epoch
 * offset. It reads no clock; the zero-argument Date constructor and the static
 * current-time member do, and neither appears anywhere in this package.
 */
export function parseInstant(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' }
  const parts = INSTANT.exec(value)
  if (parts === null) return { ok: false, reason: 'not-iso-utc' }
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = Number(parts[6])
  const millisecond = parts[7] === undefined ? 0 : Number(parts[7])
  if (year < 1970 || year > 2100) return { ok: false, reason: 'out-of-range' }
  if (month < 1 || month > 12) return { ok: false, reason: 'not-a-real-instant' }
  if (day < 1 || day > daysInMonth(year, month)) return { ok: false, reason: 'not-a-real-instant' }
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'not-a-real-instant' }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  if (!Number.isFinite(ms)) return { ok: false, reason: 'not-a-real-instant' }
  const canonical =
    `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}` +
    `${parts[7] === undefined ? '' : `.${parts[7]}`}Z`
  return { ok: true, ms, canonical }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
