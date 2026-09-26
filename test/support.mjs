/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees in this package can only be pinned by the second -- an
 * exit code cannot be satisfied by editing a table.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { auditIdempotency } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/idempotency-key-auditor.mjs')

/** A complete, valid guarded operation. Pass `{ idempotency: null }` for one with no boundary. */
export function operation(overrides = {}) {
  const { idempotency, ...rest } = overrides
  const result = { id: 'create-payment', method: 'POST', path: '/v1/payments', ...rest }
  if (idempotency !== null) {
    result.idempotency = {
      keySource: 'header:Idempotency-Key',
      scope: 'global',
      expiresAfterSeconds: 3600,
      retryWindowSeconds: 900,
      payloadBinding: 'request-body-fingerprint',
      conflictStatus: 409,
      ...(idempotency ?? {}),
    }
  }
  return result
}

/** A complete, valid captured record. */
export function record(overrides = {}) {
  return {
    id: 'cap-1',
    operation: 'create-payment',
    key: 'idem-aaaa1111',
    requestFingerprint: 'sha256:1111111111111111',
    responseStatus: 201,
    responseFingerprint: 'sha256:2222222222222222',
    observedAt: '2026-03-01T09:00:00Z',
    ...overrides,
  }
}

export const contractOf = (operations) => ({ schemaVersion: '1', operations })
export const captureOf = (records) => ({ schemaVersion: '1', records })

/**
 * Create a temporary root, write the named files into it, run `body(root)`,
 * and remove the tree afterwards whatever happened.
 *
 * A string is written verbatim and a `Uint8Array` byte for byte, so a test can
 * plant text that is not JSON, or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'idempotency-key-auditor-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The default pair of inputs, as objects. */
export const fixture = (operations, records) => ({
  'contract.json': contractOf(operations),
  'capture.json': captureOf(records),
})

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => auditIdempotency({ root, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams, never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and ordered by code unit. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})
