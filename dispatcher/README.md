# Tickets to Main

Public Dispatcher surface for install, connect, status, and the native adapter harness.

This tree is Apache-2.0. It loads the included public coordination protocol, its manifest, and fabricated fixtures. This is pre-release source, not a signed or qualified release. Coordination commands are not served, so no coordination command is sent.

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

It does not sign an installer, register startup, open a live Tickets Please connection, admit work, start a coding session, or claim a supported Windows or macOS release. The workspace claim is a local writer record, not a separate user or container. A test keychain is unqualified and is used only when the test switch is set. The stub adapter is not offered.

## Check

```sh
node node_modules/typescript/bin/tsc --noEmit -p dispatcher
node --test --experimental-strip-types dispatcher/test/*.test.ts
```
