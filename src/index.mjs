/**
 * idempotency-key-auditor -- inspect operation contracts and captured local
 * outcomes for missing key scope, expiry and payload binding, and for
 * conflicting duplicate results.
 *
 * This package issues no request of any kind. It reads a contract that says
 * what each operation promises about its idempotency boundary, and a capture
 * that says what already happened, and it reports where the two disagree.
 *
 * What that means, and what it does not, is stated plainly in the README and
 * in `docs/idempotency-rules.md`: a capture is a finite set of observations,
 * so this tool can show that captured outcomes contradict a promise, and it
 * can never show that an operation is idempotent in general.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'

import { auditOutcomes } from './audit.mjs'
import { compileCapture } from './capture.mjs'
import { compileContract } from './contract.mjs'
import {
  byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject, parseFailureDetail,
} from './text.mjs'

export const TOOL_ID = 'idempotency-key-auditor'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_CONTRACT_NAME = 'contract.json'
export const DEFAULT_CAPTURE_NAME = 'capture.json'

/**
 * Limits, each enforced and each reported by name when it is hit.
 *
 * Exceeding one is never a silent truncation: it produces a finding that names
 * the limit and marks the run `incomplete`, because a partial walk is not
 * evidence that the part nobody walked was fine.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 5242880,
  maxOperations: 500,
  maxRecords: 20000,
  maxRecordsPerKey: 500,
  maxFindings: 1000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxFileBytes: 67108864,
  maxOperations: 5000,
  maxRecords: 500000,
  maxRecordsPerKey: 50000,
  maxFindings: 20000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at forty construction sites it drifts silently,
 * and demoting one of the error rules below turns a payment charged twice into
 * a green build with every test still passing. Every finding takes its
 * severity from here and an unknown rule id throws.
 *
 * `test/severity-table.test.mjs` asserts this table against the documented
 * catalog in both directions. That is worth having and it is not the test:
 * three declarations agreeing with each other survive a coordinated edit of
 * all three. `test/severity-behaviour.test.mjs` drives a real input through
 * the real binary and pins the status and the process exit code instead.
 */
