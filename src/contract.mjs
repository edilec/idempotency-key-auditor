/**
 * The operation contract: what each operation claims about its idempotency
 * boundary.
 *
 * This module validates the declaration and reports what the declaration does
 * not say. It never looks at a captured outcome -- that is `audit.mjs` -- and
 * it never issues a request.
 */

import { byCodeUnit, describeValue, isIdentifier, isPlainObject } from './text.mjs'

export const CONTRACT_SCHEMA_VERSION = '1'

/**
 * Every key the schema defines, per level. A key outside these lists is
 * refused rather than ignored: a misspelled `payloadBinding` that is quietly
 * dropped turns "this operation does not bind the payload" -- a real failure
 * -- into a green run.
 */
export const CONTRACT_KEYS = Object.freeze(['schemaVersion', 'operations'])
export const OPERATION_KEYS = Object.freeze(['id', 'method', 'path', 'idempotency'])
export const IDEMPOTENCY_KEYS = Object.freeze([
  'conflictStatus',
  'expiresAfterSeconds',
  'keySource',
  'payloadBinding',
  'retryWindowSeconds',
  'scope',
])

/** HTTP methods this tool knows how to reason about, and what it assumes of each. */
export const UNSAFE_METHODS = Object.freeze(['PATCH', 'POST'])
export const METHOD_IDEMPOTENT_BY_SPEC = Object.freeze(['DELETE', 'PUT'])
export const SAFE_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS'])
export const METHODS = Object.freeze([...SAFE_METHODS, ...METHOD_IDEMPOTENT_BY_SPEC, ...UNSAFE_METHODS].sort(byCodeUnit))

export const SCOPES = Object.freeze(['global', 'principal'])
export const PAYLOAD_BINDINGS = Object.freeze(['none', 'request-body-fingerprint'])

/** A year and a day, in seconds. Longer than this is a retention policy, not an expiry. */
export const MAX_SECONDS = 31622400
const MAX_PATH_LENGTH = 200
const MAX_KEY_SOURCE_LENGTH = 120

/**
 * `keySource` says where the key is carried, e.g. `header:Idempotency-Key` or
 * `body:idempotency_key`. Restricted to printable ASCII without spaces so that
 * a contract cannot use it to carry arbitrary text into the report.
 */
const KEY_SOURCE = /^[A-Za-z][A-Za-z0-9]{0,15}:[!-~]{1,100}$/

function unknownKeys(raw, allowed) {
  return Object.keys(raw).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}

function reportUnknownKeys(sink, file, raw, allowed, pointer, ruleId, subject) {
  const unknown = unknownKeys(raw, allowed)
  for (const key of unknown) {
    sink.add({
      file,
      ruleId,
      pointer: `${pointer}/${key}`,
      message: `${subject} declares the unknown key "${key}".`,
      evidence: `known keys: ${allowed.join(', ')}`,
      suggestion: 'Correct the spelling or remove the key; an ignored key would audit nothing at all.',
    })
  }
  return unknown.length > 0
}

function isBoundedInteger(value, low, high) {
  return Number.isInteger(value) && value >= low && value <= high
}

/**
 * Validate one operation's declaration.
 *
 * Returns the compiled operation, or `null` when the declaration could not be
 * understood well enough to audit anything against it.
 */
