/**
 * The outcome audit: what the captured records say about the boundary the
 * contract declared.
 *
 * Every conclusion here is a statement about the capture and only about the
 * capture. A capture that contains no reuse of a key cannot show that reuse is
 * handled correctly, and no number of consistent replays shows that the next
 * one will be consistent. What this module can show is a contradiction: the
 * same key and the same body reaching two different outcomes, or one key
 * carrying two different bodies.
 */

import { byCodeUnit } from './text.mjs'

const FINGERPRINT_IN_EVIDENCE = 32
const KEY_IN_MESSAGE = 64

/** Shorten an untrusted token for display. `excerpt` still sanitises and bounds it afterwards. */
function abbreviate(value, limit) {
  const text = String(value)
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}

const groupKeyFor = (operation, record) =>
  operation.scope === 'global'
    ? JSON.stringify(['global', operation.id, record.key])
    : JSON.stringify(['principal', operation.id, record.principal, record.key])

/** Ordered by observation, then by record id. The tie-break decides which record owns the key entry. */
const byObservation = (left, right) =>
  left.observedAt - right.observedAt || byCodeUnit(left.id, right.id)

/**
 * Place every record against its operation, reporting the ones that cannot be
 * placed at all.
 *
 * "Cannot be placed" is not a verdict. A record naming an operation the
 * contract does not declare, or belonging to an operation whose key scope is
 * undeclared, has not been judged either way -- so it is counted as
 * unevaluated and the run is `incomplete`, never a pass.
 */
function groupRecords(sink, files, contract, records, state) {
  const groups = new Map()
  const principalsByKey = new Map()

  for (const record of records) {
    const operation = contract.operations.get(record.operation)
    if (operation === undefined) {
      state.unevaluated += 1
      state.incomplete = true
      sink.add({
        file: files.capture,
        ruleId: 'capture-operation-unknown',
        pointer: record.pointer,
        message: `Record "${record.id}" names operation "${abbreviate(record.operation, KEY_IN_MESSAGE)}", which the contract does not declare, so the record was not evaluated.`,
        suggestion: 'Declare the operation in the contract, or remove the record from the capture.',
      })
      continue
    }
    if (!operation.guarded) {
      // The contract already said this operation has no boundary; the record
      // adds nothing to that, and there is no key entry to group it under.
      state.checked += 1
      continue
    }
    if (operation.scope === null) {
      state.unevaluated += 1
      state.incomplete = true
      continue
    }
    if (record.key === null) {
      state.checked += 1
      sink.add({
        file: files.capture,
        ruleId: 'key-absent',
        pointer: record.pointer,
        message: `Record "${record.id}" reached guarded operation "${operation.id}" with no idempotency key, so a retry of this call would run the operation again.`,
        suggestion: `Require the key declared at ${operation.keySource === null ? 'the operation\'s keySource' : operation.keySource} and refuse the request without it.`,
      })
      continue
    }
    if (operation.scope === 'principal' && record.principal === null) {
      state.unevaluated += 1
      state.incomplete = true
      sink.add({
        file: files.capture,
        ruleId: 'record-principal-missing',
        pointer: record.pointer,
        message: `Operation "${operation.id}" scopes keys per principal, but record "${record.id}" names none, so this tool cannot tell whether its key collides with another caller's. The record was not evaluated.`,
        suggestion: 'Record the account, tenant or API client each captured call came from.',
      })
      continue
    }

    state.checked += 1
    const groupKey = groupKeyFor(operation, record)
    const existing = groups.get(groupKey)
    if (existing === undefined) groups.set(groupKey, { operation, members: [record] })
    else existing.members.push(record)

    if (operation.scope === 'principal') {
      const indexKey = JSON.stringify([operation.id, record.key])
      const entry = principalsByKey.get(indexKey)
      if (entry === undefined) {
        principalsByKey.set(indexKey, { operation, principals: new Set([record.principal]), record })
      } else {
        entry.principals.add(record.principal)
        if (record.index < entry.record.index) entry.record = record
      }
    }
  }

  return { groups, principalsByKey }
}

/**
 * Walk one key's captured outcomes in order.
 *
 * `anchor` is the record that established the current key entry. A follower is
 * judged against it, and the anchor only moves when the declared expiry says
 * the entry is gone -- never because a later caller disagreed with it, since
 * the first caller is the one whose result the store holds.
 */
