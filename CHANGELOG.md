# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- an operation contract — id, method, path and an optional idempotency block
  declaring `keySource`, `scope`, `expiresAfterSeconds`, `retryWindowSeconds`,
  `payloadBinding` and `conflictStatus` — compiled from data, with every
  unknown key refused at every level rather than ignored, and an entry that
  did not compile counted as unaudited rather than passed over;
- contract rules that report what a declaration does not say: no boundary at
  all on `POST`/`PATCH` (error) and on `PUT`/`DELETE` (warning, since HTTP's
  idempotency is a statement about intent and not a guarantee about an
  implementation), no declared key source, no declared scope, no declared
  expiry, an expiry shorter than the declared retry window, and a payload
  binding that is either undeclared or explicitly `none`;
- a capture of outcomes that were already observed locally, carrying request
  and response **fingerprints** rather than bodies, with the fingerprint field
  restricted to a digest alphabet of 8-200 characters so a body or a sentence
  of free text cannot arrive in the report under that name -- a shape check and
  not a secret filter, which is what the documents now say;
- key entries formed from the declared scope — `(operation, key)` globally,
  `(operation, principal, key)` per principal — walked in observation order
  with the record id as the tie-break, and anchored on the first call, which
  moves only when the declared expiry has passed and never because a later
  caller disagreed with it;
- outcome rules over those entries: `duplicate-outcome-conflict` where one key
  and one body reached two different outcomes, `key-reused-different-payload`
  where a key was reused with a different body and the second caller was not
  refused, `key-conflict-detected` where the declared conflict status shows the
  binding held, `key-expired-between-attempts` where a reuse arrived past the
  declared expiry, `key-absent` where a guarded operation was reached with no
  key, and `key-reused-across-principals` where the declared scope is what keeps
  two callers apart;
- explicit unknowns, each an error that marks the run `incomplete` rather than
  a verdict in either direction: `key-reuse-outcome-undetermined` where a reuse
  with a different body cannot be told apart from a second execution because no
  conflict status is declared, `payload-evidence-missing` and
  `outcome-evidence-missing` where a comparison needed a fingerprint the
  capture does not have, `record-principal-missing`, `capture-operation-unknown`
  and the undeclared-scope skip;
- `duplicate-never-observed` and `operation-not-captured`, so a green run
  cannot be read as evidence about a boundary the capture never exercised;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })` on both
  inputs, the contract included — the configuration path is exactly where a
  sibling tool hardened its data path and forgot — and ISO-8601 UTC instants
  validated against the calendar arithmetically, so `2026-02-31T00:00:00Z` and
  `24:00:00` are refused rather than rolled silently forward;
- real-path confinement on both sides for both inputs, so a symbolic link
  planted inside the root is refused unread and a root reached through a link
  is not falsely refused; a name carrying `..` or an absolute path is refused
  earlier still, as a usage error with an empty stdout;
- explicit file-byte, operation, record, per-key-entry and finding limits, each
  reported by name when hit and each making the run `incomplete` instead of
  truncating. The per-key cut-off names the first record the walk did not
  reach, and the records beyond it are counted as unevaluated;
- sanitisation of every untrusted string that reaches output — identifiers,
  keys, principals, paths, pointers, messages and suggestions as well as
  `evidence`, and an unknown CLI option on its way to stderr — covering C0 and
  DEL, the whole C1 range (U+0085 NEL forges a line of its own, U+009B is the
  8-bit CSI), U+2028 and U+2029, and the bidi and isolate controls U+200E,
  U+200F, U+202A–U+202E and U+2066–U+2069, which are also refused inside an
  identifier. Ordinary right-to-left letters are untouched: they carry their
  own direction and need no override;
- a CLI with `--help`, `--version`, `--json` and the five limit flags, the
  report on stdout, diagnostics on stderr, exit codes 0 / 1 / 2 with an empty
  stdout for a configuration error and an `incomplete` report for evidence that
  could not be obtained, and a repeated value-carrying flag refused instead of
  silently overwriting the earlier value;
- runnable `examples/clean`, `examples/broken` and `examples/incomplete` roots
  that exit 0, 1 and 2; the clean one demonstrates a consistent replay, a
  cross-principal reuse the declared scope keeps apart, and a reuse the
  declared conflict status refused;
- the rule catalog, both schemas, the walk order, the ordering rule, the limits,
  the exit codes and the list of things this tool cannot conclude in
  `docs/idempotency-rules.md`.

### Fixed

- a value this tool refuses is no longer reproduced. Every validation failure
  echoed the rejected value back into the finding's evidence, so a card number,
  a JWT or an access key id planted in a `requestFingerprint`, an `observedAt`
  or a `responseStatus` reached stdout verbatim -- on the very fields whose
  validation exists to keep such content out of the report. A refusal now names
  the shape of the value and leaves its content in the file it arrived in; the
  pointer already says exactly where that is.

### Guaranteed

- Nothing in this package opens a socket, reads a clock, reads a random source
  or reads the environment. There is no probe mode and no replay: the capture
  is the only source of outcome evidence there is.
- The tool is read-only. Nothing under `src/` or `bin/` writes, appends,
  renames or removes a file, and a run leaves its root byte-identical.
- `pass` is never reported on evidence that was not obtained, and `pass` with
  `checked: 0` is not reachable. Every site that marks a run `incomplete` has a
  test that asserts the status and the process exit code, so removing one turns
  exit 2 into exit 1 and fails.
- Every finding takes its severity from one frozen `ruleId -> severity` table;
  an unknown rule id throws, and the table is asserted against the documented
  catalog in both directions. Those are declarations, and a coordinated edit
  agrees with itself, so every rule whose severity can decide a verdict is also
  pinned by behaviour: a real input through the real binary, asserting the rules
  raised, the status and the exit code. Where a rule marks the run incomplete as
  well, the error count and the printed severity word are asserted literally.
- No wall clock, locale-aware comparison, random source, network access or
  filesystem enumeration order affects the output. Every order the report
  exposes is pinned by asserting the emitted order for inputs that sort
  differently under collation than by code unit — including which record owns a
  key entry and which records a per-key cut-off reaches — so substituting a
  collator under any spelling fails a test rather than silently making the
  output depend on the host's ICU data.
- A capture cannot show that an operation is idempotent, and this tool does not
  claim otherwise. `README.md` and `docs/idempotency-rules.md` both state what a
  `pass` does and does not mean.

No release has been published.
