/**
 * Browser-side recorder script.
 *
 * Runs inside the page via `BrowserContext.addInitScript()`. Listens for
 * pointer + keyboard events, builds an ElementSnapshot for the deepest
 * interactive ancestor of the event target, and ships it back to the
 * orchestrator via the exposeBinding('__hermes_record', ...) channel.
 *
 * Kept as a string literal because it must execute as a self-contained
 * script in the page context — TypeScript can't compile it, but it stays
 * here next to its consumer so any change is reviewed in one place.
 */
export const INJECT_SCRIPT = String.raw`
(() => {
  if (window.__hermes_recorder_installed__) return;
  window.__hermes_recorder_installed__ = true;

  function trim(s, max) {
    if (s == null) return null;
    s = String(s).replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
  }

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'LABEL') return true;
    if (el.getAttribute && el.getAttribute('role')) return true;
    if (el.hasAttribute && el.hasAttribute('onclick')) return true;
    if (el.getAttribute && /^(button|link|menuitem|tab|option|checkbox|radio)$/.test(el.getAttribute('role') || '')) return true;
    return false;
  }

  function ascendInteractive(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 8) {
      if (isInteractive(cur)) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return el;
  }

  function getAccessibleName(el) {
    if (!el) return null;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return trim(aria, 100);
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const node = document.getElementById(labelledBy);
      if (node) return trim(node.textContent, 100);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return trim(lab.textContent, 100);
      }
      const wrapping = el.closest && el.closest('label');
      if (wrapping) return trim(wrapping.textContent, 100);
    }
    return trim(el.textContent, 100);
  }

  function inferRole(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const map = {
      A: 'link', BUTTON: 'button',
      INPUT: el.type === 'button' || el.type === 'submit' ? 'button'
            : el.type === 'checkbox' ? 'checkbox'
            : el.type === 'radio' ? 'radio'
            : 'textbox',
      TEXTAREA: 'textbox', SELECT: 'combobox',
    };
    return map[el.tagName] || null;
  }

  function buildCssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 12) {
      let seg = node.tagName.toLowerCase();
      if (node.id) {
        seg += '#' + CSS.escape(node.id);
        parts.unshift(seg);
        break;
      }
      if (node.classList && node.classList.length > 0) {
        const cls = Array.from(node.classList).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
        seg += cls;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          seg += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(seg);
      node = parent;
      depth++;
    }
    return parts.length > 0 ? parts.join(' > ') : null;
  }

  function buildXPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 12) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
      node = parent;
      depth++;
    }
    return '/html/body/' + parts.join('/');
  }

  function snapshot(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return {
      tag: el.tagName.toLowerCase(),
      role: inferRole(el),
      ariaName: getAccessibleName(el),
      testid: el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || null),
      id: el.id || null,
      name: el.getAttribute && el.getAttribute('name'),
      type: el.type || null,
      classList: el.classList ? Array.from(el.classList).slice(0, 4) : [],
      text: trim(el.innerText || el.textContent, 80),
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
      placeholder: el.getAttribute && el.getAttribute('placeholder'),
      label: getAccessibleName(el),
      cssPath: buildCssPath(el),
      xpath: buildXPath(el),
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    };
  }

  function send(payload) {
    try { window.__hermes_record(payload); } catch (e) { /* binding not yet ready */ }
  }

  document.addEventListener('click', (e) => {
    const target = ascendInteractive(e.target);
    send({
      kind: 'click',
      url: location.href,
      button: e.button === 2 ? 'right' : (e.button === 1 ? 'middle' : 'left'),
      element: snapshot(target),
      ts: Date.now(),
    });
  }, { capture: true, passive: true });

  // 'change' captures the final value for form inputs; that's the unit
  // the engine replays via 'type' step (we don't replay keystroke-by-key).
  // For secret inputs we still send the value so the orchestrator can
  // hand it to the Vault — but we flag it so it's never persisted in the
  // IR or shown in the recorder log.
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && t.tagName !== 'SELECT')) return;
    const isSecret = t.type === 'password';
    send({
      kind: 'input',
      url: location.href,
      element: snapshot(t),
      value: String(t.value ?? ''),
      isSecret,
      ts: Date.now(),
    });
  }, { capture: true, passive: true });

  // Standalone modifier-key shortcuts (e.g. Cmd+S). We snapshot the focused
  // element so the IR step can scope the keystroke to it.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey || e.altKey)) return;
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return;
    send({
      kind: 'key',
      url: location.href,
      element: snapshot(document.activeElement),
      keys: [e.metaKey ? 'meta' : (e.ctrlKey ? 'ctrl' : 'alt'), e.shiftKey ? 'shift' : null, e.key.toLowerCase()].filter(Boolean),
      ts: Date.now(),
    });
  }, { capture: true });
})();
`;