function auditGroup(sink, files, operation, members, state, reported) {
  let anchor = members[0]

  for (let position = 1; position < members.length; position += 1) {
    const record = members[position]
    const pointer = record.pointer
    const first = `first attempt "${anchor.id}" at ${anchor.observedAtText}`

    if (
      operation.expiresAfterSeconds !== null &&
      record.observedAt - anchor.observedAt > operation.expiresAfterSeconds * 1000
    ) {
      const gap = Math.round((record.observedAt - anchor.observedAt) / 1000)
      sink.add({
        file: files.capture,
        ruleId: 'key-expired-between-attempts',
        pointer,
        message: `Record "${record.id}" reused key "${abbreviate(record.key, KEY_IN_MESSAGE)}" ${gap}s after the ${first}, past the declared expiry of ${operation.expiresAfterSeconds}s, so the operation ran a second time rather than being deduplicated.`,
        suggestion: 'Expect a fresh execution here; extend the expiry only if repeated delivery this late must still be collapsed.',
      })
      anchor = record
      continue
    }

    if (anchor.requestFingerprint === null || record.requestFingerprint === null) {
      state.incomplete = true
      for (const item of [anchor, record]) {
        if (item.requestFingerprint !== null) continue
        if (reported.has(JSON.stringify(['payload', item.id]))) continue
        reported.add(JSON.stringify(['payload', item.id]))
        sink.add({
          file: files.capture,
          ruleId: 'payload-evidence-missing',
          pointer: item.pointer,
          message: `Record "${item.id}" shares key "${abbreviate(record.key, KEY_IN_MESSAGE)}" with another captured call but carries no requestFingerprint, so whether the two callers sent the same body is unknown.`,
          suggestion: 'Record a digest of the request body for every captured call.',
        })
      }
      continue
    }

    if (record.requestFingerprint !== anchor.requestFingerprint) {
      const payloads =
        `${abbreviate(anchor.requestFingerprint, FINGERPRINT_IN_EVIDENCE)} then ` +
        `${abbreviate(record.requestFingerprint, FINGERPRINT_IN_EVIDENCE)}`

      if (operation.conflictStatus !== null) {
        if (record.responseStatus === operation.conflictStatus) {
          state.conflictsRefused += 1
          sink.add({
            file: files.capture,
            ruleId: 'key-conflict-detected',
            pointer,
            message: `Record "${record.id}" reused key "${abbreviate(record.key, KEY_IN_MESSAGE)}" with a different body and was answered ${record.responseStatus}, the conflict status the contract declares, so the payload binding held on this call.`,
            evidence: `request fingerprints: ${payloads}`,
          })
          continue
        }
        state.conflicts += 1
        sink.add({
          file: files.capture,
          ruleId: 'key-reused-different-payload',
          pointer,
          message: `Record "${record.id}" reused key "${abbreviate(record.key, KEY_IN_MESSAGE)}" with a different body than the ${first} and was answered ${record.responseStatus} instead of the declared conflict status ${operation.conflictStatus}, so the second caller was not refused.`,
          evidence: `request fingerprints: ${payloads}`,
          suggestion: 'Compare the stored request fingerprint on every replay and refuse a mismatch.',
        })
        continue
      }

      const blind = [anchor, record].filter((item) => item.responseFingerprint === null)
      if (blind.length > 0) {
        for (const item of blind) {
          if (reported.has(JSON.stringify(['outcome', item.id]))) continue
          reported.add(JSON.stringify(['outcome', item.id]))
          state.incomplete = true
          sink.add({
            file: files.capture,
            ruleId: 'outcome-evidence-missing',
            pointer: item.pointer,
            message: `Record "${item.id}" shares key "${abbreviate(record.key, KEY_IN_MESSAGE)}" with another captured call but carries no responseFingerprint, so whether the two callers received the same result is unknown.`,
            suggestion: 'Record a digest of the response body for every captured call.',
          })
        }
        continue
      }

      if (
        record.responseFingerprint === anchor.responseFingerprint &&
        record.responseStatus === anchor.responseStatus
      ) {
        state.conflicts += 1
        sink.add({
          file: files.capture,
          ruleId: 'key-reused-different-payload',
          pointer,
          message: `Record "${record.id}" reused key "${abbreviate(record.key, KEY_IN_MESSAGE)}" with a different body than the ${first} and received that first caller's result verbatim, so the second caller's request was never executed.`,
          evidence: `request fingerprints: ${payloads}`,
          suggestion: 'Compare the stored request fingerprint on every replay and refuse a mismatch.',
        })
        continue
      }

      state.conflicts += 1
      state.incomplete = true
      sink.add({
        file: files.capture,
        ruleId: 'key-reuse-outcome-undetermined',
        pointer,
        message: `Record "${record.id}" reused key "${abbreviate(record.key, KEY_IN_MESSAGE)}" with a different body than the ${first} and received a different result, but the contract declares no conflictStatus, so whether the second caller was refused or executed cannot be decided from this capture.`,
        evidence: `request fingerprints: ${payloads}`,
        suggestion: 'Declare "conflictStatus" so a refusal can be told apart from a second execution.',
      })
      continue
    }

    const blind = [anchor, record].filter((item) => item.responseFingerprint === null)
    if (blind.length > 0) {
      for (const item of blind) {
        if (reported.has(JSON.stringify(['outcome', item.id]))) continue
        reported.add(JSON.stringify(['outcome', item.id]))
        state.incomplete = true
        sink.add({
          file: files.capture,
          ruleId: 'outcome-evidence-missing',
          pointer: item.pointer,
          message: `Record "${item.id}" shares key "${abbreviate(record.key, KEY_IN_MESSAGE)}" and body with another captured call but carries no responseFingerprint, so whether the two callers received the same result is unknown.`,
          suggestion: 'Record a digest of the response body for every captured call.',
        })
      }
      continue
    }

    if (
      record.responseFingerprint !== anchor.responseFingerprint ||
      record.responseStatus !== anchor.responseStatus
    ) {
      // Name what actually differed. "a different outcome (201 then 201)" is
      // the kind of line that makes a reader distrust the whole report.
      const differences = []
      if (record.responseStatus !== anchor.responseStatus) {
        differences.push(`status ${anchor.responseStatus} then ${record.responseStatus}`)
      }
      if (record.responseFingerprint !== anchor.responseFingerprint) {
        differences.push('a different response body')
      }
      const window = operation.expiresAfterSeconds === null
        ? 'with no expiry declared between them'
        : `within the declared expiry of ${operation.expiresAfterSeconds}s`
      state.conflicts += 1
      sink.add({
        file: files.capture,
        ruleId: 'duplicate-outcome-conflict',
        pointer,
        message: `Record "${record.id}" repeated key "${abbreviate(record.key, KEY_IN_MESSAGE)}" and body from the ${first} ${window}, yet the outcomes differ (${differences.join('; ')}), so the same key and body did not have one logical outcome.`,
        evidence:
          `response fingerprints: ${abbreviate(anchor.responseFingerprint, FINGERPRINT_IN_EVIDENCE)} then ` +
          `${abbreviate(record.responseFingerprint, FINGERPRINT_IN_EVIDENCE)}`,
        suggestion: 'Store the first outcome against the key and replay it, rather than executing again.',
      })
      continue
    }

    state.replays += 1
  }
}

