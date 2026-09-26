/**
 * The capture: outcomes that were already observed locally and written down.
 *
 * A record is a description of a call that happened, not an instruction to
 * make one. Nothing in this module or anywhere else in this package opens a
 * socket; the capture is the only source of outcome evidence there is.
 *
 * Bodies never appear. A capture carries fingerprints of the request and
 * response, so the auditor can tell "the same body" from "a different body"
 * without ever holding a payload, a credential or a personal detail.
 */

import { byCodeUnit, describeValue, isFingerprint, isIdentifier, isPlainObject, parseInstant } from './text.mjs'

export const CAPTURE_SCHEMA_VERSION = '1'

export const CAPTURE_KEYS = Object.freeze(['schemaVersion', 'records'])
export const RECORD_KEYS = Object.freeze([
  'id',
  'key',
  'observedAt',
  'operation',
  'principal',
  'requestFingerprint',
  'responseFingerprint',
  'responseStatus',
])

function reportUnknownKeys(sink, file, raw, allowed, pointer, subject) {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
  for (const key of unknown) {
    sink.add({
      file,
      ruleId: 'capture-key-unknown',
      pointer: `${pointer}/${key}`,
      message: `${subject} declares the unknown key "${key}".`,
      evidence: `known keys: ${allowed.join(', ')}`,
      suggestion: 'Correct the spelling or remove the key; an ignored key would audit nothing at all.',
    })
  }
  return unknown.length > 0
}

/**
 * Compile one record, or report why it cannot be used as evidence.
 *
 * A record that does not compile is not evidence of anything, so it is never
 * counted as checked. The run that contains one is `incomplete`: an outcome
 * nobody could read is not an outcome that agreed with anything.
 */
function compileRecord(sink, file, entry, index) {
  const pointer = `/records/${index}`
  if (!isPlainObject(entry)) {
    sink.add({ file, ruleId: 'record-invalid', pointer, message: `Record at index ${index} must be an object.` })
    return null
  }
  if (reportUnknownKeys(sink, file, entry, RECORD_KEYS, pointer, `Record at index ${index}`)) return null

  if (!isIdentifier(entry.id)) {
    sink.add({
      file,
      ruleId: 'identifier-invalid',
      pointer: `${pointer}/id`,
      message: `Record at index ${index} needs an "id" of 1-200 characters carrying no control, separator or bidi character.`,
      evidence: `received ${describeValue(entry.id)}`,
    })
    return null
  }
  if (!isIdentifier(entry.operation)) {
    sink.add({
      file,
      ruleId: 'identifier-invalid',
      pointer: `${pointer}/operation`,
      message: `Record "${entry.id}" needs an "operation" of 1-200 characters carrying no control, separator or bidi character.`,
      evidence: `received ${describeValue(entry.operation)}`,
    })
    return null
  }
  for (const field of ['key', 'principal']) {
    if (entry[field] === undefined) continue
    if (!isIdentifier(entry[field])) {
      sink.add({
        file,
        ruleId: 'identifier-invalid',
        pointer: `${pointer}/${field}`,
        message: `Record "${entry.id}" carries a "${field}" that is not a printable identifier of 1-200 characters; a value that prints differently from the value that was grouped cannot be audited.`,
        evidence: `received ${describeValue(entry[field])}`,
      })
      return null
    }
  }
  for (const field of ['requestFingerprint', 'responseFingerprint']) {
    if (entry[field] === undefined) continue
    if (!isFingerprint(entry[field])) {
      sink.add({
        file,
        ruleId: 'record-invalid',
        pointer: `${pointer}/${field}`,
        message: `Record "${entry.id}" needs "${field}" to be a digest of 8-200 characters from A-Z a-z 0-9 : . _ + / = -, never a body.`,
        evidence: `received ${describeValue(entry[field])}`,
      })
      return null
    }
  }
  if (!Number.isInteger(entry.responseStatus) || entry.responseStatus < 100 || entry.responseStatus > 599) {
    sink.add({
      file,
      ruleId: 'record-invalid',
      pointer: `${pointer}/responseStatus`,
      message: `Record "${entry.id}" needs a "responseStatus" between 100 and 599.`,
      evidence: `received ${describeValue(entry.responseStatus)}`,
    })
    return null
  }
  const observedAt = parseInstant(entry.observedAt)
  if (!observedAt.ok) {
    sink.add({
      file,
      ruleId: 'timestamp-invalid',
      pointer: `${pointer}/observedAt`,
      message: `Record "${entry.id}" needs an "observedAt" ISO-8601 UTC instant such as 2026-03-01T09:00:00Z (${observedAt.reason}).`,
      evidence: `received ${describeValue(entry.observedAt)}`,
    })
    return null
  }

  return {
    id: entry.id,
    operation: entry.operation,
    key: entry.key ?? null,
    principal: entry.principal ?? null,
    requestFingerprint: entry.requestFingerprint ?? null,
    responseFingerprint: entry.responseFingerprint ?? null,
    responseStatus: entry.responseStatus,
    observedAt: observedAt.ms,
    observedAtText: observedAt.canonical,
    index,
    pointer,
  }
}

/**
 * Compile the capture.
 *
 * @returns {{records: object[], declared: number, bounded: boolean}|null}
 *   `null` when the document could not be understood at all; `bounded` when a
 *   limit stopped every record being compiled.
 */
export function compileCapture(sink, file, raw, limits) {
  if (!isPlainObject(raw)) {
    sink.add({ file, ruleId: 'capture-invalid', pointer: '/', message: 'The capture must be a JSON object.' })
    return null
  }
  if (reportUnknownKeys(sink, file, raw, CAPTURE_KEYS, '', 'The capture')) return null
  if (raw.schemaVersion !== CAPTURE_SCHEMA_VERSION) {
    sink.add({
      file,
      ruleId: 'capture-invalid',
      pointer: '/schemaVersion',
      message: `The capture must declare schemaVersion "${CAPTURE_SCHEMA_VERSION}".`,
      evidence: `received ${describeValue(raw.schemaVersion)}`,
    })
    return null
  }
  if (!Array.isArray(raw.records)) {
    sink.add({ file, ruleId: 'capture-invalid', pointer: '/records', message: '"records" must be an array.' })
    return null
  }
  if (raw.records.length > limits.maxRecords) {
    sink.add({
      file,
      ruleId: 'too-many-records',
      pointer: '/records',
      message: `The capture holds ${raw.records.length} records, above the maxRecords limit of ${limits.maxRecords}; none were compiled.`,
      suggestion: 'Raise --max-records, or split the capture.',
    })
    // The declared count is still reported, so the summary says how many
    // records went unevaluated rather than claiming the capture was empty.
    // `bounded` stops the audit running over the empty list: an operation
    // whose records were bounded out has not gone uncaptured, and saying so
    // would be a false statement about the capture on disk.
    return { records: [], declared: raw.records.length, bounded: true }
  }

  const records = []
  const seen = new Set()
  for (let index = 0; index < raw.records.length; index += 1) {
    const record = compileRecord(sink, file, raw.records[index], index)
    if (record === null) continue
    if (seen.has(record.id)) {
      sink.add({
        file,
        ruleId: 'record-duplicate',
        pointer: `/records/${index}/id`,
        message: `Record id "${record.id}" is used more than once, so a finding against it could not be attributed to one captured call.`,
        suggestion: 'Give every captured record a unique id.',
      })
      continue
    }
    seen.add(record.id)
    records.push(record)
  }
  return { records, declared: raw.records.length, bounded: false }
}
