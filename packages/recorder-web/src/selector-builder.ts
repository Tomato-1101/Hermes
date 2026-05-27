/**
 * Build a `Selector[]` candidate array for a recorded element.
 *
 * The input is a structured snapshot of the element produced by the
 * inject-script (which runs in the page context and has access to the
 * DOM). Each kind of selector is independent — if the site mutates,
 * playback iterates until one still resolves.
 */
import type { Selector } from '@hermes/ir';

export interface ElementSnapshot {
  tag: string;
  role?: string | null;
  ariaName?: string | null;
  testid?: string | null;
  id?: string | null;
  name?: string | null;
  type?: string | null;
  classList?: string[];
  text?: string | null;
  href?: string | null;
  placeholder?: string | null;
  label?: string | null; // associated <label> text
  cssPath?: string | null;
  xpath?: string | null;
  /** Bounding box at recording time, in page coords. */
  rect?: { x: number; y: number; w: number; h: number };
}

export function buildSelectorCandidates(snap: ElementSnapshot): Selector[] {
  const out: Selector[] = [];

  // 1. role + accessible name (highest preference)
  if (snap.role && snap.ariaName) {
    out.push({ kind: 'role', role: snap.role, name: snap.ariaName, exact: true });
  } else if (snap.role) {
    out.push({ kind: 'role', role: snap.role });
  }

  // 2. data-testid (very stable when present)
  if (snap.testid) {
    out.push({ kind: 'testid', value: snap.testid });
  }

  // 3. associated <label> text (for inputs)
  if (snap.label) {
    out.push({ kind: 'label', text: snap.label });
  }

  // 4. id
  if (snap.id) {
    out.push({ kind: 'css', value: `#${cssEscape(snap.id)}` });
  }

  // 5. text content (for buttons, links)
  if (snap.text && snap.text.length > 0 && snap.text.length <= 60) {
    out.push({ kind: 'text', value: snap.text });
  }

  // 6. css path
  if (snap.cssPath) {
    out.push({ kind: 'css', value: snap.cssPath });
  }

  // 7. xpath
  if (snap.xpath) {
    out.push({ kind: 'xpath', value: snap.xpath });
  }

  return dedupe(out);
}

function dedupe(list: Selector[]): Selector[] {
  const seen = new Set<string>();
  const out: Selector[] = [];
  for (const sel of list) {
    const key = JSON.stringify(sel);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sel);
  }
  return out;
}

function cssEscape(s: string): string {
  // Conservative escape: backslash anything that isn't a-zA-Z0-9_-
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