/**
 * Audit every captured outcome against the compiled contract.
 *
 * @returns {object} the counters the report summary is built from.
 */
export function auditOutcomes(sink, files, contract, records, limits) {
  const state = {
    checked: 0,
    unevaluated: 0,
    replays: 0,
    conflicts: 0,
    conflictsRefused: 0,
    keys: 0,
    incomplete: false,
  }
  const { groups, principalsByKey } = groupRecords(sink, files, contract, records, state)
  state.keys = groups.size
  const reported = new Set()
  const exercised = new Set()

  // Group keys are JSON arrays of already-validated identifiers, so sorting
  // them by code unit gives one fixed walk order on every host.
  for (const groupKey of [...groups.keys()].sort(byCodeUnit)) {
    const { operation, members } = groups.get(groupKey)
    members.sort(byObservation)

    let examined = members
    if (members.length > limits.maxRecordsPerKey) {
      const dropped = members[limits.maxRecordsPerKey]
      examined = members.slice(0, limits.maxRecordsPerKey)
      state.unevaluated += members.length - limits.maxRecordsPerKey
      state.checked -= members.length - limits.maxRecordsPerKey
      state.incomplete = true
      sink.add({
        file: files.capture,
        ruleId: 'too-many-records-for-key',
        pointer: dropped.pointer,
        message: `Key "${abbreviate(dropped.key, KEY_IN_MESSAGE)}" on operation "${operation.id}" carries ${members.length} captured records, above the maxRecordsPerKey limit of ${limits.maxRecordsPerKey}; the walk stopped at record "${dropped.id}" and the rest were not evaluated.`,
        suggestion: 'Raise --max-records-per-key, or narrow the capture.',
      })
    }

    if (examined.length > 1) exercised.add(operation.id)
    auditGroup(sink, files, operation, examined, state, reported)
  }

  const captured = new Set(records.map((record) => record.operation))
  for (const id of contract.order) {
    const operation = contract.operations.get(id)
    if (!captured.has(id)) {
      sink.add({
        file: files.contract,
        ruleId: 'operation-not-captured',
        pointer: operation.pointer,
        message: `Operation "${id}" appears in no captured record, so nothing in this run confirms or contradicts what its contract declares.`,
        suggestion: 'Capture the operation, or audit it against a capture that covers it.',
      })
      continue
    }
    if (operation.guarded && operation.scope !== null && !exercised.has(id)) {
      sink.add({
        file: files.contract,
        ruleId: 'duplicate-never-observed',
        pointer: operation.pointer,
        message: `Operation "${id}" declares an idempotency boundary, but no key in this capture was used twice, so the capture does not exercise the boundary at all.`,
        suggestion: 'Capture a retry of this operation before reading a pass here as evidence the boundary works.',
      })
    }
  }

  for (const indexKey of [...principalsByKey.keys()].sort(byCodeUnit)) {
    const entry = principalsByKey.get(indexKey)
    if (entry.principals.size < 2) continue
    const principals = [...entry.principals].sort(byCodeUnit)
    sink.add({
      file: files.capture,
      ruleId: 'key-reused-across-principals',
      pointer: entry.record.pointer,
      message: `Key "${abbreviate(entry.record.key, KEY_IN_MESSAGE)}" on operation "${entry.operation.id}" was seen under ${principals.length} principals; the contract scopes keys per principal, so these are separate key entries and were audited separately.`,
      evidence: `principals: ${principals.map((name) => abbreviate(name, 40)).join(', ')}`,
    })
  }

  return state
}
