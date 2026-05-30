# Feature research (outputs)

Original, distilled analysis derived from the third-party reference materials in
[`../references/`](../references/).

Everything here is **our own writing** — competitive feature breakdowns,
comparison tables, and concrete proposals mapped to the Hermes IR and Step
Library. Because it is original synthesis (not copied third-party content), it
is **committed** to the repository.

## What goes here

- **Feature extractions** — for a given competitor, the notable capabilities and
  how they work, in our own words.
- **Comparison tables** — capability X across products vs. Hermes today.
- **Proposals** — a feature idea translated into Hermes terms: which package it
  touches (`packages/ir`, `packages/engine`, `packages/desktop-adapter`, …),
  what IR steps it implies, and how it fits the "AI never operates" rule.

## Conventions

- One file per product or per theme, kebab-case:
  `uipath-overview.md`, `selector-strategies.md`, `error-handling-comparison.md`.
- Reference the source material by relative path (e.g.
  `../references/uipath/activities-guide.pdf`, p. 42) rather than pasting large
  excerpts — the raw file stays local-only, the citation is enough.
- Do **not** paste long verbatim quotes or copyrighted screenshots into these
  committed files. Summarize and cite.

## Source

Raw inputs live in [`../references/`](../references/) (local-only, gitignored).
