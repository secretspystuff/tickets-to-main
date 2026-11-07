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

## Layout

- `dispatcher/`: runtime, command entry point, harness tests, and fabricated device/native fixtures.
- `src/lib/ttm-protocol.ts` and `src/lib/ttm-protocol/`: public protocol, manifest, and fabricated coordination fixtures.

Both directories are required because the runtime imports the public protocol by relative path. Package version 0.1.0 identifies this pre-release source and matches the runtime version recorded locally; it does not identify a signed release. The root package defines a pre-release npm tarball with the runtime, public protocol, manifest, and fabricated fixtures together, plus the tickets-to-main command. It has no production npm dependencies. Tests and development tooling remain in the source tree. Package the root, rather than the nested dispatcher directory. The root package stays private to prevent registry publication before release review; this does not prevent creating a local tarball. A source tarball is not a qualified installer or signed release.

## License

Apache-2.0; see [LICENSE](LICENSE).
