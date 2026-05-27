# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project does
not yet follow SemVer (we're at 0.x and may break anything).

## [Unreleased]

### Added — Phase 0 (foundation)

- pnpm workspace scaffolding (`apps/`, `packages/`, `sidecars/`).
- `packages/ir`: Flow / Step / TargetRef / Selector types, JSON Schema
  validation, ULID IDs, and a jsep-based whitelisted expression language.
- `packages/engine`: Step executor with if/loop/try/parallel and event emitter.
- `packages/desktop-adapter`: OS abstraction interface (mac/win impls TBD).
- `packages/ai`: OpenRouter client skeleton, Step Library JSON Schema
  definitions, AllowList scaffolding for future-safe extension.
- `packages/storage`: SQLite metadata, flow filesystem store, keytar Vault.
- `apps/hermes`: Electron + Vite + React 19 scaffold with a typed IPC
  contract and a permissions / setup status pane.
- `sidecars/macos-native`: Swift JSON-RPC sidecar over Unix Domain Socket
  with a `ping` method (Phase 1 will add AX / CGEvent / SCK methods).
- Public OSS scaffolding: README with build instructions, CONTRIBUTING,
  CODE_OF_CONDUCT, ISSUE / PR templates, and a TBD-license notice.
