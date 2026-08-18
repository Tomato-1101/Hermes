# Reference materials (inputs)

Drop reference documents from **other RPA products** here — user manuals,
feature lists, screenshots, exported help pages — so they can be used as the
source for adding features to Hermes.

These are third-party materials that feed the analysis in
[`../research/`](../research/), which is where the distilled, original notes
and feature proposals live.

## Git policy — local-only

This repository is **public**. The raw materials placed here are third-party,
likely **copyrighted** content, so everything in this folder is **gitignored**
except this `README.md`.

- Do **not** commit manuals, PDFs, screenshots, or scraped help pages.
- Keep them on your machine only; Claude reads them locally.
- See the `docs/references/*` rule in the repo `.gitignore`.

## Layout — one folder per product

```
docs/references/
  README.md            (committed — this file)
  <product-name>/      (local-only — e.g. uipath/, power-automate/, automation-anywhere/)
    *.pdf  *.png  *.md  *.txt  *.html  ...
```

- Use a lowercase, kebab-case folder name per product (`uipath`, `winactor`, `power-automate`).
- Any format is fine: PDF, images, exported HTML, or pasted Markdown/plain text.
- If a product folder needs context (version, source URL, date captured), add a
  short `NOTES.md` inside it.

## Workflow

1. You drop files under `docs/references/<product-name>/`.
2. Claude reads them locally and extracts features, concepts, and UX patterns.
3. Claude writes original analysis (comparison tables, proposals mapped to the
   Hermes IR / Step Library) into [`../research/`](../research/).
4. Those proposals drive the actual feature work in Hermes.

> Raw third-party material stays here (local-only). Original synthesis goes to
> `docs/research/` (committed).
