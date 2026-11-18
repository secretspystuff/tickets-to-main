# Tickets to Main Dispatcher

Pre-release Apache-2.0 source for a Dispatcher that runs on your computer. This candidate is for development and fabricated-fixture testing. No coordination command is served. It is not a qualified native integration or an intended-tester release.

## Develop

Use Node.js 24.18.0 and npm from that Node.js distribution. From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
node dispatcher/bin/tickets-to-main.mjs --help
node dispatcher/bin/tickets-to-main.mjs coordination show
```

The runtime uses Node's native TypeScript support; the build command checks the complete source tree without emitting JavaScript. Tests use only the included public protocol and fabricated fixtures. The independent check requires no private application checkout, credentials, or server.

## Current behavior

Install records local state only. Startup is unregistered. Windows and macOS installers are unqualified; Linux remains an early probe. Device login is fabricated and requires an explicit test switch. A test keychain is unqualified. Coordination send refuses every command. Status and health distinguish installed, signed in, compatible, and ready. Workspace claims record local writer ownership and do not prove process containment.

Codex CLI and app-server have separate harness contracts and local session helpers. Neither interface has completed native qualification. Other requested coding-tool integrations, signed installation, startup registration, release verification, recovery qualification, and a served coordination path remain unfinished. This candidate provides no supported installation or signed release artifact.

The assignment boundary has a fabricated adapter for adverse-case tests. It binds requests to independently supplied current scope and a confirmed workspace, records flushed intents in `assignment-intents.jsonl`, and holds uncertain effects for read-only reconciliation. The journal contains identifiers and digests, not assignment text or credentials. Malformed, linked, truncated or full journals hold work without discarding history. The 32 KiB frame and 16 KiB input limits bound this harness; they are not batch or native-tool limits.

New intents distinguish preparation from a flushed start marker. A known failure before execution records `not-started`, consumes that request's identity and sequence, and releases the workspace for the next assignment. A preparation left by an inactive controller can also be closed this way when storage recovers, including while admitting a new scope. A live controller retains its preparation. Legacy intents and started work remain uncertain without terminal evidence; old history is preserved. Ordinary percent signs remain literal assignment text, while decoded views are scanned for secrets without changing the text sent to the adapter.

Assignment admission uses filesystem directory IDs for workspace identity, containment and the local activity guard, so alternate Windows spellings cannot create another writer. macOS permits only the exact system `/var` and `/tmp` aliases to their `/private` targets; other workspace links remain refused. New intent and state-lock records include a process birth identity when the OS can supply it. A definite birth mismatch releases a reused PID's ownership; failed observations and live legacy owners stay held. Linux uses boot ID and process start ticks; Windows uses the OS process creation time through a hidden, noninteractive, environment-limited query. macOS birth observation remains unavailable pending a precise native observer, so its live PIDs stay held conservatively. An unresolved legacy path hash can hold new admissions across scopes because its original Windows spelling cannot prove a separate workspace. Existing journal bytes are preserved.

This boundary is not wired to the command line, network, or native tools. Its adapter observations are fabricated, not server authorization or containment evidence, and its results are unqualified and unpublishable. Reconciliation never retries an uncertain effect, including after reply retention expires. Filesystem and process tests include Linux and Windows probes and fabricated macOS cases; Windows ACLs, macOS process observation, managed-record revocation/export/erasure, real native custody, and served T1 integration remain qualification work. The local journal does not replace server claims or prevent external tools from acting independently.

## Layout

- `dispatcher/`: runtime, command entry point, harness tests, and fabricated device/native fixtures.
- `src/lib/ttm-protocol.ts` and `src/lib/ttm-protocol/`: public protocol, manifest, and fabricated coordination fixtures.

Both directories are required because the runtime imports the public protocol by relative path. Package version 0.1.0 identifies this pre-release source and matches the runtime version recorded locally; it does not identify a signed release. The root package defines a pre-release npm tarball with the runtime, public protocol, manifest, and fabricated fixtures together, plus the tickets-to-main command. It has no production npm dependencies. Tests and development tooling remain in the source tree. Package the root, rather than the nested dispatcher directory. The root package stays private to prevent registry publication before release review; this does not prevent creating a local tarball. A source tarball is not a qualified installer or signed release.

## Repository boundary checks

Every push and pull request runs a tracked-path allowlist and a private-name check
from `.github/scripts/repo-guard.mjs`. The reviewed path prefixes and exact paths
live in `.github/allowed-paths.txt`; private-name regular expressions live in
`.github/private-patterns.txt`. These checks inspect committed blobs and paths,
including ignored files that are tracked, and reject symbolic links and submodules.
Blobs containing NUL bytes are rejected; no binary fixture paths are exempt.
All guards run inside the required `check` job. Regression tests also verify that
the guard commands remain enabled in that job and that its actions stay pinned.
The hostname rules reject subdomains of the public site and hosted deployment
domains. Additional private domains require explicit patterns in that list.

Run the tree checks after committing:

```sh
node .github/scripts/repo-guard.mjs paths
node .github/scripts/repo-guard.mjs private
```

CI also runs Gitleaks 8.30.1, with a pinned archive checksum, over complete reachable
history, including intermediate commits whose contents were later deleted. No
credentials or paid service are required. Findings are redacted; inline suppression
comments are disabled. `.github/secret-fixtures.ignore` records only exact historical
findings from fabricated PEM redaction tests, with a reason for each exception.
New occurrences remain subject to scanning. Run the same scan locally with:

```sh
gitleaks git --redact --no-banner --ignore-gitleaks-allow --gitleaks-ignore-path .github/secret-fixtures.ignore --log-opts=HEAD .
```

## License

Apache-2.0; see [LICENSE](LICENSE).
