# Hermes

3-in-1 RPA application — deterministic recorder/editor/runtime, with optional AI assertion and generation layers stacked on top.

> **Status: pre-alpha (Phase 0).** Not usable yet. The repository is public so the design and source are available from day one. Distribution is **source-only**: build it yourself, no signed binaries are provided.

## Design at a glance

Hermes runs UI automation in three modes, layered on a single deterministic foundation:

| Mode | What runs | AI's role |
|---|---|---|
| 1. RPA | Recorded actions, deterministic | none |
| 2. RPA + AI judgment | Deterministic actions, AI assertions | yes/no/extract only — never operates |
| 3. AI generation | Same deterministic engine, IR produced by AI | composes a fixed Step Library; cannot write code |

The cardinal rule: **AI never operates**. Operations are always executed by the deterministic engine, so a flow can be replayed bit-for-bit.

For the full plan, see [`docs/PLAN.md`](docs/PLAN.md).

## Project layout

```
apps/hermes              Electron app (Main + Preload + Renderer)
packages/ir              Flow IR: types, JSON Schema, expression language
packages/engine          Step executor
packages/desktop-adapter OS abstraction (mac impl arrives in Phase 1)
packages/web-provider    Playwright provider (Phase 1)
packages/recorder-web    Web recorder (Phase 1)
packages/ai              OpenRouter client, Step Library, AllowList
packages/storage         SQLite metadata + flow filesystem + keytar Vault
packages/ui-kit          Shared UI components
sidecars/macos-native    Swift sidecar (AX / CGEvent / ScreenCaptureKit)
```

## Build from source (macOS 13 Ventura+)

### Prerequisites

- macOS 13 or newer (ScreenCaptureKit and per-process privacy APIs).
- [Node.js 20+](https://nodejs.org/) (`.nvmrc` pins the minor version).
- [pnpm 11+](https://pnpm.io/installation): `npm install -g pnpm`.
- Xcode Command Line Tools: `xcode-select --install` (for the Swift sidecar).

### Steps

```bash
git clone https://github.com/<your-user>/hermes.git
cd hermes
pnpm install
pnpm sidecar:mac:build      # builds sidecars/macos-native (Swift)
pnpm dev                    # launches the Electron app in dev mode
```

To produce a local `.app` (no signing, no notarization):

```bash
pnpm build:mac
open apps/hermes/dist/mac-arm64/Hermes.app
```

> **Why no DMG / no signing?** Hermes is distributed as source. Each user builds locally; we don't ship binaries. This keeps the project free of Apple Developer Program requirements and avoids the maintenance burden of notarization.

### macOS privacy permissions

The app needs three permissions to record and replay UI events:

| Permission | Why |
|---|---|
| Accessibility | Read and click on UI elements via AXUIElement |
| Screen Recording | Capture screenshots / pixel matching via ScreenCaptureKit |
| Input Monitoring | Record global key + mouse events for the recorder |

On first launch, Hermes shows the permission status and provides "Open Settings" deep-links to System Settings → Privacy & Security.

## Development scripts

```bash
pnpm dev                  # run the app (electron-vite + HMR)
pnpm build:mac            # build .app for local use
pnpm sidecar:mac:build    # rebuild the Swift sidecar
pnpm lint                 # eslint over all workspaces
pnpm typecheck            # tsc --noEmit over all workspaces
pnpm test                 # vitest, all workspaces
```

## Contributing

This is currently a single-developer project — contributions aren't being solicited yet. Issues and discussion are welcome; please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening one.

## License

Hermes is **license-undecided** during pre-alpha. The repository is published to make the source available; **redistribution and derivative works are not yet permitted**. A permissive license will be added once the project stabilises. See [`LICENSE`](LICENSE) for the current statement.

## Acknowledgements

The plan and design borrows shape from UiPath, Power Automate Desktop, Browserflow, and Robocorp; the implementation borrows tooling from Electron, Playwright, electron-vite, and OpenRouter.
