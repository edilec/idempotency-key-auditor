#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_CAPTURE_NAME,
  DEFAULT_CONTRACT_NAME,
  auditIdempotency,
  excerpt,
  exitCodeFor,
  formatReport,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `idempotency-key-auditor

Inspect operation contracts and captured local outcomes for missing key scope,
expiry and payload binding, and for conflicting duplicate results. Nothing is
requested: the capture is the only source of outcome evidence there is, and the
report says so.

Usage:
  idempotency-key-auditor --root DIR [--contract FILE] [--capture FILE] [--json]
                          [--max-file-bytes N] [--max-operations N]
                          [--max-records N] [--max-records-per-key N]
                          [--max-findings N]

Options:
  --root DIR                Directory holding both inputs (required)
  --contract FILE           Operation contract, relative to --root
                            (default ${DEFAULT_CONTRACT_NAME})
  --capture FILE            Captured outcomes, relative to --root
                            (default ${DEFAULT_CAPTURE_NAME})
  --json                    Suppress the human summary on stderr
  --max-file-bytes N        Maximum bytes per input file (default 5242880)
  --max-operations N        Maximum operations in the contract (default 500)
  --max-records N           Maximum records in the capture (default 20000)
  --max-records-per-key N   Maximum captured records per key entry (default 500)
  --max-findings N          Maximum findings in one report (default 1000)
  -h, --help                Show this help
  -v, --version             Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  The captured outcomes did not contradict the contract. A capture is a finite
  set of observations, so a pass is never proof that an operation is idempotent
  in general -- only that nothing in this capture showed it was not. Where the
  capture never exercised a boundary at all, the report says so under
  duplicate-never-observed and operation-not-captured.

Exit codes:
  0  the capture was audited and nothing contradicted the contract
  1  the capture was audited and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-operations', 'maxOperations'],
  ['--max-records', 'maxRecords'],
  ['--max-records-per-key', 'maxRecordsPerKey'],
])

const VALUE_FLAGS = new Map([
  ['--capture', 'capture'],
  ['--contract', 'contract'],
  ['--root', 'root'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, contract: null, capture: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--capture a --capture b` audits a file nobody named and
   * `--max-records 5 --max-records 50000` enforces a bound nobody asked for.
   * That is the same defect as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await auditIdempotency({
      root: options.root,
      limits: options.limits,
      ...(options.contract === null ? {} : { contract: options.contract }),
      ...(options.capture === null ? {} : { capture: options.capture }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and the
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) {
    process.stderr.write(formatReport(report, {
      contract: options.contract ?? DEFAULT_CONTRACT_NAME,
      capture: options.capture ?? DEFAULT_CAPTURE_NAME,
    }))
  }
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.records} captured record(s) were evaluated; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