function compileOperation(sink, file, entry, index) {
  const pointer = `/operations/${index}`
  if (!isPlainObject(entry)) {
    sink.add({ file, ruleId: 'operation-invalid', pointer, message: `Operation at index ${index} must be an object.` })
    return null
  }
  if (reportUnknownKeys(sink, file, entry, OPERATION_KEYS, pointer, 'contract-key-unknown', `Operation at index ${index}`)) {
    return null
  }
  if (!isIdentifier(entry.id)) {
    sink.add({
      file,
      ruleId: 'identifier-invalid',
      pointer: `${pointer}/id`,
      message: `Operation at index ${index} needs an "id" of 1-200 characters carrying no control, separator or bidi character.`,
      evidence: `received ${describeValue(entry.id)}`,
    })
    return null
  }
  if (!METHODS.includes(entry.method)) {
    sink.add({
      file,
      ruleId: 'operation-invalid',
      pointer: `${pointer}/method`,
      message: `Operation "${entry.id}" needs a "method" from ${METHODS.join(', ')}.`,
      evidence: `received ${describeValue(entry.method)}`,
    })
    return null
  }
  if (typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.length > MAX_PATH_LENGTH) {
    sink.add({
      file,
      ruleId: 'operation-invalid',
      pointer: `${pointer}/path`,
      message: `Operation "${entry.id}" needs a "path" of 1-${MAX_PATH_LENGTH} characters.`,
    })
    return null
  }

  const operation = {
    id: entry.id,
    method: entry.method,
    path: entry.path,
    index,
    pointer,
    guarded: false,
    keySource: null,
    scope: null,
    expiresAfterSeconds: null,
    retryWindowSeconds: null,
    payloadBinding: null,
    conflictStatus: null,
  }

  if (entry.idempotency === undefined) return operation
  if (!isPlainObject(entry.idempotency)) {
    sink.add({
      file,
      ruleId: 'operation-invalid',
      pointer: `${pointer}/idempotency`,
      message: `Operation "${entry.id}" declares "idempotency" that is not an object.`,
      suggestion: 'Omit the key entirely when the operation has no idempotency boundary.',
    })
    return null
  }
  const block = entry.idempotency
  const blockPointer = `${pointer}/idempotency`
  if (reportUnknownKeys(sink, file, block, IDEMPOTENCY_KEYS, blockPointer, 'contract-key-unknown', `Operation "${entry.id}"`)) {
    return null
  }
  operation.guarded = true

  if (block.keySource !== undefined) {
    if (typeof block.keySource !== 'string' || block.keySource.length > MAX_KEY_SOURCE_LENGTH || !KEY_SOURCE.test(block.keySource)) {
      sink.add({
        file,
        ruleId: 'operation-invalid',
        pointer: `${blockPointer}/keySource`,
        message: `Operation "${entry.id}" declares a "keySource" that is not a "location:name" pair, e.g. header:Idempotency-Key.`,
      })
      return null
    }
    operation.keySource = block.keySource
  }
  if (block.scope !== undefined) {
    if (!SCOPES.includes(block.scope)) {
      sink.add({
        file,
        ruleId: 'operation-invalid',
        pointer: `${blockPointer}/scope`,
        message: `Operation "${entry.id}" declares a "scope" outside ${SCOPES.join(', ')}.`,
        evidence: `received ${describeValue(block.scope)}`,
      })
      return null
    }
    operation.scope = block.scope
  }
  for (const field of ['expiresAfterSeconds', 'retryWindowSeconds']) {
    if (block[field] === undefined) continue
    if (!isBoundedInteger(block[field], 1, MAX_SECONDS)) {
      sink.add({
        file,
        ruleId: 'operation-invalid',
        pointer: `${blockPointer}/${field}`,
        message: `Operation "${entry.id}" needs "${field}" to be an integer between 1 and ${MAX_SECONDS}.`,
        evidence: `received ${describeValue(block[field])}`,
      })
      return null
    }
    operation[field] = block[field]
  }
  if (block.payloadBinding !== undefined) {
    if (!PAYLOAD_BINDINGS.includes(block.payloadBinding)) {
      sink.add({
        file,
        ruleId: 'operation-invalid',
        pointer: `${blockPointer}/payloadBinding`,
        message: `Operation "${entry.id}" declares a "payloadBinding" outside ${PAYLOAD_BINDINGS.join(', ')}.`,
        evidence: `received ${describeValue(block.payloadBinding)}`,
      })
      return null
    }
    operation.payloadBinding = block.payloadBinding
  }
  if (block.conflictStatus !== undefined) {
    if (!isBoundedInteger(block.conflictStatus, 100, 599)) {
      sink.add({
        file,
        ruleId: 'operation-invalid',
        pointer: `${blockPointer}/conflictStatus`,
        message: `Operation "${entry.id}" needs "conflictStatus" to be an HTTP status between 100 and 599.`,
        evidence: `received ${describeValue(block.conflictStatus)}`,
      })
      return null
    }
    operation.conflictStatus = block.conflictStatus
  }
  return operation
}

