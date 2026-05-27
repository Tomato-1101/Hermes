# Contributing to Hermes

Hermes is in early pre-alpha (Phase 0). Outside contributions aren't being
actively solicited yet — the design is still settling and the codebase is
churning fast. That said, **issues and discussion are welcome**.

## What's useful right now

- **Issue reports** about Phase 0 build problems on your machine (macOS
  version, Node version, pnpm version, Xcode tools version, full error log).
- **Design feedback** on the [plan](docs/PLAN.md), the IR schema in
  `packages/ir/src/schema.ts`, and the Step Library in
  `packages/ai/src/step-library.ts`.
- **Reproduction cases** for any tool that fails to work after a clean
  `pnpm install && pnpm sidecar:mac:build && pnpm dev`.

## What's not useful right now

- New features beyond the Phase 0 acceptance criteria.
- UI redesigns.
- Style / lint reformat PRs.
- Translations (Japanese is the only target locale until Phase 1 ships).

## Ground rules

1. **Open an issue first** for anything beyond a one-line typo fix.
2. The license is still **TBD**; by submitting a PR you agree that your
   contribution may be re-licensed under whatever permissive license the
   project eventually adopts. See [`LICENSE`](LICENSE).
3. Run `pnpm lint && pnpm typecheck && pnpm test` before submitting.
4. Commits should be in imperative present tense ("add X", not "added X").
5. Be excellent to each other — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Development workflow

```bash
git clone https://github.com/<your-fork>/hermes.git
cd hermes
pnpm install
pnpm sidecar:mac:build
pnpm dev                 # Electron app with HMR
pnpm test                # vitest across all workspaces
```

The plan (`docs/PLAN.md`) is the source of truth for what should and should
not be in scope. If you think the plan is wrong, open a discussion issue
rather than a PR — alignment first, code second.
