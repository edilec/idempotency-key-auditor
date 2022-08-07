# idempotency-key-auditor

Audit operation contracts and captured local outcomes for missing idempotency
key scope, expiry and payload binding — and for the one that matters most, a key
reused with a **different body**, which means the second caller silently
received the first caller's result.

The tool issues no request of any kind. It reads a contract describing what each
operation promises about its idempotency boundary, and a capture describing
calls that already happened, and reports where the two disagree.

- **Repository:** [edilec/idempotency-key-auditor](https://github.com/edilec/idempotency-key-auditor)
- **License:** MIT
- **Runtime:** Node 22 or later, no dependencies

## Install

```sh
npm install idempotency-key-auditor
```

Or run it from a checkout with no install step at all — the package has no
runtime and no development dependencies.

## Use

```sh
idempotency-key-auditor --root examples/clean
idempotency-key-auditor --root examples/broken --json | jq '.findings[].ruleId'
```

The JSON report goes to stdout and nothing else does, so stdout pipes straight
into a parser. The human summary and every diagnostic go to stderr; `--json`
suppresses the summary.

```
contract contract.json: 3 operation(s), 3 with a declared idempotency boundary.
capture capture.json: 8 of 8 record(s) evaluated, 0 not evaluated, 4 key entr(ies).
outcomes: 3 consistent replay(s), 0 conflict(s), 1 refused by the declared conflict status. status pass.
```

As a library:

```js
import { auditIdempotency, exitCodeFor, formatReport } from 'idempotency-key-auditor'

const report = await auditIdempotency({ root: 'examples/broken' })
process.stderr.write(formatReport(report))
process.exitCode = exitCodeFor(report)
```

### Exit codes

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | audited, and nothing contradicted the contract | the report |
| `1` | audited, and at least one error-severity rule fired | the report |
| `2` | invalid configuration or bad usage | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

A consumer that pipes stdout must handle an empty stdout on exit 2. A
configuration error means the run never had a subject, so there is nothing to
report about; unreadable evidence means the run had a subject and failed to
learn something about it, and the report says which input that was.

## The two inputs

A **contract** declares operations and what each promises:

```json
{
  "schemaVersion": "1",
  "operations": [
    {
      "id": "create-payment",
      "method": "POST",
      "path": "/v1/payments",
      "idempotency": {
        "keySource": "header:Idempotency-Key",
        "scope": "principal",
        "expiresAfterSeconds": 86400,
        "retryWindowSeconds": 3600,
        "payloadBinding": "request-body-fingerprint",
        "conflictStatus": 409
      }
    }
  ]
}
```

A **capture** records calls that were already observed:

```json
{
  "schemaVersion": "1",
  "records": [
    {
      "id": "cap-001",
      "operation": "create-payment",
      "key": "idem-2f9c41ab",
      "principal": "acct_northwind",
      "requestFingerprint": "sha256:4f2a9c31b7d0e5a8",
      "responseStatus": 201,
      "responseFingerprint": "sha256:0b17d4e9c2a35f60",
      "observedAt": "2026-03-01T09:00:00Z"
    }
  ]
}
```

Bodies never appear. A capture carries **fingerprints**, so the auditor can tell
"the same body" from "a different body" without ever holding a payload, a
credential or a personal detail. The fingerprint field accepts a digest alphabet
of 8–200 characters, so a body or a sentence of free text cannot arrive under
that name — it is a shape check and not a secret filter, and whoever writes the
capture is the one who decides the field holds a digest. A value this tool
*refuses* is never reproduced: the finding describes its shape, its pointer says
where it sits, and the value itself stays in the file it arrived in.

`docs/idempotency-rules.md` carries the full schemas, the complete rule catalog
with severities, the walk order and the limits. `examples/clean`,
`examples/broken` and `examples/incomplete` are runnable and exit 0, 1 and 2
respectively.

## What it reports

**About the contract**, whatever the capture contains:

- an operation with no idempotency boundary at all — `POST` and `PATCH` as an
  error, `PUT` and `DELETE` as a warning, since HTTP's idempotency is a
  statement about intent and not a guarantee about an implementation;
- a key with **no declared scope**. A key unique per principal and a key unique
  globally give opposite answers on the same capture, so an operation that does
  not say which leaves its captured records unevaluated rather than guessed at;
- a key with **no declared expiry**, which makes the deduplication window
  unknowable and the key store unbounded;
- an expiry shorter than the declared retry window, which is a second execution
  waiting to happen;
- **no payload binding**, or payload binding explicitly disabled, which is the
  condition under which a reused key returns the wrong caller's result.

**About the captured outcomes**:

- the same key and body reaching two different outcomes — `duplicate-outcome-conflict`;
- a key reused with a **different** body that was not refused —
  `key-reused-different-payload`, the headline finding;
- a reuse with a different body that *was* refused with the declared conflict
  status, reported as the guard working;
- a reuse arriving past the declared expiry, which is a fresh execution the
  contract predicted;
- a guarded operation reached with no key at all;
- one key value seen under several principals, which the declared scope keeps
  apart — and which is only legible *because* the scope was declared.

## Limits and non-goals

This is the part to read before treating a green run as an assurance.

**It cannot prove that an operation is idempotent.** The capture is a finite set
of observations someone already made. A capture in which every repeat agreed
shows that *those repeats* agreed — nothing about a repeat that was never
captured, a concurrent pair that never overlapped in the window observed, or a
code path this capture never reached. `pass` means "nothing in this capture
contradicted the contract", and the report names the operations the capture
never exercised (`operation-not-captured`, `duplicate-never-observed`) so a
green run cannot be read as more than that.

**It issues no request, so it cannot test anything.** There is no probe mode, no
replay, no traffic generation, and nothing in this package opens a socket. It
reads two files and writes a report.

**It cannot see a payload.** "The same body" means "the same fingerprint as
recorded by whoever produced the capture". A capture that fingerprints the wrong
thing — the wrong field set, a normalised form that erases a real difference —
produces a wrong answer, and this tool has no way to notice.

**It cannot tell a refusal from a second execution unless the contract says what
a refusal looks like.** With `conflictStatus` declared, a reuse answered with
that status is the guard working. Without it, a reuse carrying a different body
that produced a different result is `key-reuse-outcome-undetermined`: an error
that marks the run incomplete, because an unknown is not a verdict in either
direction.

**It does not read your code, your framework or your key store.** It audits what
the contract *says* and what the capture *shows*. A contract that describes an
implementation inaccurately will be audited faithfully against the wrong
description.

**It is not a concurrency checker.** Two records with the same instant are
ordered by record id so the walk is deterministic; that ordering is a reporting
decision, not a claim about which call reached the server first. Genuine
race behaviour between simultaneous callers is outside what a capture of
completed outcomes can show.

## Guarantees, and what holds them

- **Every finding takes its severity from one frozen `ruleId -> severity`
  table**, and an unknown rule id throws. The table is asserted against the
  documented catalog in both directions — and because a table, a catalog and a
  test's expected map are three declarations that a coordinated edit satisfies,
  every error rule is *also* pinned by running the real binary over a real
  input. Where severity alone decides the verdict, the status and the process
  exit code are the assertion; where the rule marks the run incomplete and the
  exit code is 2 either way, the number of errors in the summary and the
  severity word printed in the human report are, written out inline in a file
  that imports no table and shares no expectation with anything else.
- **`pass` is never reported on evidence that was not obtained.** Every input
  that could not be read, decoded, parsed or bounded, every record that could
  not be placed, and every comparison that lacked a fingerprint makes the run
  `incomplete` and exits 2. Each of those sites has a test that asserts the
  status and the exit code, so removing one turns exit 2 into exit 1 and fails.
- **`pass` with `checked: 0` is unreachable.** A run that evaluated no record
  emits `no-records-evaluated` and is incomplete.
- **Output is deterministic.** No wall clock, locale-aware comparison, random
  source or filesystem enumeration order affects it. Ordering is pinned by
  asserting the emitted order for inputs that sort differently under collation
  than by code unit — so substituting a collator, under any spelling a source
  scan would miss, fails a test.
- **Every untrusted string is sanitised on its way to output** — ids, keys,
  principals, paths, pointers, messages and evidence, not only an excerpt
  field — covering C0 and DEL, the whole C1 range (U+0085 NEL forges a line of
  its own, U+009B is the 8-bit CSI), U+2028 and U+2029, and the bidi and isolate
  controls U+200E, U+200F, U+202A–U+202E and U+2066–U+2069. Each class is driven
  through four routes into the report, one of them an identifier.
- **A refused value is described, never echoed.** Every field this tool rejects
  — an identifier, a fingerprint, a status, an instant, a schema version — is
  reported as its shape (`received a string of 49 character(s)`) and located by
  its pointer. Reproducing it would put content the validation exists to refuse
  onto stdout, which is piped and logged somewhere more public than the capture.
- **Both inputs are confined by real path on both sides**, so a symbolic link
  planted inside the root is refused unread and a root that is itself reached
  through a link is not falsely refused.
- **Every documented limit is enforced**, reported by name when hit, and makes
  the run incomplete rather than truncating silently. An unknown limit or
  configuration key is refused, not ignored.
- **The tool is read-only.** Nothing in `src/` or `bin/` writes, appends,
  renames or removes a file.

## Verify

```sh
npm run check
```

which runs `lint`, `test`, `example` and `pack:check` in that order. There is
nothing to install first.

## License

MIT. See [LICENSE](./LICENSE).