export const RULE_SEVERITY = Object.freeze({
  'capture-invalid': 'error',
  'capture-key-unknown': 'error',
  'capture-operation-unknown': 'error',
  'contract-invalid': 'error',
  'contract-key-unknown': 'error',
  'duplicate-never-observed': 'info',
  'duplicate-outcome-conflict': 'error',
  'identifier-invalid': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'key-absent': 'error',
  'key-conflict-detected': 'info',
  'key-expired-between-attempts': 'warning',
  'key-expiry-below-retry-window': 'error',
  'key-expiry-undeclared': 'error',
  'key-reuse-outcome-undetermined': 'error',
  'key-reused-across-principals': 'info',
  'key-reused-different-payload': 'error',
  'key-scope-undeclared': 'error',
  'key-source-undeclared': 'error',
  'no-operations': 'error',
  'no-records-evaluated': 'error',
  'operation-duplicate': 'error',
  'operation-guard-method-implied': 'warning',
  'operation-guard-missing': 'error',
  'operation-guard-on-safe-method': 'info',
  'operation-invalid': 'error',
  'operation-not-captured': 'warning',
  'outcome-evidence-missing': 'error',
  'path-escapes-root': 'error',
  'payload-binding-disabled': 'error',
  'payload-binding-undeclared': 'error',
  'payload-evidence-missing': 'error',
  'record-duplicate': 'error',
  'record-invalid': 'error',
  'record-principal-missing': 'error',
  'timestamp-invalid': 'error',
  'too-many-findings': 'error',
  'too-many-operations': 'error',
  'too-many-records': 'error',
  'too-many-records-for-key': 'error',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['capture', 'contract', 'limits', 'root'])

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A documented limit that a
 * typo silently disables is a limit that is not enforced, and the CLI turns
 * this throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(`Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`)
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against a
 * path that has not been resolved refuses legitimate files whenever the root
 * is reached through a symbolic link -- a `/var` that is really `/private/var`
 * is enough -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered, because naming a file outside the declared root is a usage error
 * rather than a fact about the subject. This is emphatically *not* the
 * confinement: a symbolic link planted inside the root passes every check in
 * this function, and `resolveInput` is what catches it by resolving the real
 * path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  const parts = normalize(name).split(/[\\/]/)
  if (parts.includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * sanitised evidence carefully and left identifiers raw, so a record id
 * holding a newline forged an extra line in the human report.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/idempotency-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/** Documented sort key: location.file, location.pointer, ruleId, message, evidence. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file) ||
    byCodeUnit(a.location.pointer, b.location.pointer) ||
    byCodeUnit(a.ruleId, b.ruleId) ||
    byCodeUnit(a.message, b.message) ||
    byCodeUnit(a.evidence ?? '', b.evidence ?? '')
  )
}

function emptyState() {
  return {
    checked: 0,
    unevaluated: 0,
    replays: 0,
    conflicts: 0,
    conflictsRefused: 0,
    keys: 0,
    incomplete: false,
  }
}

function buildReport(sink, state, counts, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: counts.captureName,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or narrow the capture.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      operations: counts.operations,
      guarded: counts.guarded,
      records: counts.records,
      unevaluated: state.unevaluated,
      keys: state.keys,
      replays: state.replays,
      conflicts: state.conflicts,
      conflictsRefused: state.conflictsRefused,
    },
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. Equally, comparing a real root against an
 * unresolved target refuses legitimate files, so the root is realpath'd too.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    // The entry may still exist as a link that resolves nowhere. Confine the
    // nearest existing ancestor first, so a symlinked parent directory cannot
    // decide where a "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code === 'ELOOP' ? 'ELOOP' : 'ENOENT' }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${parseFailureDetail(error)}.`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

/**
 * Audit a contract and a capture.
 *
 * @param {object} options
 * @param {string} options.root Directory holding both inputs.
 * @param {string} [options.contract] Contract file, relative to the root.
 * @param {string} [options.capture] Capture file, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @returns {Promise<object>} the report.
 */
export async function auditIdempotency(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  const contractName = validateName(options.contract ?? DEFAULT_CONTRACT_NAME, '--contract')
  const captureName = validateName(options.capture ?? DEFAULT_CAPTURE_NAME, '--capture')

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const sink = new FindingSink()
  const files = { contract: contractName, capture: captureName }
  const state = emptyState()
  const counts = { operations: 0, guarded: 0, records: 0, captureName }

  const documents = {}
  for (const [kind, name] of [['contract', contractName], ['capture', captureName]]) {
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep both inputs inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      documents[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    if (loaded === null) state.incomplete = true
    documents[kind] = loaded
  }

  let contract = null
  if (documents.contract !== null) {
    contract = compileContract(sink, contractName, documents.contract.value, limits)
    if (contract === null) state.incomplete = true
    else {
      counts.operations = contract.operations.size
      for (const operation of contract.operations.values()) if (operation.guarded) counts.guarded += 1
      // An entry that did not compile was not audited. Reporting `fail` here
      // would claim the whole contract was read when part of it was refused.
      if (contract.operations.size !== contract.declared) state.incomplete = true
    }
  }

  let capture = null
  if (documents.capture !== null) {
    capture = compileCapture(sink, captureName, documents.capture.value, limits)
    if (capture === null) state.incomplete = true
    else {
      counts.records = capture.declared
      if (capture.records.length !== capture.declared) state.incomplete = true
      state.unevaluated += capture.declared - capture.records.length
    }
  }

  if (contract === null && capture !== null && !capture.bounded) {
    // Nothing could be audited against, so every record that did compile is
    // unevaluated. Leaving them uncounted would make the summary claim a
    // smaller gap than the run actually has.
    state.unevaluated += capture.records.length
  }

  let audited = false
  if (contract !== null && capture !== null && !capture.bounded) {
    audited = true
    const outcome = auditOutcomes(sink, files, contract, capture.records, limits)
    state.checked = outcome.checked
    state.unevaluated += outcome.unevaluated
    state.replays = outcome.replays
    state.conflicts = outcome.conflicts
    state.conflictsRefused = outcome.conflictsRefused
    state.keys = outcome.keys
    if (outcome.incomplete) state.incomplete = true
  }

  /**
   * The vacuous pass, refused explicitly.
   *
   * A capture with an empty `records` array compiles, the contract compiles,
   * the audit runs and evaluates nothing, no other flag is set, and the run
   * would report `pass` with `checked: 0` -- green on no evidence at all. This
   * is the only thing standing between that capture and a green build, so it
   * is an error, it marks the run incomplete, and `test/incomplete.test.mjs`
   * fails if either half is removed.
   *
   * It is deliberately confined to runs that reached the audit. A run whose
   * contract or capture could not be read, decoded, parsed, compiled or
   * bounded has already said so under its own rule id, and adding "0 records
   * were evaluated" there would be noise -- worse, it would backstop those
   * flags, so removing one of them would change nothing observable and no test
   * could fail when it went. Each guard is now the only thing holding its own
   * case, which is the only arrangement a mutation can be caught in.
   */
  if (audited && state.checked === 0) {
    state.incomplete = true
    sink.add({
      file: captureName,
      ruleId: 'no-records-evaluated',
      pointer: '/records',
      message: `The run evaluated 0 of ${counts.records} captured record(s), so it has no evidence to be green on.`,
      suggestion: 'Capture the operations named in the contract, and fix whatever stopped the records that are there from being evaluated.',
    })
  }

  return buildReport(sink, state, counts, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `contract ${excerpt(extra.contract ?? DEFAULT_CONTRACT_NAME, 80)}: ${summary.operations} operation(s), ${summary.guarded} with a declared idempotency boundary.`,
    `capture ${excerpt(extra.capture ?? DEFAULT_CAPTURE_NAME, 80)}: ${summary.checked} of ${summary.records} record(s) evaluated, ${summary.unevaluated} not evaluated, ${summary.keys} key entr(ies).`,
    `outcomes: ${summary.replays} consistent replay(s), ${summary.conflicts} conflict(s), ${summary.conflictsRefused} refused by the declared conflict status. status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { auditOutcomes } from './audit.mjs'
export { CAPTURE_KEYS, CAPTURE_SCHEMA_VERSION, RECORD_KEYS, compileCapture } from './capture.mjs'
export {
  CONTRACT_KEYS, CONTRACT_SCHEMA_VERSION, IDEMPOTENCY_KEYS, METHODS,
  METHOD_IDEMPOTENT_BY_SPEC, OPERATION_KEYS, PAYLOAD_BINDINGS, SAFE_METHODS,
  SCOPES, UNSAFE_METHODS, compileContract,
} from './contract.mjs'
export {
  EXCERPT_LIMIT, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue,
  excerpt, hasForbiddenCharacter, isFingerprint, isIdentifier, isPlainObject,
  parseFailureDetail, parseInstant,
} from './text.mjs'