/**
 * Report what an operation's declaration does not say.
 *
 * Each of these is a statement about the contract alone. None of them can be
 * settled by a capture: a capture that happens to contain no reuse says
 * nothing about whether the key is scoped, when it expires or whether the
 * payload is bound.
 */
function reportDeclarationGaps(sink, file, operation) {
  const { id, pointer } = operation

  if (!operation.guarded) {
    if (UNSAFE_METHODS.includes(operation.method)) {
      sink.add({
        file,
        ruleId: 'operation-guard-missing',
        pointer,
        message: `Operation "${id}" is ${operation.method} and declares no idempotency boundary, so a retried request runs the operation again.`,
        evidence: `${operation.method} ${operation.path}`,
        suggestion: 'Declare an "idempotency" block, or move the operation to a method whose repetition is defined.',
      })
    } else if (METHOD_IDEMPOTENT_BY_SPEC.includes(operation.method)) {
      sink.add({
        file,
        ruleId: 'operation-guard-method-implied',
        pointer,
        message: `Operation "${id}" is ${operation.method} and declares no idempotency boundary; HTTP calls the method idempotent, which is a statement about intent and not a guarantee about this implementation.`,
        evidence: `${operation.method} ${operation.path}`,
        suggestion: 'Declare the boundary explicitly if repeated delivery must be safe.',
      })
    }
    return
  }

  if (SAFE_METHODS.includes(operation.method)) {
    sink.add({
      file,
      ruleId: 'operation-guard-on-safe-method',
      pointer,
      message: `Operation "${id}" is ${operation.method} and declares an idempotency boundary; a safe method should not need one.`,
      evidence: `${operation.method} ${operation.path}`,
      suggestion: 'Check whether the operation actually mutates state under a safe method.',
    })
  }
  if (operation.keySource === null) {
    sink.add({
      file,
      ruleId: 'key-source-undeclared',
      pointer: `${pointer}/idempotency/keySource`,
      message: `Operation "${id}" does not say where its idempotency key is carried, so nobody can tell whether a caller supplied one.`,
      suggestion: 'Declare "keySource", for example header:Idempotency-Key.',
    })
  }
  if (operation.scope === null) {
    sink.add({
      file,
      ruleId: 'key-scope-undeclared',
      pointer: `${pointer}/idempotency/scope`,
      message: `Operation "${id}" does not declare a key scope. A key unique per principal and a key unique globally behave differently on the same capture, so the captured outcomes for this operation were not evaluated.`,
      suggestion: `Declare "scope" as one of ${SCOPES.join(' or ')}.`,
    })
  }
  if (operation.expiresAfterSeconds === null) {
    sink.add({
      file,
      ruleId: 'key-expiry-undeclared',
      pointer: `${pointer}/idempotency/expiresAfterSeconds`,
      message: `Operation "${id}" does not declare when its keys expire, so the window in which a retry is deduplicated is unknown and the key store is unbounded.`,
      suggestion: 'Declare "expiresAfterSeconds".',
    })
  }
  if (
    operation.expiresAfterSeconds !== null &&
    operation.retryWindowSeconds !== null &&
    operation.expiresAfterSeconds < operation.retryWindowSeconds
  ) {
    sink.add({
      file,
      ruleId: 'key-expiry-below-retry-window',
      pointer: `${pointer}/idempotency/expiresAfterSeconds`,
      message: `Operation "${id}" expires keys after ${operation.expiresAfterSeconds}s but declares a retry window of ${operation.retryWindowSeconds}s, so a client retry can arrive after the key is gone and run the operation a second time.`,
      suggestion: 'Raise "expiresAfterSeconds" to at least the retry window, or shorten the retry window.',
    })
  }
  if (operation.payloadBinding === null) {
    sink.add({
      file,
      ruleId: 'payload-binding-undeclared',
      pointer: `${pointer}/idempotency/payloadBinding`,
      message: `Operation "${id}" does not declare whether the stored key is bound to the request payload, so a key reused with a different body cannot be detected.`,
      suggestion: 'Declare "payloadBinding" as request-body-fingerprint.',
    })
  } else if (operation.payloadBinding === 'none') {
    sink.add({
      file,
      ruleId: 'payload-binding-disabled',
      pointer: `${pointer}/idempotency/payloadBinding`,
      message: `Operation "${id}" declares payloadBinding "none", so a key reused with a different body returns the first caller's result instead of being refused.`,
      suggestion: 'Bind the stored key to a fingerprint of the request body and refuse a mismatch.',
    })
  }
}

