/**
 * Resolve a TargetRef (selector candidate array) to a Playwright Locator.
 *
 * Iterates candidates in order; the first one that resolves to exactly one
 * element wins. This is the runtime side of the "multi-strategy selector"
 * design — recording is responsible for emitting N candidates per target,
 * playback is responsible for picking whichever still matches.
 */
import type { Locator, Page } from 'playwright-core';
import type { Selector, TargetRef } from '@hermes/ir';

export interface WebSelectorMatch {
  locator: Locator;
  candidateIndex: number;
}

export async function resolveSelector(
  page: Page,
  target: TargetRef,
  opts?: { timeoutMs?: number },
): Promise<WebSelectorMatch | null> {
  if (target.layer !== 'web') {
    throw new Error(`resolveSelector only handles layer='web', got '${target.layer}'`);
  }

  const order = orderedCandidateIndexes(target);
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  // Try each candidate; if none match, wait briefly and try again until deadline.
  while (true) {
    for (const idx of order) {
      const sel = target.candidates[idx]!;
      const loc = candidateToLocator(page, sel);
      if (!loc) continue;
      const count = await safeCount(loc);
      if (count === 1) return { locator: loc, candidateIndex: idx };
    }
    if (Date.now() >= deadline) return null;
    // Backoff with a cap so a slow page can still resolve in time.
    const delay = Math.min(100 + 100 * attempt++, 500);
    await new Promise<void>((res) => setTimeout(res, delay));
  }
}

function orderedCandidateIndexes(target: TargetRef): number[] {
  // Try the previously-successful candidate first if available, then the
  // original recording order. This gives playback a small "learning" effect
  // when sites shuffle their DOM between identical sessions.
  const idxs = target.candidates.map((_, i) => i);
  if (typeof target.preferIndex === 'number') {
    const p = target.preferIndex;
    return [p, ...idxs.filter((i) => i !== p)];
  }
  return idxs;
}

function candidateToLocator(page: Page, sel: Selector): Locator | null {
  switch (sel.kind) {
    case 'role':
      // Playwright's getByRole accepts an ARIA role string. We pass it as `any`
      // because the IR keeps `role` as a free string (extensible to AX roles).
      return page.getByRole(sel.role as Parameters<Page['getByRole']>[0], {
        ...(sel.name !== undefined ? { name: sel.name } : {}),
        ...(sel.exact !== undefined ? { exact: sel.exact } : {}),
      });
    case 'testid':
      return page.getByTestId(sel.value);
    case 'label':
      return page.getByLabel(sel.text);
    case 'text':
      return page.getByText(sel.value);
    case 'css':
      return page.locator(sel.value);
    case 'xpath':
      return page.locator(`xpath=${sel.value}`);
    case 'url-anchor':
      // url-anchor matches the page itself; not for element resolution.
      return null;
    default:
      // Desktop/Screen selectors don't apply to web pages.
      return null;
  }
}

async function safeCount(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return -1;
  }
}

/** Human-readable label for an individual selector candidate (UI hint). */
export function candidateLabel(sel: Selector): string {
  switch (sel.kind) {
    case 'role':
      return `role: ${sel.role}${sel.name ? `[name="${sel.name}"]` : ''}`;
    case 'testid':
      return `testid: ${sel.value}`;
    case 'label':
      return `label: ${sel.text}`;
    case 'text':
      return `text: ${sel.value.slice(0, 40)}`;
    case 'css':
      return `css: ${sel.value}`;
    case 'xpath':
      return `xpath: ${sel.value}`;
    case 'url-anchor':
      return `url: ${sel.pattern}`;
    case 'ax':
      return `ax: ${sel.app}/${sel.role}`;
    case 'uia':
      return `uia: ${sel.processName}/${sel.controlType}`;
    case 'image':
      return `image: ${sel.assetRef}`;
    case 'ocr':
      return `ocr: ${sel.text}`;
    case 'coords':
      return `coords: (${sel.x}, ${sel.y})`;
  }
}
