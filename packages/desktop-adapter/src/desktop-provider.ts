/**
 * DesktopProvider — engine-facing wrapper around a DesktopAdapter.
 *
 * The engine identifies providers structurally via the `kind` field on
 * the opaque handles. This thin wrapper exposes the DesktopAdapter under
 * `kind: 'desktop'` so it can sit in ProviderBag.desktop alongside the
 * WebProvider.
 */
import type { DesktopProviderHandle } from '@hermes/engine';
import type { DesktopAdapter } from './index.js';

export class DesktopProvider implements DesktopProviderHandle {
  readonly kind = 'desktop' as const;
  constructor(readonly adapter: DesktopAdapter) {}
}