/**
 * Compile and audit the contract.
 *
 * @returns {{operations: Map<string, object>, order: string[], declared: number}|null}
 *   `null` when the document could not be understood at all. `declared` is the
 *   number of entries the contract held, so a caller can tell that fewer were
 *   compiled than were written down -- an operation that did not compile was
 *   not audited, and the run that dropped it is not complete.
 */
export function compileContract(sink, file, raw, limits) {
  if (!isPlainObject(raw)) {
    sink.add({ file, ruleId: 'contract-invalid', pointer: '/', message: 'The contract must be a JSON object.' })
    return null
  }
  if (reportUnknownKeys(sink, file, raw, CONTRACT_KEYS, '', 'contract-key-unknown', 'The contract')) return null
  if (raw.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    sink.add({
      file,
      ruleId: 'contract-invalid',
      pointer: '/schemaVersion',
      message: `The contract must declare schemaVersion "${CONTRACT_SCHEMA_VERSION}".`,
      evidence: `received ${describeValue(raw.schemaVersion)}`,
    })
    return null
  }
  if (!Array.isArray(raw.operations)) {
    sink.add({ file, ruleId: 'contract-invalid', pointer: '/operations', message: '"operations" must be an array.' })
    return null
  }
  if (raw.operations.length === 0) {
    sink.add({
      file,
      ruleId: 'no-operations',
      pointer: '/operations',
      message: 'The contract declares no operations, so there is nothing for a capture to be audited against.',
      suggestion: 'Declare the operations this capture covers.',
    })
    return null
  }
  if (raw.operations.length > limits.maxOperations) {
    sink.add({
      file,
      ruleId: 'too-many-operations',
      pointer: '/operations',
      message: `The contract declares ${raw.operations.length} operations, above the maxOperations limit of ${limits.maxOperations}; none were compiled.`,
      suggestion: 'Raise --max-operations, or split the contract.',
    })
    return null
  }

  const operations = new Map()
  const order = []
  for (let index = 0; index < raw.operations.length; index += 1) {
    const operation = compileOperation(sink, file, raw.operations[index], index)
    if (operation === null) continue
    if (operations.has(operation.id)) {
      sink.add({
        file,
        ruleId: 'operation-duplicate',
        pointer: `/operations/${index}/id`,
        message: `Operation id "${operation.id}" is declared more than once, so a captured record naming it could not be attributed.`,
        suggestion: 'Give every operation a unique id.',
      })
      continue
    }
    operations.set(operation.id, operation)
    order.push(operation.id)
  }
  for (const id of order) reportDeclarationGaps(sink, file, operations.get(id))
  return { operations, order, declared: raw.operations.length }
}
