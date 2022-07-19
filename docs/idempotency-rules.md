# Rule catalog, schemas and limits

`idempotency-key-auditor` reads two documents and reports where they disagree.
It issues no request of any kind, so every conclusion it reaches is a statement
about the bytes it was given.

- [What this tool can and cannot conclude](#what-this-tool-can-and-cannot-conclude)
- [The contract](#the-contract)
- [The capture](#the-capture)
- [How a key entry is formed and walked](#how-a-key-entry-is-formed-and-walked)
- [Rule catalog](#rule-catalog)
- [Report, ordering and exit codes](#report-ordering-and-exit-codes)
- [Limits](#limits)

## What this tool can and cannot conclude

The capture is a finite set of observations that someone already made. That
fixes the shape of every conclusion available here.

**It can conclude that the captured outcomes contradict the declared boundary.**
One key carrying two different request fingerprints, or one key and one request
fingerprint reaching two different outcomes, is a contradiction visible in the
capture itself. No amount of context makes it consistent.

**It cannot conclude that an operation is idempotent.** A capture in which every
repeat agreed shows that those repeats agreed. It says nothing about a repeat
that was never captured, about a concurrent pair that never overlapped in the
window observed, or about the behaviour of a code path this capture never
reached. `pass` therefore means "nothing in this capture contradicted the
contract", and the report says which operations the capture never exercised at
all — `operation-not-captured` and `duplicate-never-observed` exist precisely so
that a green run cannot be read as more than it is.

**It cannot see a payload.** The capture carries fingerprints, never bodies, so
"the same body" means "the same fingerprint as recorded by whoever produced the
capture". A capture that fingerprints the wrong thing produces a wrong answer,
and this tool has no way to notice.

**It cannot tell a refusal from a second execution unless the contract says
what a refusal looks like.** With `conflictStatus` declared, a reuse answered
with that status is the guard working. Without it, a reuse with a different body
that produced a different result is reported as
`key-reuse-outcome-undetermined`: an error that marks the run `incomplete`,
because an unknown is not a verdict in either direction.

## The contract

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

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | exactly `"1"` |
| `operations` | yes | non-empty array |
| `id` | yes | 1–200 characters, unique, no control, separator or bidi character |
| `method` | yes | one of `DELETE`, `GET`, `HEAD`, `OPTIONS`, `PATCH`, `POST`, `PUT` |
| `path` | yes | 1–200 characters of prose; sanitised before it reaches the report |
| `idempotency` | no | omit it to say the operation has no boundary at all |
| `keySource` | no | `location:name`, e.g. `header:Idempotency-Key` |
| `scope` | no | `global` or `principal` |
| `expiresAfterSeconds` | no | integer 1–31622400 |
| `retryWindowSeconds` | no | integer 1–31622400; how long a client keeps retrying |
| `payloadBinding` | no | `request-body-fingerprint` or `none` |
| `conflictStatus` | no | HTTP status 100–599 returned when a reuse carries a different body |

Every key outside these lists is refused, at every level. A misspelled
`payloadBinding` that was quietly ignored would turn "this operation does not
bind the payload" into a green run.

`scope` decides what counts as the same key entry. Per principal, two accounts
using the same key value are two independent entries; globally they are one.
The same capture produces opposite answers under the two, which is why an
operation with no declared scope has its captured records left unevaluated
rather than guessed at.

## The capture

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

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | 1–200 characters, unique within the capture |
| `operation` | yes | the id of an operation the contract declares |
| `key` | no | the idempotency key the call carried; absent means it carried none |
| `principal` | no | the account, tenant or API client; required under `scope: "principal"` |
| `requestFingerprint` | no | digest of the request body, 8–200 characters from `A–Z a–z 0–9 : . _ + / = -` |
| `responseStatus` | yes | integer 100–599 |
| `responseFingerprint` | no | digest of the response body, same shape |
| `observedAt` | yes | ISO-8601 UTC instant, `YYYY-MM-DDTHH:MM:SS[.mmm]Z` |

A fingerprint is deliberately restricted to a digest alphabet so that a capture
cannot carry a body or a sentence of free text into the report under the name of
a digest. It is a shape check and not a secret filter — a value that already
looks like a digest is accepted — so whoever writes the capture is the one who
decides the field holds one.

A value the tool *refuses* is never reproduced. The finding names its shape
(`received a string of 49 character(s)`) and its pointer says exactly where in
the file it sits; the value stays in the file it arrived in, rather than being
copied onto stdout. Nothing here is ever sent anywhere: the tool reads two files
and writes a report.

Both fingerprints are optional because a capture may genuinely not have them —
and where one is missing and a comparison needed it, that is reported as missing
evidence and the run is `incomplete`. It is never treated as agreement.

## How a key entry is formed and walked

1. Each record is placed against the operation it names. A record naming an
   unknown operation, or belonging to an operation with no declared scope, or
   missing the principal its scope requires, is **not evaluated**: it is counted
   under `summary.unevaluated` and the run is `incomplete`.
2. Records are grouped into key entries. Under `scope: "global"` the entry is
   `(operation, key)`; under `scope: "principal"` it is
   `(operation, principal, key)`.
3. Each entry is walked in order of `observedAt`, with the record id as the
   tie-break, ordered by UTF-16 code unit.
4. The first record of an entry is the **anchor**: the call whose result the key
   store holds. Each later record is judged against it.
5. The anchor moves only when the declared expiry has passed between it and the
   record being judged. It never moves because a later caller disagreed with it,
   because the first caller is the one who owns the entry.

Judging one record against the anchor:

| Situation | Result |
| --- | --- |
| more than `expiresAfterSeconds` apart | `key-expired-between-attempts`, and the later record becomes the anchor |
| either record has no `requestFingerprint` | `payload-evidence-missing`; the pair is not compared |
| different request fingerprint, `conflictStatus` declared and returned | `key-conflict-detected` |
| different request fingerprint, `conflictStatus` declared and not returned | `key-reused-different-payload` |
| different request fingerprint, no `conflictStatus`, either response fingerprint missing | `outcome-evidence-missing` |
| different request fingerprint, no `conflictStatus`, identical outcome | `key-reused-different-payload` |
| different request fingerprint, no `conflictStatus`, different outcome | `key-reuse-outcome-undetermined` |
| same request fingerprint, either response fingerprint missing | `outcome-evidence-missing` |
| same request fingerprint, different outcome | `duplicate-outcome-conflict` |
| same request fingerprint, same outcome | counted under `summary.replays` |

The expiry boundary is exclusive: a repeat exactly `expiresAfterSeconds` after
the anchor is still inside the window.

## Rule catalog

Severity is taken from one frozen `ruleId -> severity` table in
`src/index.mjs`; an unknown rule id throws. This catalog is asserted against
that table in both directions, and every rule whose severity alone decides the
verdict is additionally pinned by running the real binary and asserting the
process exit code.

| ruleId | severity | What it reports |
| --- | --- | --- |
| `capture-invalid` | error | the capture is not an object, or its shape is wrong |
| `capture-key-unknown` | error | the capture or a record declares a key the schema does not define |
| `capture-operation-unknown` | error | a record names an operation the contract does not declare |
| `contract-invalid` | error | the contract is not an object, or its shape is wrong |
| `contract-key-unknown` | error | the contract, an operation or an idempotency block declares an unknown key |
| `duplicate-never-observed` | info | the operation declares a boundary that this capture never exercised |
| `duplicate-outcome-conflict` | error | one key and one body reached two different outcomes |
| `identifier-invalid` | error | an id, key or principal is not a printable identifier of 1–200 characters |
| `input-not-json` | error | an input decoded but is not JSON |
| `input-not-utf8` | error | an input is not valid UTF-8 and was not parsed |
| `input-too-large` | error | an input is above `maxFileBytes` and was not read |
| `input-unreadable` | error | an input could not be inspected, resolved or read |
| `key-absent` | error | a guarded operation was reached with no idempotency key |
| `key-conflict-detected` | info | a reuse with a different body was refused with the declared conflict status |
| `key-expired-between-attempts` | warning | a reuse arrived past the declared expiry, so the operation ran again |
| `key-expiry-below-retry-window` | error | keys expire before the declared retry window ends |
| `key-expiry-undeclared` | error | the operation does not say when its keys expire |
| `key-reuse-outcome-undetermined` | error | a reuse with a different body whose handling the capture cannot settle |
| `key-reused-across-principals` | info | one key value was seen under several principals, which the declared scope keeps apart |
| `key-reused-different-payload` | error | a key was reused with a different body and the second caller was not refused |
| `key-scope-undeclared` | error | the operation does not declare a key scope, so its records were not evaluated |
| `key-source-undeclared` | error | the operation does not say where its key is carried |
| `no-operations` | error | the contract declares no operations |
| `no-records-evaluated` | error | the run evaluated no record at all, so it has no evidence to be green on |
| `operation-duplicate` | error | an operation id is declared more than once |
| `operation-guard-method-implied` | warning | `PUT` or `DELETE` with no declared boundary |
| `operation-guard-missing` | error | `POST` or `PATCH` with no declared boundary |
| `operation-guard-on-safe-method` | info | a safe method declares a boundary it should not need |
| `operation-invalid` | error | an operation entry has a field the schema refuses |
| `operation-not-captured` | warning | the capture holds no record for this operation |
| `outcome-evidence-missing` | error | a compared record has no `responseFingerprint` |
| `path-escapes-root` | error | an input resolved outside `--root` and was refused unread |
| `payload-binding-disabled` | error | the operation declares `payloadBinding: "none"` |
| `payload-binding-undeclared` | error | the operation does not say whether the key is bound to the payload |
| `payload-evidence-missing` | error | a compared record has no `requestFingerprint` |
| `record-duplicate` | error | a record id is used more than once |
| `record-invalid` | error | a record entry has a field the schema refuses |
| `record-principal-missing` | error | a per-principal key was recorded with no principal |
| `timestamp-invalid` | error | `observedAt` is not an ISO-8601 UTC instant that exists |
| `too-many-findings` | error | the report is above `maxFindings` and is partial |
| `too-many-operations` | error | the contract is above `maxOperations` and none were compiled |
| `too-many-records` | error | the capture is above `maxRecords` and none were compiled |
| `too-many-records-for-key` | error | one key entry is above `maxRecordsPerKey` and the walk stopped |

## Report, ordering and exit codes

The report follows the Edilec report contract: `schemaVersion`, `tool`,
`status`, `summary`, `findings`. `summary` carries `checked`, `errors`,
`warnings` and these tool-specific integers:

| Field | Meaning |
| --- | --- |
| `operations` | operations compiled from the contract |
| `guarded` | of those, the ones declaring an idempotency block |
| `records` | records the capture declared |
| `unevaluated` | records that were not evaluated, for any reason |
| `keys` | distinct key entries formed |
| `replays` | repeats of one key and body that returned the same outcome |
| `conflicts` | captured comparisons that contradicted the declared boundary |
| `conflictsRefused` | reuses the service refused with the declared conflict status |

Findings are ordered by `location.file`, then `location.pointer`, then
`ruleId`, then `message`, then `evidence` — every comparison by UTF-16 code
unit. No locale-aware comparison, wall clock, random source or filesystem
enumeration order affects the output, so two runs over the same bytes produce
byte-identical stdout.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | audited, nothing contradicted the contract | the report |
| `1` | audited, at least one error-severity rule fired | the report |
| `2` | invalid configuration, bad usage, or a repeated flag | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

The two shapes of exit 2 are deliberate. A configuration error means the run
never had a subject, so there is nothing to report about. Evidence that could
not be obtained means the run had a subject and failed to learn something about
it, which is what `incomplete` exists to say — and the consumer needs the report
to know *which* input was not read.

## Limits

Every limit is enforced, reported by name when it is hit, and makes the run
`incomplete`. None of them truncates silently.

| Limit | Default | Hard cap | Flag |
| --- | ---: | ---: | --- |
| `maxFileBytes` | 5242880 | 67108864 | `--max-file-bytes` |
| `maxOperations` | 500 | 5000 | `--max-operations` |
| `maxRecords` | 20000 | 500000 | `--max-records` |
| `maxRecordsPerKey` | 500 | 50000 | `--max-records-per-key` |
| `maxFindings` | 1000 | 20000 | `--max-findings` |

A limit may be lowered but never raised past its hard cap, and an unknown limit
name is a configuration error rather than a key that is quietly ignored.

Both inputs are resolved to their real paths and compared against the real path
of `--root`, so a symbolic link planted inside the root cannot be followed out
of the tree and a root that is itself reached through a link is not falsely
refused. A name carrying `..` or an absolute path is refused earlier still, as
a usage error.
