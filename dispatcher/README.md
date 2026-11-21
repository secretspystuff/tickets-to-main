# Tickets to Main

Public Dispatcher surface for install, connect, status, and the native adapter harness.

This tree is Apache-2.0. It loads the included public coordination protocol, its manifest, and fabricated fixtures. This is pre-release source, not a signed or qualified release. The CLI uses the offline fixtures. The separate [coordination client](src/coordination-client.ts) supports the served hello and repository activation reads for an existing approved device connection.

## What this build does

- `tickets-to-main install` records a local install. Linux is an early probe. Windows and macOS installers are unqualified. Startup is unregistered.
- `tickets-to-main connect start` checks the coordination hello fixture. It reports version 1, that the runtime is not served, and that no command is served. It sends nothing. A device-login fixture still needs the test switch.
- `tickets-to-main coordination show` checks the manifest and every fabricated fixture, then lists each command as not served. It does not print fixture bodies.
- `tickets-to-main coordination send` refuses every command. Connection and settings reads, admission, and reservations use the protocol's unserved answers and return no body. Nothing is sent and the local record is not changed.
- `tickets-to-main connect poll` finishes a fabricated fixture connection when the test switch is on. The key goes to a keychain port, never the local record.
- `tickets-to-main status` and `health` keep installed, signed in, compatible, and ready for an assignment as separate facts. A later process reads the key back from the keychain port. A memory-only keychain does not survive that process.
- `tickets-to-main workspace prepare` makes a private directory outside the state directory. `workspace claim` records one writer. A second live writer is refused. This boundary is unqualified.
- Codex `cli` and Codex `app-server` are separate interfaces. Evidence for one does not qualify the other. Neither is runtime-qualified.

## What this build does not do

The CLI does not sign an installer, register startup, open a live Tickets Please connection, admit work, start a coding session, or claim a supported Windows or macOS release. The workspace claim is a local writer record, not a separate user or container. A test keychain is unqualified and is used only when the test switch is set. The stub adapter is not offered.

## Recovering a board change feed

When `GET /api/changes?board=<board>&since=<cursor>` returns 410, recover the board's current Open graph before resuming the feed. Send `POST /api/ttm/recovery?board=<board>` with the enrolled device's bearer in the Authorization header and a UTF-8 JSON body. Use one explicit board and the current selections from `repo.activation.read`. Each entry contains the board repo ID, its explicit identity and canonical locator (or null), and its active generation. The selection must be nonempty, with unique repo and identity IDs. The body limit is 65,536 bytes.

A successful response repeats the selection and returns the selected Open tickets, their scoped relationships, the graph revision and the matching changes cursor in `next`. An empty ticket list is a valid snapshot. A link outside the selection can be represented by a link ID and `unavailable: true`. Reconcile the snapshot with locally retained work, then continue the same board's changes feed from `next`. A subsequent 410 requires a fresh recovery. See the fabricated [request](../src/lib/ttm-protocol/feed-recovery/request.json) and [response](../src/lib/ttm-protocol/feed-recovery/response.json).

Keep the saved cursor after a refused or incomplete recovery. Correct an invalid request before retrying a 400. Stop after a 403 and check the device's board access and selected activation generations. On a 429, wait for `Retry-After`. A 503 with `recovery_unavailable` allows a retry.

Recovery requires current device approval, board access and active repo generations. Browser sessions and ordinary agent or MCP credentials cannot perform this read. A successful capture grants no execution authority. This section describes the HTTP contract for Dispatcher implementations.

The local cursor API accepts the serialized v1 request when restoring a recovery-enabled replay. Supply the current selection again on restart. Keep each issued read action with its callback and pass that action as `capture` on success or failure. For a snapshot, pass the serialized response as `response`. The ledger saves the scoped graph and its cursor together before emitting the next changes read. A pending recovery survives restart. The local API performs no network I/O.

## Check

```sh
node node_modules/typescript/bin/tsc --noEmit -p dispatcher
node --test --experimental-strip-types dispatcher/test/*.test.ts
```
